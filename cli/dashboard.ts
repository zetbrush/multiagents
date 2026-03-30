// ============================================================================
// multiagents — TUI Dashboard (ANSI escape codes, no dependencies)
// ============================================================================
// Tab-based dashboard with:
//   [1] Agents — team status with task states
//   [2] Messages — auto-scrolling message log with filtering
//   [3] Guardrails — interactive limit adjustment
//   [4] Files — file locks and ownership
// ============================================================================

import { DEFAULT_BROKER_PORT, BROKER_HOSTNAME, SESSION_FILE, DASHBOARD_REFRESH } from "../shared/constants.ts";
import { BrokerClient, type PlanState, type PlanItem } from "../shared/broker-client.ts";
import { formatDuration, formatTime, truncate } from "../shared/utils.ts";
import type { Session, Slot, Peer, Message, FileLock, FileOwnership, GuardrailState, SessionFile } from "../shared/types.ts";
import * as path from "node:path";
import * as fs from "node:fs";

const BROKER_PORT = parseInt(process.env.MULTIAGENTS_PORT ?? String(DEFAULT_BROKER_PORT), 10);
const BROKER_URL = `http://${BROKER_HOSTNAME}:${BROKER_PORT}`;

// Read version from package.json at startup
let PKG_VERSION = "?";
try {
  const pkgPath = path.resolve(import.meta.dir, "../package.json");
  PKG_VERSION = JSON.parse(fs.readFileSync(pkgPath, "utf-8")).version ?? "?";
} catch { /* ok */ }

// --- ANSI helpers ---
const ESC = "\x1b";
const CLEAR = `${ESC}[2J`;
const HOME = `${ESC}[H`;
const BOLD = `${ESC}[1m`;
const RESET = `${ESC}[0m`;
const GREEN = `${ESC}[32m`;
const RED = `${ESC}[31m`;
const YELLOW = `${ESC}[33m`;
const CYAN = `${ESC}[36m`;
const BLUE = `${ESC}[34m`;
const MAGENTA = `${ESC}[35m`;
const WHITE = `${ESC}[37m`;
const DIM = `${ESC}[90m`;
const BG_BLUE = `${ESC}[44m`;
const BG_RESET = `${ESC}[49m`;
const UNDERLINE = `${ESC}[4m`;
const HIDE_CURSOR = `${ESC}[?25l`;
const SHOW_CURSOR = `${ESC}[?25h`;
const INVERSE = `${ESC}[7m`;

type ResolvedSlotStatus = Slot["status"] | "starting";

function colorStatus(status: string): string {
  switch (status) {
    case "connected": case "active": case "ok": return `${GREEN}${status}${RESET}`;
    case "starting": case "launching": return `${CYAN}${status}${RESET}`;
    case "disconnected": case "paused": case "warning": return `${YELLOW}${status}${RESET}`;
    case "archived": case "triggered": case "error": return `${RED}${status}${RESET}`;
    default: return status;
  }
}

function colorTaskState(state: string): string {
  switch (state) {
    case "idle": return `${DIM}idle${RESET}`;
    case "working": return `${CYAN}working${RESET}`;
    case "done_pending_review": return `${YELLOW}done→review${RESET}`;
    case "addressing_feedback": return `${MAGENTA}fixing${RESET}`;
    case "approved": return `${GREEN}approved${RESET}`;
    case "released": return `${DIM}released${RESET}`;
    default: return state;
  }
}

function colorMsgType(type: string): string {
  switch (type) {
    case "chat": return `${WHITE}chat${RESET}`;
    case "task_complete": return `${GREEN}done${RESET}`;
    case "review_request": return `${CYAN}review${RESET}`;
    case "feedback": return `${YELLOW}feedback${RESET}`;
    case "approval": return `${GREEN}approve${RESET}`;
    case "release": return `${MAGENTA}release${RESET}`;
    case "team_change": return `${BLUE}team${RESET}`;
    case "system": return `${DIM}system${RESET}`;
    case "broadcast": return `${CYAN}bcast${RESET}`;
    default: return `${DIM}${type}${RESET}`;
  }
}

function progressBar(percent: number, width: number = 20): string {
  const clamped = Math.max(0, Math.min(1, percent));
  const filled = Math.round(clamped * width);
  const empty = width - filled;
  const color = clamped >= 0.9 ? RED : clamped >= 0.7 ? YELLOW : GREEN;
  return `${color}${"█".repeat(filled)}${DIM}${"░".repeat(empty)}${RESET}`;
}

function padRight(str: string, len: number): string {
  const visible = str.replace(/\x1b\[[0-9;]*m/g, "");
  const pad = Math.max(0, len - visible.length);
  return str + " ".repeat(pad);
}

function visibleLength(str: string): number {
  return str.replace(/\x1b\[[0-9;]*m/g, "").length;
}

function readLocalSession(): SessionFile | null {
  try {
    const text = fs.readFileSync(path.resolve(process.cwd(), SESSION_FILE), "utf-8");
    return JSON.parse(text) as SessionFile;
  } catch {
    return null;
  }
}

// --- Resume helper ---
/**
 * Properly resume a session after a guardrail limit is adjusted.
 * Unpauses the session, unpauses all slots, and releases held messages.
 */
async function resumeSessionAfterAdjustment(
  client: BrokerClient,
  sessionId: string,
  state: DashboardState,
): Promise<void> {
  await client.updateSession({
    id: sessionId,
    status: "active",
    pause_reason: null,
    paused_at: null,
  });

  for (const slot of state.slots) {
    if (slot.paused) {
      await client.updateSlot({ id: slot.id, paused: false, paused_at: null });
      // Release any messages held during the pause
      await client.releaseHeldMessages(sessionId, slot.id).catch(() => {});
      // Notify the agent it can resume
      if (slot.peer_id) {
        await client.sendMessage({
          from_id: "orchestrator",
          to_id: slot.peer_id,
          text: JSON.stringify({ action: "resume", reason: "Guardrail limit adjusted from dashboard" }),
          msg_type: "control",
          session_id: sessionId,
        }).catch(() => {});
      }
    }
  }
}

// --- Tabs ---
type Tab = "agents" | "messages" | "stats" | "plan" | "files";
const TABS: { key: string; id: Tab; label: string }[] = [
  { key: "1", id: "agents", label: "Agents" },
  { key: "2", id: "messages", label: "Messages" },
  { key: "3", id: "stats", label: "Stats" },
  { key: "4", id: "plan", label: "Plan" },
  { key: "5", id: "files", label: "Files" },
];

// --- Dashboard state ---
interface DashboardState {
  session: Session | null;
  slots: Slot[];
  allPeers: Peer[];
  messages: Message[];
  guardrails: GuardrailState[];
  fileLocks: FileLock[];
  fileOwnership: FileOwnership[];
  planState: PlanState | null;
  brokerAlive: boolean;
  error: string | null;
  toast: { text: string; expires: number } | null;
  activeTab: Tab;
  scrollOffset: number;
  selectedRow: number;
  autoScroll: boolean;
  lastMessageCount: number;
}

export async function dashboard(sessionId?: string): Promise<void> {
  const client = new BrokerClient(BROKER_URL);

  if (!(await client.isAlive())) {
    console.error("Broker is not running. Start it with: multiagents broker start");
    process.exit(1);
  }

  // Resolve session ID: explicit arg > local file > most recent active session from broker > null
  let sid = sessionId ?? readLocalSession()?.session_id ?? null;
  if (!sid) {
    try {
      const sessions = await client.listSessions();
      const active = sessions.filter((s: any) => s.status === "active" || s.status === "paused");
      if (active.length > 0) {
        // Pick the most recently active session
        active.sort((a: any, b: any) => (b.last_active_at ?? 0) - (a.last_active_at ?? 0));
        const latestActive = active[0];
        if (latestActive) {
          sid = latestActive.id;
        }
      }
    } catch { /* broker doesn't support listSessions or no sessions */ }
  }

  const state: DashboardState = {
    session: null,
    slots: [],
    allPeers: [],
    messages: [],
    guardrails: [],
    fileLocks: [],
    fileOwnership: [],
    planState: null,
    brokerAlive: true,
    error: null,
    toast: null,
    activeTab: "agents",
    scrollOffset: 0,
    selectedRow: 0,
    autoScroll: true,
    lastMessageCount: 0,
  };

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }
  process.stdin.resume();
  process.stdin.setEncoding("utf-8");
  process.stdout.write(HIDE_CURSOR);

  let running = true;

  function showToast(text: string, durationMs: number = 3000): void {
    state.toast = { text, expires: Date.now() + durationMs };
  }

  // Keyboard handler
  process.stdin.on("data", async (key: string) => {
    // Clear expired toast
    if (state.toast && Date.now() > state.toast.expires) {
      state.toast = null;
    }

    // Tab switching: 1-4
    for (const tab of TABS) {
      if (key === tab.key) {
        state.activeTab = tab.id;
        state.scrollOffset = 0;
        state.selectedRow = 0;
        return;
      }
    }

    // Tab cycling: Tab key
    if (key === "\t") {
      const idx = TABS.findIndex((t) => t.id === state.activeTab);
      const nextTab = TABS[(idx + 1) % TABS.length];
      if (nextTab) {
        state.activeTab = nextTab.id;
      }
      state.scrollOffset = 0;
      state.selectedRow = 0;
      return;
    }

    switch (key) {
      case "q":
      case "\x03": // Ctrl+C
        running = false;
        cleanup();
        break;

      case "p": {
        showToast("Pausing all agents...");
        try {
          if (sid) {
            await client.updateSession({ id: sid, status: "paused", pause_reason: "Paused from dashboard", paused_at: Date.now() });
          }
          for (const s of state.slots) {
            await client.updateSlot({ id: s.id, paused: true, paused_at: Date.now() });
          }
          showToast("All agents paused");
        } catch (e) {
          showToast(`Pause failed: ${e instanceof Error ? e.message : String(e)}`);
        }
        break;
      }

      case "r": {
        showToast("Resuming all agents...");
        try {
          if (sid) {
            await client.updateSession({ id: sid, status: "active", pause_reason: null, paused_at: null });
          }
          for (const s of state.slots) {
            await client.updateSlot({ id: s.id, paused: false, paused_at: null });
          }
          showToast("All agents resumed");
        } catch (e) {
          showToast(`Resume failed: ${e instanceof Error ? e.message : String(e)}`);
        }
        break;
      }

      // Scroll / select
      case "j":
      case "\x1b[B": // Down arrow
        if (state.activeTab === "messages") {
          state.autoScroll = false;
          const maxScroll = Math.max(0, state.messages.length - msgVisibleRows());
          state.scrollOffset = Math.min(state.scrollOffset + 1, maxScroll);
          // Re-enable auto-scroll if at bottom
          if (state.scrollOffset >= maxScroll) state.autoScroll = true;
        } else if (state.activeTab === "stats") {
          state.selectedRow = Math.min(state.selectedRow + 1, state.guardrails.length - 1);
        } else if (state.activeTab === "agents") {
          state.selectedRow = Math.min(state.selectedRow + 1, state.slots.length - 1);
        }
        break;

      case "k":
      case "\x1b[A": // Up arrow
        if (state.activeTab === "messages") {
          state.autoScroll = false;
          state.scrollOffset = Math.max(0, state.scrollOffset - 1);
        } else if (state.activeTab === "stats" || state.activeTab === "agents") {
          state.selectedRow = Math.max(0, state.selectedRow - 1);
        }
        break;

      case "G": // Jump to bottom (messages)
        if (state.activeTab === "messages") {
          state.autoScroll = true;
          state.scrollOffset = Math.max(0, state.messages.length - msgVisibleRows());
        }
        break;

      case "g": // Jump to top (messages)
        if (state.activeTab === "messages") {
          state.autoScroll = false;
          state.scrollOffset = 0;
        }
        break;

      // Guardrail controls: + to increase selected guardrail
      case "+":
      case "=": {
        if (state.activeTab === "stats" && sid) {
          const g = state.guardrails[state.selectedRow];
          if (g && g.adjustable && g.suggested_increases?.length > 0) {
            const nextValue = g.suggested_increases.find((v) => v > g.current_value)
              ?? g.suggested_increases[g.suggested_increases.length - 1];
            if (nextValue === undefined) {
              break;
            }
            try {
              await client.updateGuardrail({
                session_id: sid,
                guardrail_id: g.id,
                new_value: nextValue,
                changed_by: "dashboard",
                reason: "Increased from dashboard",
              });

              // Auto-resume if session was paused by a guardrail
              const wasPaused = state.session?.status === "paused"
                && state.session?.pause_reason?.includes("Guardrail");
              if (wasPaused) {
                await resumeSessionAfterAdjustment(client, sid, state);
                showToast(`${g.label}: ${g.current_value} → ${nextValue} ${g.unit} — session auto-resumed`);
              } else {
                showToast(`${g.label}: ${g.current_value} → ${nextValue} ${g.unit}`);
              }
            } catch (e) {
              showToast(`Failed: ${e instanceof Error ? e.message : String(e)}`);
            }
          }
        }
        break;
      }

      case "-": {
        if (state.activeTab === "stats" && sid) {
          const g = state.guardrails[state.selectedRow];
          if (g && g.adjustable) {
            const prevValue = [...g.suggested_increases].reverse().find((v) => v < g.current_value)
              ?? Math.max(1, Math.floor(g.current_value / 2));
            try {
              await client.updateGuardrail({
                session_id: sid,
                guardrail_id: g.id,
                new_value: prevValue,
                changed_by: "dashboard",
                reason: "Decreased from dashboard",
              });
              showToast(`${g.label}: ${g.current_value} → ${prevValue} ${g.unit}`);
            } catch (e) {
              showToast(`Failed: ${e instanceof Error ? e.message : String(e)}`);
            }
          }
        }
        break;
      }
    }
  });

  function msgVisibleRows(): number {
    return Math.max(5, (process.stdout.rows || 40) - 8);
  }

  function cleanup(): void {
    process.stdout.write(SHOW_CURSOR);
    process.stdout.write(CLEAR + HOME);
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
    process.stdin.pause();
    process.exit(0);
  }

  let prevSessionStatus = "";

  while (running) {
    await fetchState(client, sid, state);

    // Auto-scroll messages when new ones arrive
    if (state.autoScroll && state.messages.length > state.lastMessageCount) {
      state.scrollOffset = Math.max(0, state.messages.length - msgVisibleRows());
    }
    state.lastMessageCount = state.messages.length;

    // Auto-switch to guardrails tab when session gets paused by a guardrail
    const curStatus = state.session?.status ?? "";
    if (curStatus === "paused" && prevSessionStatus === "active" && state.session?.pause_reason?.includes("Guardrail")) {
      state.activeTab = "stats";
      state.selectedRow = 0;
      // Select the triggered guardrail
      const triggeredIdx = state.guardrails.findIndex((g) => g.usage?.status === "triggered");
      if (triggeredIdx >= 0) state.selectedRow = triggeredIdx;
      showToast("Session paused by guardrail — press + to increase limit and auto-resume", 10000);
    }
    prevSessionStatus = curStatus;

    // Clear expired toast
    if (state.toast && Date.now() > state.toast.expires) {
      state.toast = null;
    }

    render(state, sid);
    // Slow down polling for inactive sessions — no need to hammer the broker
    const refreshMs = state.session?.status === "archived" ? 5000
      : state.session?.status === "paused" ? 2000
      : DASHBOARD_REFRESH;
    await Bun.sleep(refreshMs);
  }
}

async function fetchState(client: BrokerClient, sessionId: string | null, state: DashboardState): Promise<void> {
  try {
    state.brokerAlive = await client.isAlive();
    if (!state.brokerAlive) {
      state.error = "Broker is not responding";
      return;
    }

    const allPeers = await client.listPeers({
      scope: "machine",
      cwd: process.cwd(),
      git_root: null,
    }).catch(() => [] as Peer[]);
    state.allPeers = allPeers;

    if (sessionId) {
      const [session, slots, messages, guardrails, fileLocks, fileOwnership, planState] = await Promise.all([
        client.getSession(sessionId).catch(() => null),
        client.listSlots(sessionId).catch(() => [] as Slot[]),
        client.getMessageLog(sessionId, { limit: 100 }).catch(() => [] as Message[]),
        client.getGuardrails(sessionId).catch(() => [] as GuardrailState[]),
        client.listFileLocks(sessionId).catch(() => [] as FileLock[]),
        client.listFileOwnership(sessionId).catch(() => [] as FileOwnership[]),
        client.getPlan(sessionId).catch(() => null as PlanState | null),
      ]);

      state.session = session;
      state.slots = slots;
      state.messages = messages;
      state.guardrails = guardrails;
      state.fileLocks = fileLocks;
      state.fileOwnership = fileOwnership;
      state.planState = planState;
    } else {
      state.session = null;
      state.slots = [];
      state.messages = [];
      state.guardrails = [];
      state.fileLocks = [];
      state.fileOwnership = [];
      state.planState = null;
    }

    state.error = null;
  } catch (e) {
    state.error = e instanceof Error ? e.message : String(e);
  }
}

// --- Slot status resolution (shared between tabs) ---
function resolveSlots(state: DashboardState, sid: string | null): Map<number, { status: ResolvedSlotStatus; peer: Peer | null }> {
  const peerById = new Map(state.allPeers.map((p) => [p.id, p]));
  const sessionPeers = state.allPeers.filter((p) => p.session_id === sid);
  const matchedPeerIds = new Set<string>();
  const result = new Map<number, { status: ResolvedSlotStatus; peer: Peer | null }>();

  for (const slot of state.slots) {
    if (slot.peer_id && peerById.has(slot.peer_id)) {
      matchedPeerIds.add(slot.peer_id);
      result.set(slot.id, { status: "connected", peer: peerById.get(slot.peer_id)! });
    } else {
      const slotMatch = sessionPeers.find(
        (p) => !matchedPeerIds.has(p.id) && p.slot_id === slot.id,
      );
      if (slotMatch) {
        matchedPeerIds.add(slotMatch.id);
        result.set(slot.id, { status: "connected", peer: slotMatch });
      } else {
        // Distinguish "starting" (never connected) from "disconnected" (was connected, now gone)
        let displayStatus: ResolvedSlotStatus = slot.status;
        if (slot.status === "disconnected" && !slot.last_connected) {
          displayStatus = "starting";
        }
        result.set(slot.id, { status: displayStatus, peer: null });
      }
    }
  }
  return result;
}

// --- Rendering ---

function render(state: DashboardState, sid: string | null): void {
  const cols = process.stdout.columns || 80;
  const rows = process.stdout.rows || 40;
  const lines: string[] = [];

  // === HEADER (2 lines) ===
  const brokerDot = state.brokerAlive ? `${GREEN}●${RESET}` : `${RED}●${RESET}`;
  let headerRight = "";
  if (state.session) {
    const connectedCount = state.slots.filter((s) => {
      const r = resolveSlots(state, sid).get(s.id);
      return r?.status === "connected";
    }).length;
    const sessionStatus = colorStatus(state.session.status);
    // Freeze timer for archived/paused sessions — show duration at time of stop, not keep counting
    const endTime = state.session.status === "archived"
      ? (state.session.last_active_at ?? Date.now())
      : state.session.status === "paused"
        ? (state.session.paused_at ?? state.session.last_active_at ?? Date.now())
        : Date.now();
    const uptime = formatDuration(endTime - state.session.created_at);
    headerRight = `${connectedCount}/${state.slots.length} agents  ${sessionStatus}  ${DIM}${uptime}${RESET}`;
  }

  const title = `${brokerDot} ${BOLD}${CYAN}${state.session?.name ?? sid ?? "multiagents"}${RESET}`;
  const versionTag = `${DIM}v${PKG_VERSION}${RESET}`;
  lines.push(` ${title}  ${headerRight}  ${versionTag}`);

  // === TAB BAR ===
  let tabBar = " ";
  for (const tab of TABS) {
    const isActive = tab.id === state.activeTab;
    const badge = getBadge(tab.id, state);
    if (isActive) {
      tabBar += `${INVERSE}${BOLD} ${tab.key}:${tab.label}${badge} ${RESET} `;
    } else {
      tabBar += `${DIM}${tab.key}:${tab.label}${badge}${RESET} `;
    }
  }
  lines.push(tabBar);
  lines.push(`${DIM}${"─".repeat(cols)}${RESET}`);

  // === SESSION STATE BANNER ===
  if (state.session?.status === "archived") {
    lines.push(` ${RED}${BOLD}▸ SESSION ENDED${RESET} ${DIM}— archived at ${new Date(state.session.last_active_at).toLocaleTimeString()}. Dashboard is read-only.${RESET}`);
  } else if (state.session?.status === "paused") {
    const reason = state.session.pause_reason ? ` (${state.session.pause_reason})` : "";
    lines.push(` ${YELLOW}${BOLD}▸ SESSION PAUSED${RESET}${reason} ${DIM}— agents are holding. Resume with orchestrator or CLI.${RESET}`);
  }

  // === TOAST ===
  if (state.toast) {
    lines.push(` ${YELLOW}▸ ${state.toast.text}${RESET}`);
  } else if (state.error) {
    lines.push(` ${RED}▸ ${state.error}${RESET}`);
  }

  // === TAB CONTENT ===
  const contentRows = rows - lines.length - 2; // Reserve 2 for bottom bar
  const contentLines: string[] = [];

  switch (state.activeTab) {
    case "agents":
      renderAgentsTab(state, sid, cols, contentRows, contentLines);
      break;
    case "messages":
      renderMessagesTab(state, cols, contentRows, contentLines);
      break;
    case "stats":
      renderStatsTab(state, cols, contentRows, contentLines);
      break;
    case "plan":
      renderPlanTab(state, cols, contentRows, contentLines);
      break;
    case "files":
      renderFilesTab(state, cols, contentRows, contentLines);
      break;
  }

  // Pad content to fill screen
  while (contentLines.length < contentRows) contentLines.push("");
  lines.push(...contentLines.slice(0, contentRows));

  // === BOTTOM BAR ===
  lines.push(`${DIM}${"─".repeat(cols)}${RESET}`);
  lines.push(getControlsLine(state, sid));

  process.stdout.write(CLEAR + HOME + lines.join("\n"));
}

function getBadge(tab: Tab, state: DashboardState): string {
  switch (tab) {
    case "agents": {
      const connected = state.slots.filter((s) => s.status === "connected").length;
      return connected > 0 ? ` ${GREEN}${connected}${RESET}` : "";
    }
    case "messages":
      return state.messages.length > 0 ? ` ${CYAN}${state.messages.length}${RESET}` : "";
    case "stats": {
      const enforced = state.guardrails.filter((g) => g.action !== "monitor");
      const warnings = enforced.filter((g) => g.usage?.status !== "ok").length;
      return warnings > 0 ? ` ${YELLOW}${warnings}!${RESET}` : "";
    }
    case "plan": {
      const ps = state.planState;
      if (ps?.plan && ps.items.length > 0) {
        return ` ${CYAN}${ps.completion}%${RESET}`;
      }
      return "";
    }
    case "files":
      const fileCount = state.fileLocks.length + state.fileOwnership.length;
      return fileCount > 0 ? ` ${DIM}${fileCount}${RESET}` : "";
    default:
      return "";
  }
}

function getControlsLine(state: DashboardState, sid: string | null): string {
  const common = `${DIM}q${RESET} quit  ${DIM}Tab${RESET} switch  ${DIM}1-5${RESET} jump`;

  switch (state.activeTab) {
    case "agents":
      return ` ${common}  ${DIM}j/k${RESET} select  ${DIM}p${RESET} pause  ${DIM}r${RESET} resume`;
    case "messages":
      return ` ${common}  ${DIM}j/k${RESET} scroll  ${DIM}g/G${RESET} top/bottom`;
    case "stats":
      return ` ${common}  ${DIM}j/k${RESET} select guardrail  ${DIM}+/-${RESET} adjust`;
    case "plan":
      return ` ${common}`;
    case "files":
      return ` ${common}  ${DIM}j/k${RESET} scroll`;
    default:
      return ` ${common}`;
  }
}

// === TAB: AGENTS ===
function renderAgentsTab(state: DashboardState, sid: string | null, cols: number, maxRows: number, lines: string[]): void {
  if (state.slots.length === 0 && state.allPeers.length === 0) {
    lines.push("");
    lines.push(`${DIM}  No agents connected${RESET}`);
    return;
  }

  const resolved = resolveSlots(state, sid);

  if (state.slots.length > 0) {
    // Header
    const hdrParts = [
      " ",
      "Name".padEnd(18),
      "Type".padEnd(8),
      "Role".padEnd(18),
      "Conn".padEnd(14),
      "Task".padEnd(14),
    ];
    lines.push(`${DIM}${hdrParts.join("")}${RESET}`);

    for (const [i, slot] of state.slots.entries()) {
      const r = resolved.get(slot.id) ?? { status: slot.status, peer: null };
      const isSelected = i === state.selectedRow;
      const prefix = isSelected ? `${CYAN}▸${RESET}` : " ";

      const name = truncate(slot.display_name ?? "—", 16);
      const type = slot.agent_type.padEnd(8);
      const role = truncate(slot.role ?? "—", 16);
      const connStatus = colorStatus(r.status);
      const taskState = colorTaskState(slot.task_state ?? "idle");

      let line = `${prefix}${name.padEnd(18)}${type}${role.padEnd(18)}${padRight(connStatus, 14)}${taskState}`;

      // Show summary for selected agent
      if (isSelected && r.peer?.summary) {
        lines.push(line);
        lines.push(`  ${DIM}└─ ${truncate(r.peer.summary, cols - 6)}${RESET}`);
        continue;
      }

      lines.push(line);
    }

    // Summary stats
    const connected = [...resolved.values()].filter((r) => r.status === "connected").length;
    const done = state.slots.filter((s) => s.task_state === "done_pending_review" || s.task_state === "approved").length;
    const working = state.slots.filter((s) => s.task_state === "idle" || s.task_state === "working" || s.task_state === "addressing_feedback").length;
    lines.push("");
    lines.push(`  ${GREEN}●${RESET} ${connected} connected  ${CYAN}●${RESET} ${working} working  ${YELLOW}●${RESET} ${done} done/approved`);
  } else {
    // Raw peers mode
    lines.push(`${BOLD} Peers (${state.allPeers.length})${RESET}`);
    lines.push(`${DIM} ${"ID".padEnd(14)}${"Type".padEnd(10)}${"Summary".padEnd(40)}${RESET}`);

    for (const peer of state.allPeers) {
      const id = truncate(peer.id, 12);
      const agentType = (peer.agent_type ?? "?").padEnd(10);
      const summary = truncate(peer.summary ?? "—", 38);
      lines.push(` ${id.padEnd(14)}${agentType}${summary}`);
    }
  }
}

// === TAB: MESSAGES ===
function renderMessagesTab(state: DashboardState, cols: number, maxRows: number, lines: string[]): void {
  if (state.messages.length === 0) {
    lines.push("");
    lines.push(`${DIM}  No messages yet — waiting for agent activity${RESET}`);
    return;
  }

  const slotMap = new Map(state.slots.map((s) => [s.id, s]));
  const visibleCount = maxRows - 2;

  const maxScroll = Math.max(0, state.messages.length - visibleCount);
  if (state.scrollOffset > maxScroll) state.scrollOffset = maxScroll;

  const visible = state.messages.slice(state.scrollOffset, state.scrollOffset + visibleCount);

  for (const m of visible) {
    const fromSlot = m.from_slot_id != null ? slotMap.get(m.from_slot_id) : null;
    const fromName = (m as any).from_display_name ?? fromSlot?.display_name ?? m.from_id ?? "system";
    const toName = (m as any).to_display_name ?? (m.to_slot_id != null ? slotMap.get(m.to_slot_id)?.display_name : null) ?? null;

    const time = formatTime(m.sent_at);
    const msgType = colorMsgType(m.msg_type);

    // Color sender name
    const senderColor = fromName === "orchestrator"
      ? `${MAGENTA}${fromName}${RESET}`
      : `${BOLD}${fromName}${RESET}`;

    // Build sender → recipient label
    const arrow = toName ? ` ${DIM}→${RESET} ${WHITE}${toName}${RESET}` : "";

    const headerLen = 8 + visibleLength(fromName) + (toName ? 3 + visibleLength(toName) : 0) + visibleLength(m.msg_type) + 4;
    const maxText = Math.max(20, cols - headerLen - 2);
    const text = truncate(String(m.text).replace(/\n/g, " ↵ "), maxText);

    lines.push(` ${DIM}${time}${RESET} ${senderColor}${arrow} ${msgType} ${text}`);
  }

  // Scroll indicator
  const scrollPct = state.messages.length <= visibleCount ? 100 : Math.round((state.scrollOffset / maxScroll) * 100);
  const autoIndicator = state.autoScroll ? `${GREEN}auto-scroll${RESET}` : `${DIM}manual${RESET}`;
  lines.push(`${DIM} ${state.messages.length} messages  ${scrollPct}%  ${autoIndicator}${RESET}`);
}

// === TAB: STATS ===
function renderStatsTab(state: DashboardState, cols: number, maxRows: number, lines: string[]): void {
  let hasContent = false;

  // Separate monitoring stats from enforced guardrails
  const monitorStats = state.guardrails.filter((g) => g.action === "monitor");
  const enforced = state.guardrails.filter((g) => g.action !== "monitor");

  // --- Monitoring stats section ---
  if (monitorStats.length > 0) {
    hasContent = true;
    lines.push("");
    lines.push(`${BOLD} Session Metrics${RESET}`);
    lines.push("");

    const wide = cols >= 80;
    const items: string[] = [];

    for (const g of monitorStats) {
      const current = g.usage ? formatStatValue(g.usage.current, g.unit) : "—";
      const label = g.label;
      items.push(`  ${CYAN}${current.padStart(8)}${RESET} ${label}`);
    }

    if (wide && items.length > 1) {
      const mid = Math.ceil(items.length / 2);
      for (let i = 0; i < mid; i++) {
        const left = items[i] ?? "";
        const right = items[i + mid] ?? "";
        lines.push(`${left.padEnd(40)}${right}`);
      }
    } else {
      for (const item of items) {
        lines.push(item);
      }
    }
  }

  // --- Token usage section (always rendered, independent of guardrails) ---
  const slotsWithTokens = state.slots.filter((s) => (s.input_tokens ?? 0) + (s.output_tokens ?? 0) > 0);
  if (slotsWithTokens.length > 0) {
    hasContent = true;
    lines.push("");
    lines.push(`${BOLD} Token Usage${RESET}`);
    lines.push("");

    let totalInput = 0;
    let totalOutput = 0;
    let totalCache = 0;

    for (const slot of slotsWithTokens) {
      const inp = slot.input_tokens ?? 0;
      const out = slot.output_tokens ?? 0;
      const cache = slot.cache_read_tokens ?? 0;
      totalInput += inp;
      totalOutput += out;
      totalCache += cache;

      const name = truncate(slot.display_name ?? `Slot ${slot.id}`, 16);
      const inStr = formatTokenCount(inp);
      const outStr = formatTokenCount(out);
      const cacheStr = cache > 0 ? `  ${DIM}cache:${RESET} ${formatTokenCount(cache)}` : "";
      lines.push(`  ${name.padEnd(18)} ${DIM}in:${RESET} ${CYAN}${inStr.padStart(7)}${RESET}  ${DIM}out:${RESET} ${GREEN}${outStr.padStart(7)}${RESET}${cacheStr}`);
    }

    lines.push(`${DIM}  ${"─".repeat(50)}${RESET}`);
    const totalStr = formatTokenCount(totalInput + totalOutput);
    const cacheStr = totalCache > 0 ? `  ${DIM}cache:${RESET} ${formatTokenCount(totalCache)}` : "";
    lines.push(`  ${"Total".padEnd(18)} ${DIM}in:${RESET} ${CYAN}${formatTokenCount(totalInput).padStart(7)}${RESET}  ${DIM}out:${RESET} ${GREEN}${formatTokenCount(totalOutput).padStart(7)}${RESET}${cacheStr}  ${BOLD}= ${totalStr}${RESET}`);
  } else {
    // Show placeholder with slot names even before tokens arrive
    if (state.slots.length > 0) {
      hasContent = true;
      lines.push("");
      lines.push(`${BOLD} Token Usage${RESET}`);
      lines.push("");
      for (const slot of state.slots) {
        const name = truncate(slot.display_name ?? `Slot ${slot.id}`, 16);
        lines.push(`  ${name.padEnd(18)} ${DIM}in:${RESET} ${CYAN}${"0".padStart(7)}${RESET}  ${DIM}out:${RESET} ${GREEN}${"0".padStart(7)}${RESET}`);
      }
    }
  }

  // --- Interaction summary (always rendered, independent of guardrails) ---
  if (state.messages.length > 0) {
    hasContent = true;
    lines.push("");
    lines.push(`${BOLD} Interaction Summary${RESET}`);
    lines.push("");

    const slotMap = new Map(state.slots.map((s) => [s.id, s]));
    const senderCounts = new Map<string, number>();
    const interactions = new Map<string, number>();

    for (const m of state.messages) {
      const fromName = (m as any).from_display_name ?? slotMap.get(m.from_slot_id ?? -1)?.display_name ?? m.from_id ?? "system";
      const toName = (m as any).to_display_name ?? (m.to_slot_id != null ? slotMap.get(m.to_slot_id)?.display_name : null) ?? "broadcast";

      senderCounts.set(fromName, (senderCounts.get(fromName) ?? 0) + 1);

      if (fromName !== "orchestrator") {
        const key = `${fromName} → ${toName}`;
        interactions.set(key, (interactions.get(key) ?? 0) + 1);
      }
    }

    const topSenders = [...senderCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6);

    const topSenderCount = topSenders[0]?.[1] ?? 1;
    for (const [name, count] of topSenders) {
      const bar = "█".repeat(Math.min(20, Math.round(count / Math.max(1, topSenderCount) * 20)));
      lines.push(`  ${name.padEnd(18)} ${CYAN}${bar}${RESET} ${DIM}${count}${RESET}`);
    }

    if (interactions.size > 0) {
      lines.push("");
      lines.push(`${BOLD} Top Interactions${RESET}`);
      lines.push("");
      const topInteractions = [...interactions.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5);

      for (const [pair, count] of topInteractions) {
        lines.push(`  ${DIM}${String(count).padStart(4)}×${RESET}  ${pair}`);
      }
    }
  }

  // --- Enforced guardrails section ---
  if (enforced.length > 0) {
    lines.push("");
    lines.push(`${BOLD} Guardrails${RESET}`);
    lines.push("");

    for (const g of enforced) {
      // Adjust selectedRow to only count enforced items
      const enforcedIdx = state.guardrails.indexOf(g);
      const isSelected = enforcedIdx === state.selectedRow;
      const prefix = isSelected ? `${CYAN}▸${RESET}` : " ";

      if (!g.usage) {
        lines.push(`${prefix} ${g.label.padEnd(22)} ${DIM}no data${RESET}`);
        continue;
      }

      const bar = progressBar(g.usage.percent, 15);
      const label = truncate(g.label, 20).padEnd(22);
      const current = formatStatValue(g.usage.current, g.unit);
      const usage = `${current}/${g.usage.limit} ${g.unit}`;
      const status = colorStatus(g.usage.status);

      lines.push(`${prefix}${label}${bar}  ${usage.padEnd(20)} ${status}`);

      if (isSelected && g.adjustable && g.suggested_increases?.length > 0) {
        const opts = g.suggested_increases
          .map((v) => v === g.current_value ? `${BOLD}[${v}]${RESET}` : `${DIM}${v}${RESET}`)
          .join("  ");
        lines.push(`  ${DIM}└─ Press ${RESET}${BOLD}+/-${RESET}${DIM} to adjust:${RESET} ${opts} ${g.unit}`);
      }
    }
  }

  if (!hasContent) {
    lines.push("");
    lines.push(`${DIM}  No stats available yet — token data will appear as agents work${RESET}`);
  }
}

function formatStatValue(value: number, unit: string): string {
  if (unit === "minutes") {
    if (value < 1) return `${Math.round(value * 60)}s`;
    if (value < 60) return `${value.toFixed(1)}m`;
    const h = Math.floor(value / 60);
    const m = Math.round(value % 60);
    return `${h}h${m}m`;
  }
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function formatTokenCount(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
  return String(count);
}

// === TAB: PLAN ===
function renderPlanTab(state: DashboardState, cols: number, maxRows: number, lines: string[]): void {
  const ps = state.planState;

  if (!ps?.plan || ps.items.length === 0) {
    lines.push("");
    lines.push(`${DIM}  No plan defined for this session${RESET}`);
    lines.push(`${DIM}  Pass a plan array to create_team to track progress${RESET}`);
    return;
  }

  // Header with progress bar
  const pct = ps.completion / 100;
  const bar = progressBar(pct, 30);
  const done = ps.items.filter((i) => i.status === "done").length;
  lines.push("");
  lines.push(` ${BOLD}${ps.plan.title}${RESET}  ${bar}  ${BOLD}${ps.completion}%${RESET} ${DIM}(${done}/${ps.items.length})${RESET}`);
  lines.push("");

  // Plan items
  for (const item of ps.items) {
    const indent = item.parent_id ? "    " : "  ";
    let marker: string;
    let labelColor: string;

    switch (item.status) {
      case "done":
        marker = `${GREEN}[x]${RESET}`;
        labelColor = DIM;
        break;
      case "in_progress":
        marker = `${CYAN}[~]${RESET}`;
        labelColor = BOLD;
        break;
      case "blocked":
        marker = `${RED}[!]${RESET}`;
        labelColor = RED;
        break;
      default: // pending
        marker = `${DIM}[ ]${RESET}`;
        labelColor = "";
    }

    const assignee = item.assigned_name ? `${DIM}${item.assigned_name}${RESET}` : "";
    const statusTag = item.status === "in_progress" ? ` ${CYAN}(in progress)${RESET}` : "";
    const label = `${labelColor}${item.label}${labelColor ? RESET : ""}`;

    const itemLine = `${indent}${marker} ${label}${statusTag}`;
    const assigneePad = assignee ? "  " + assignee : "";

    // Right-align assignee
    const visLen = visibleLength(itemLine);
    const assigneeVisLen = visibleLength(assigneePad);
    const gap = Math.max(1, cols - visLen - assigneeVisLen - 2);

    lines.push(`${itemLine}${" ".repeat(gap)}${assigneePad}`);
  }

  // Summary at bottom
  const inProgress = ps.items.filter((i) => i.status === "in_progress").length;
  const blocked = ps.items.filter((i) => i.status === "blocked").length;
  const pending = ps.items.filter((i) => i.status === "pending").length;
  lines.push("");
  lines.push(`  ${GREEN}${done} done${RESET}  ${CYAN}${inProgress} in progress${RESET}  ${pending > 0 ? `${DIM}${pending} pending${RESET}  ` : ""}${blocked > 0 ? `${RED}${blocked} blocked${RESET}` : ""}`);
}

// === TAB: FILES ===
function renderFilesTab(state: DashboardState, cols: number, maxRows: number, lines: string[]): void {
  const slotMap = new Map(state.slots.map((s) => [s.id, s]));
  let hasContent = false;

  // --- Ownership zones (persistent assignments from create_team) ---
  if (state.fileOwnership.length > 0) {
    hasContent = true;
    lines.push("");
    lines.push(`${BOLD} Ownership Zones${RESET}`);
    lines.push("");
    lines.push(`${DIM} ${"Pattern".padEnd(40)}${"Owner".padEnd(22)}${"Assigned By"}${RESET}`);
    lines.push(`${DIM} ${"─".repeat(Math.min(cols - 2, 72))}${RESET}`);

    for (const own of state.fileOwnership) {
      const pattern = truncate(own.path_pattern, 38);
      const slot = slotMap.get(own.slot_id);
      const owner = truncate(slot?.display_name ?? `Slot ${own.slot_id}`, 20);
      const by = truncate(own.assigned_by, 14);
      lines.push(` ${pattern.padEnd(40)}${owner.padEnd(22)}${DIM}${by}${RESET}`);
    }
  }

  // --- Active file locks (transient, held during edits) ---
  if (state.fileLocks.length > 0) {
    hasContent = true;
    lines.push("");
    lines.push(`${BOLD} Active Locks${RESET}`);
    lines.push("");
    lines.push(`${DIM} ${"File".padEnd(40)}${"Held By".padEnd(22)}${"Type"}${RESET}`);
    lines.push(`${DIM} ${"─".repeat(Math.min(cols - 2, 72))}${RESET}`);

    for (const lock of state.fileLocks) {
      const file = truncate(lock.file_path, 38);
      const slot = slotMap.get(lock.held_by_slot);
      const holder = truncate(slot?.display_name ?? `Slot ${lock.held_by_slot}`, 20);
      lines.push(` ${file.padEnd(40)}${holder.padEnd(22)}${DIM}${lock.lock_type}${RESET}`);
    }
  }

  if (!hasContent) {
    lines.push("");
    lines.push(`${DIM}  No file ownership or active locks${RESET}`);
    lines.push(`${DIM}  Assign file_ownership in create_team to see ownership zones here${RESET}`);
  }
}
