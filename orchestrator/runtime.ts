// ============================================================================
// multiagents — Orchestrator Runtime
// ============================================================================
// The orchestrator's agent lifecycle: launched processes and drivers, the
// background supervision loops, and the tool implementations (create_team,
// add_agent, release_agent, ...). Hosted by the MCP server
// (orchestrator-server.ts) and by the web dashboard (dashboard/server.ts), so
// both front-ends drive the same logic. Agents belong to the process that
// launched them: each host supervises only its own.
// ============================================================================

import type { Subprocess } from "bun";

import * as fs from "node:fs";
import { BrokerClient } from "../shared/broker-client.ts";
import type { AgentLaunchConfig, Slot } from "../shared/types.ts";
import { log, getGitRoot, uniqueSessionId, formatDuration, safeJsonParse } from "../shared/utils.ts";
import {
  GUARDRAIL_CHECK_INTERVAL,
  CONFLICT_CHECK_INTERVAL,
  FLAP_WINDOW_MS,
  STUCK_THRESHOLD_MS,
  BROKER_FEATURES,
} from "../shared/constants.ts";
import { brokerUrl, resolveBrokerPort } from "../shared/broker-url.ts";
import { probeBrokerHealth, stopBrokerProcess } from "../cli/update.ts";

import { detectAgent, launchAgent, relaunchIntoSlot, announceNewMember, buildTeamContext, ENRICHED_PATH, slotSettings } from "./launcher.ts";
import { getGuide, formatTopicList, type GuideTopic } from "./guide.ts";
import { monitorProcess, monitorCodexDriver, monitorClaudeDriver, clearSlotTracking, clearAllTracking, type AgentEvent } from "./monitor.ts";
import { deliverPendingMessages, launchedSettings, type DriverSlot } from "./delivery.ts";
import { RespawnGuard } from "./respawn-guard.ts";
import type { CodexDriver } from "./codex-driver.ts";
import type { ClaudeSession } from "./claude-driver.ts";
import { getTeamStatus, formatTeamStatusForDisplay } from "./progress.ts";
import { checkGuardrails, enforceGuardrails } from "./guardrails.ts";
import { handleAgentCrash, clearAllCrashHistory } from "./recovery.ts";
import { controlSession, broadcastToTeam, resolveTarget, pauseAgent } from "./session-control.ts";
import { DriverRegistry, nonOverlapping, releaseVerdict, watchdogInbox, limitVerdict, deadSlotVerdict, type UsageLimits } from "./supervision.ts";
import { LiveTracker } from "./live.ts";
import { ActivityRecorder, awaitApproval, claudeActivity, codexActivity, geminiActivity, describeTool, isTeamTool, CLAUDE_PERMISSION_MODE, CODEX_APPROVAL_POLICY } from "./activity.ts";

const LOG_PREFIX = "orchestrator";
const BROKER_URL = brokerUrl();

// Track active processes per session
const activeProcesses: Map<string, Map<number, Subprocess>> = new Map();
// Track pending events to push as notifications
const pendingEvents: AgentEvent[] = [];
// Driver-managed agents (Claude over stream-json, Codex over app-server), one driver per slot
const activeDrivers = new DriverRegistry();
// One respawn per slot at a time, whichever path (crash, code-0 exit, watchdog, resume) triggers it
const respawnGuard = new RespawnGuard();

// --- Q&A mode: the person put the team's work on hold to ask questions ---
// Session config `qa_mode` is set from a dashboard. The broker then hands agents
// only the person's and the orchestrator's messages; here running turns are
// interrupted, edits and commands are refused, and nudges / respawns wait.
const qaCache = new Map<string, { on: boolean; at: number }>();

async function qaModeOn(sessionId: string, brokerClient: BrokerClient): Promise<boolean> {
  const hit = qaCache.get(sessionId);
  if (hit && Date.now() - hit.at < 2_500) return hit.on;
  const session = await brokerClient.getSession(sessionId).catch(() => null);
  const on = !!safeJsonParse<Record<string, unknown>>(session?.config ?? "{}", {}).qa_mode;
  qaCache.set(sessionId, { on, at: Date.now() });
  return on;
}

/** Tools an agent may still use in Q&A mode: reading, to answer questions about its work. */
const QA_READ_ONLY_TOOLS = new Set(["Read", "Grep", "Glob", "LS", "NotebookRead", "TodoWrite", "WebSearch", "WebFetch"]);
const QA_DENIAL = "Work is on hold (Q&A mode): the person is asking questions. Do not edit files or run commands — answer with send_message(to_id=\"human\") and wait for [RESUME].";

interface LaunchedAgent {
  pid: number;
  process: Subprocess;
  codexDriver?: CodexDriver;
  claudeDriver?: ClaudeSession;
  settings?: { model?: string; effort?: string; approvalMode?: string };
}

async function slotIsReleased(slotId: number, brokerClient: BrokerClient): Promise<boolean> {
  try {
    return (await brokerClient.getTaskState(slotId)).task_state === "released";
  } catch {
    return false;
  }
}

/** Graceful stop: Claude finishes its turn and exits on stdin EOF, Codex is killed. */
async function closeDriver(state: DriverSlot): Promise<void> {
  if (state.kind === "claude") await state.driver.close();
  else await state.driver.kill();
}

/**
 * Stop every agent of a session. The session is forgotten BEFORE anything is
 * killed, so the exit handlers that fire while processes die find no session
 * to respawn into.
 */
function stopSession(sessionId: string): { stopped: number } {
  activeSessions.delete(sessionId);
  const procs = activeProcesses.get(sessionId);
  activeProcesses.delete(sessionId);
  const drivers = activeDrivers.dropSession(sessionId);

  let stopped = 0;
  for (const [slotId, state] of drivers ?? []) {
    log(LOG_PREFIX, `Stopping ${state.kind} driver in slot ${slotId}`);
    state.driver.kill().catch(() => { /* already dead */ });
    stopped++;
  }
  for (const [slotId, proc] of procs ?? []) {
    if (drivers?.has(slotId)) continue; // a driver's process was killed above
    log(LOG_PREFIX, `Stopping agent in slot ${slotId}`);
    try { proc.kill(); } catch { /* already dead */ }
    stopped++;
  }
  return { stopped };
}

/**
 * Track a launched or respawned agent: process map, driver map, monitoring
 * and exit handling. Every launch path goes through here so no agent is left
 * unmonitored or double-tracked.
 */
function trackLaunch(sessionId: string, slotId: number, result: LaunchedAgent, brokerClient: BrokerClient): void {
  let procs = activeProcesses.get(sessionId);
  if (!procs) {
    procs = new Map();
    activeProcesses.set(sessionId, procs);
  }
  procs.set(slotId, result.process);

  const state: DriverSlot | null = result.claudeDriver
    ? { kind: "claude", driver: result.claudeDriver, busy: false, lastNudge: 0 }
    : result.codexDriver
      ? { kind: "codex", driver: result.codexDriver, threadId: result.codexDriver.threadId, busy: false, lastNudge: 0 }
      : null;
  if (!state) {
    const recorder = new ActivityRecorder(sessionId, slotId, brokerClient);
    const live = new LiveTracker(sessionId, slotId, brokerClient);
    monitorProcess(result.process, slotId, sessionId, brokerClient, handleEvent, (event) => {
      recorder.push(...geminiActivity(event));
      live.gemini(event as Record<string, any>);
    });
    result.process.exited.then(() => { live.dispose(); return recorder.flush(); });
    return;
  }

  if (result.settings) state.applied = launchedSettings(state.kind, result.settings);
  const displaced = activeDrivers.track(sessionId, slotId, state);
  if (displaced) {
    log(LOG_PREFIX, `Slot ${slotId} already had a live ${displaced.kind} driver (pid ${displaced.driver.pid}) — stopping it in favour of the new one`);
    displaced.driver.kill().catch(() => { /* already dead */ });
  }
  if (state.kind === "claude") {
    monitorClaudeDriver(state.driver, slotId, sessionId, brokerClient, handleEvent);
  } else {
    monitorCodexDriver(state.driver, slotId, sessionId, brokerClient, handleEvent);
  }
  superviseDriver(sessionId, slotId, state, brokerClient);
  state.driver.onExit((code) => onDriverExit(sessionId, slotId, state, code, brokerClient));
}

/** Key under which "always allow" remembers a tool (a shell command by its program). */
function approvalKey(tool: string, input: Record<string, unknown>): string {
  if (tool === "Bash" && typeof input.command === "string") return `Bash:${input.command.trim().split(/\s+/)[0] ?? ""}`;
  return tool;
}

/**
 * Feed the driver's steps into the activity timeline and route its tool
 * approvals to a person (through the broker, so any dashboard can answer).
 */
function superviseDriver(sessionId: string, slotId: number, state: DriverSlot, brokerClient: BrokerClient): void {
  const recorder = new ActivityRecorder(sessionId, slotId, brokerClient);
  const stillWanted = () => state.driver.alive && activeDrivers.get(sessionId, slotId) === state;
  const alwaysAllowed = new Set<string>();
  const live = new LiveTracker(sessionId, slotId, brokerClient, () =>
    state.driver.alive && (state.kind === "claude" ? state.driver.busy : state.driver.activeTurnId !== null));
  state.driver.onExit((code) => {
    live.dispose();
    recorder.push({ kind: "status", title: `Agent process exited (code ${code})` });
    void recorder.flush();
  });

  const ask = async (tool: string, title: string, input: unknown) => {
    recorder.push({ kind: "approval", title: `Waiting for approval · ${title}`, data: { tool, input } });
    await recorder.flush();
    const outcome = await awaitApproval(brokerClient, { sessionId, slotId, tool, title, input }, stillWanted);
    recorder.push({
      kind: "approval",
      title: `${outcome.allowed ? (outcome.always ? "Always allowed" : "Approved") : outcome.note === "cancelled" ? "Cancelled" : "Denied"} · ${title}`,
      detail: outcome.note && outcome.note !== "cancelled" ? outcome.note : null,
      data: { tool, allowed: outcome.allowed },
    });
    return outcome;
  };

  if (state.kind === "claude") {
    const tools = new Map<string, { name: string; title: string }>();
    state.driver.onEvent((event) => {
      live.claude(event as Record<string, any>);
      if ((event as { type?: string }).type !== "stream_event") recorder.push(...claudeActivity(event as Record<string, any>, tools));
    }, { replay: true });
    state.driver.onPermissionRequest(async (req) => {
      if (isTeamTool(req.toolName)) return { behavior: "allow" };
      if (await qaModeOn(sessionId, brokerClient)) {
        if (QA_READ_ONLY_TOOLS.has(req.toolName)) return { behavior: "allow" };
        recorder.push({ kind: "approval", title: `Refused in Q&A mode · ${describeTool(req.toolName, req.input)}` });
        return { behavior: "deny", message: QA_DENIAL };
      }
      const key = approvalKey(req.toolName, req.input);
      if (alwaysAllowed.has(key)) return { behavior: "allow" };
      const outcome = await ask(req.toolName, describeTool(req.toolName, req.input), req.input);
      if (!outcome.allowed) {
        return { behavior: "deny", message: outcome.note && outcome.note !== "cancelled" ? `A person denied this tool call: ${outcome.note}` : "A person denied this tool call." };
      }
      if (outcome.always) alwaysAllowed.add(key);
      return { behavior: "allow", always: outcome.always };
    });
  } else {
    const items = new Map<string, Record<string, any>>(); // started items, for the context of an approval
    state.driver.onNotification(({ method, params }) => {
      if (method === "item/started" && params.item && typeof (params.item as { id?: unknown }).id === "string") {
        items.set((params.item as { id: string }).id, params.item as Record<string, any>);
      }
      if (method === "item/completed" && params.item) items.delete((params.item as { id?: string }).id ?? "");
      live.codex(method, params as Record<string, any>);
      recorder.push(...codexActivity(method, params as Record<string, any>));
    });
    state.driver.onApprovalRequest(async ({ kind, params }) => {
      // Q&A mode runs Codex with "untrusted": reads go through, anything else is refused
      if (await qaModeOn(sessionId, brokerClient)) {
        recorder.push({ kind: "approval", title: `Refused in Q&A mode · ${kind === "command" ? "shell command" : "file change"}` });
        return "decline";
      }
      const item = items.get(String(params.itemId ?? ""));
      const command = Array.isArray(params.command) ? params.command.join(" ") : (params.command as string | undefined) ?? (item?.command as string | undefined);
      const changes = (item?.changes as Array<{ path?: string }> | undefined) ?? [];
      const title = kind === "command"
        ? `$ ${command ?? "shell command"}`
        : changes.length ? `Edit ${changes.map((c) => c.path).join(", ")}` : "Apply file changes";
      const tool = kind === "command" ? "shell" : kind === "fileChange" ? "apply_patch" : "permissions";
      const key = kind === "command" ? `shell:${(command ?? "").trim().split(/\s+/)[0] ?? ""}` : tool;
      if (alwaysAllowed.has(key)) return "accept";
      const outcome = await ask(tool, title, { ...params, ...(item?.changes ? { changes: item.changes } : {}), ...(command ? { command } : {}) });
      if (!outcome.allowed) return "decline";
      if (outcome.always) { alwaysAllowed.add(key); return "acceptForSession"; }
      return "accept";
    });
  }
  (state as DriverSlot & { recorder?: ActivityRecorder }).recorder = recorder;
}

/** Recorder attached by superviseDriver (for status lines from the loops). */
function recorderOf(state: DriverSlot): ActivityRecorder | undefined {
  return (state as DriverSlot & { recorder?: ActivityRecorder }).recorder;
}

/**
 * Bring a running driver in line with its slot: model, effort and approval
 * mode edited in a dashboard apply live (Claude: control requests; Codex: the
 * next turn), and a paused slot's running turn is interrupted.
 */
async function reconcileDriver(slot: Slot, state: DriverSlot, qa = false): Promise<void> {
  const want = slotSettings(slot);
  // Q&A mode: every tool goes through the handler, which only lets reads pass
  if (qa) want.approvalMode = "ask";
  const recorder = recorderOf(state);
  // A driver launched without a record of its settings is taken to run the slot's current ones
  state.applied ??= launchedSettings(state.kind, want);
  const applied = state.applied;

  if (state.kind === "claude") {
    if (applied.approvalMode !== want.approvalMode) {
      applied.approvalMode = want.approvalMode;
      try {
        await state.driver.setPermissionMode(CLAUDE_PERMISSION_MODE[want.approvalMode]);
        recorder?.push({ kind: "status", title: `Approval mode → ${want.approvalMode}` });
      } catch (err) {
        recorder?.push({ kind: "error", title: `Could not switch to approval mode ${want.approvalMode}`, detail: String(err instanceof Error ? err.message : err) });
      }
    }
    if (applied.model !== want.model) {
      applied.model = want.model;
      try {
        await state.driver.setModel(want.model);
        recorder?.push({ kind: "status", title: `Model → ${want.model ?? "default"}` });
      } catch (err) {
        recorder?.push({ kind: "error", title: `Could not switch to model ${want.model ?? "default"}`, detail: String(err instanceof Error ? err.message : err) });
      }
    }
    if (applied.effort !== want.effort) {
      applied.effort = want.effort;
      recorder?.push({ kind: "status", title: `Effort → ${want.effort ?? "default"} (applies when the agent restarts)` });
    }
  } else {
    const qaApplied = (state as DriverSlot & { qaSandbox?: boolean }).qaSandbox === true;
    if (applied.model !== want.model || applied.effort !== want.effort || applied.approvalMode !== want.approvalMode || qaApplied !== qa) {
      (state as DriverSlot & { qaSandbox?: boolean }).qaSandbox = qa;
      state.driver.settings = { approvalPolicy: CODEX_APPROVAL_POLICY[want.approvalMode], model: want.model, effort: want.effort, ...(qa ? { sandbox: "read-only" as const } : {}) };
      recorder?.push({ kind: "status", title: `Settings for the next turn: model ${want.model ?? "default"} · effort ${want.effort ?? "default"} · approvals ${want.approvalMode}` });
      Object.assign(applied, { model: want.model, effort: want.effort, approvalMode: want.approvalMode });
    }
  }

  // Q&A mode starting, or the person asked to interrupt ("interrupt and ask"), stops the running turn
  const snap = safeJsonParse<Record<string, unknown>>(slot.context_snapshot, {});
  const interruptAt = typeof snap.interrupt_at === "number" ? snap.interrupt_at : 0;
  const ext = state as DriverSlot & { qaInterrupted?: boolean; interruptSeen?: number };
  ext.interruptSeen ??= interruptAt; // requests from before this driver started are old
  const wantInterrupt = (qa && !ext.qaInterrupted) || interruptAt > ext.interruptSeen;
  ext.interruptSeen = Math.max(ext.interruptSeen, interruptAt);
  if (!qa) ext.qaInterrupted = false;
  if (wantInterrupt) {
    if (qa) ext.qaInterrupted = true;
    const running = state.kind === "claude" ? state.driver.busy : state.driver.activeTurnId !== null;
    if (running) {
      try {
        if (state.kind === "claude") await state.driver.interrupt();
        else await state.driver.interrupt(state.threadId ?? state.driver.threadId ?? "");
        recorder?.push({ kind: "status", title: qa ? "Q&A mode — the running turn was interrupted" : "Interrupted to answer the person" });
      } catch (err) {
        log(LOG_PREFIX, `Interrupt failed for slot ${slot.id}: ${err}`);
      }
    }
  }

  // Pausing stops the running turn too, not only the next delivery
  const paused = slot.paused === true || (slot.paused as unknown as number) === 1;
  if (!paused) {
    state.pauseInterrupted = false;
  } else if (!state.pauseInterrupted) {
    state.pauseInterrupted = true;
    const running = state.kind === "claude" ? state.driver.busy : state.driver.activeTurnId !== null;
    if (running) {
      try {
        if (state.kind === "claude") await state.driver.interrupt();
        else await state.driver.interrupt(state.threadId ?? state.driver.threadId ?? "");
        recorder?.push({ kind: "status", title: "Paused — the running turn was interrupted" });
      } catch (err) {
        log(LOG_PREFIX, `Interrupt on pause failed for slot ${slot.id}: ${err}`);
      }
    }
  }
}

/**
 * Enforce the session's usage limits: an agent over its limit (or any agent of
 * a session over the session limit) is paused, and its running turn stops.
 */
async function enforceUsageLimits(sessionId: string, brokerClient: BrokerClient): Promise<void> {
  const session = await brokerClient.getSession(sessionId);
  const limits = (safeJsonParse<Record<string, unknown>>(session.config, {}).limits ?? {}) as UsageLimits;
  const slots = await brokerClient.listSlots(sessionId);
  for (const slot of slots) {
    if (slot.task_state === "released") continue;
    const reason = limitVerdict(slot, slots, limits, slotSettings(slot).tokenLimit);
    const snapshot = safeJsonParse<Record<string, unknown>>(slot.context_snapshot, {});
    if (!reason) {
      if (snapshot.limit_hit) await brokerClient.updateSlot({ id: slot.id, context_patch: { limit_hit: null } });
      continue;
    }
    if (snapshot.limit_hit !== reason) await brokerClient.updateSlot({ id: slot.id, context_patch: { limit_hit: reason } });
    const paused = slot.paused === true || (slot.paused as unknown as number) === 1;
    if (paused) continue;
    log(LOG_PREFIX, `${slot.display_name ?? `Slot ${slot.id}`}: ${reason} — pausing`);
    await pauseAgent(sessionId, slot, brokerClient);
    const state = activeDrivers.get(sessionId, slot.id);
    if (state) {
      recorderOf(state)?.push({ kind: "error", title: `Stopped: ${reason}`, detail: "Raise the limit in the dashboard, then resume the agent." });
      try {
        if (state.kind === "claude") await state.driver.interrupt();
        else await state.driver.interrupt(state.threadId ?? state.driver.threadId ?? "");
      } catch { /* best effort */ }
    }
    pendingEvents.push({ type: "limit_reached", severity: "warning", slotId: slot.id, sessionId, message: `${slot.display_name ?? `Slot ${slot.id}`} paused: ${reason}` });
  }
}

/** A driver process ended: detach it, mark the slot disconnected, and respawn only if it was not released. */
function onDriverExit(sessionId: string, slotId: number, state: DriverSlot, code: number, brokerClient: BrokerClient): void {
  const replaced = !activeDrivers.detach(sessionId, slotId, state) && activeDrivers.has(sessionId, slotId);
  const procs = activeProcesses.get(sessionId);
  if (procs?.get(slotId) === state.driver.process) procs.delete(slotId);
  if (replaced) {
    log(LOG_PREFIX, `${state.kind} driver for slot ${slotId} exited (code ${code}) after being replaced — its slot is live`);
    return;
  }

  void (async () => {
    try {
      await brokerClient.updateSlot({ id: slotId, status: "disconnected" });
    } catch { /* broker may be down */ }

    if (await slotIsReleased(slotId, brokerClient)) {
      log(LOG_PREFIX, `${state.kind} driver for slot ${slotId} exited after release (code ${code})`);
      pendingEvents.push({ type: "agent_released", severity: "info", slotId, sessionId, message: `Slot ${slotId} exited after being released` });
      return;
    }
    handleEvent({
      type: code === 0 ? "agent_completed" : "agent_crashed",
      severity: code === 0 ? "info" : "critical",
      slotId,
      sessionId,
      message: `${state.kind} driver for slot ${slotId} exited with code ${code}`,
      data: { exit_code: code },
    });
  })();
}

// --- Dashboard auto-launch ---

const CLI_PATH = new URL("../cli.ts", import.meta.url).pathname;
// Tests and headless hosts run the orchestrator without terminal windows or a browser
const DASHBOARDS_DISABLED = process.env.MULTIAGENTS_NO_DASHBOARD === "1";

/**
 * Launch the TUI dashboard in a new terminal window.
 * Tries macOS Terminal.app first via `open`, falls back to detached process.
 */
function launchDashboard(sessionId: string, projectDir: string): void {
  if (DASHBOARDS_DISABLED || !runtimeOptions.launchDashboards) return;
  try {
    const platform = process.platform;
    if (platform === "darwin") {
      // macOS: open a new Terminal.app tab running the dashboard
      const script = `tell application "Terminal" to do script "cd ${projectDir} && bun ${CLI_PATH} dashboard ${sessionId}"`;
      Bun.spawn(["osascript", "-e", script], {
        stdio: ["ignore", "ignore", "ignore"],
      }).unref();
    } else if (platform === "linux") {
      // Linux: try common terminal emulators
      for (const term of ["gnome-terminal", "xterm", "konsole"]) {
        const which = Bun.spawnSync(["which", term], { env: { ...process.env, PATH: ENRICHED_PATH } });
        if (which.exitCode === 0) {
          Bun.spawn([term, "--", "bun", CLI_PATH, "dashboard", sessionId], {
            cwd: projectDir,
            stdio: ["ignore", "ignore", "ignore"],
          }).unref();
          break;
        }
      }
    }
    log(LOG_PREFIX, `Dashboard launched for session ${sessionId}`);
  } catch (e) {
    log(LOG_PREFIX, `Dashboard auto-launch failed (non-critical): ${e}`);
  }
}

const WEB_DASHBOARD_PATH = new URL("../dashboard/server.ts", import.meta.url).pathname;

/**
 * Launch the web dashboard as a background Bun process.
 * Auto-opens the browser on localhost:7900.
 */
function launchWebDashboard(sessionId: string, projectDir: string): void {
  if (DASHBOARDS_DISABLED || !runtimeOptions.launchDashboards) return;
  try {
    const proc = Bun.spawn(["bun", WEB_DASHBOARD_PATH, sessionId], {
      cwd: projectDir,
      env: { ...process.env, PATH: ENRICHED_PATH },
      stdio: ["ignore", "ignore", "ignore"],
    });
    proc.unref();
    log(LOG_PREFIX, `Web dashboard launched for session ${sessionId} (PID ${proc.pid})`);
  } catch (e) {
    log(LOG_PREFIX, `Web dashboard auto-launch failed (non-critical): ${e}`);
  }
}

// --- Broker lifecycle ---

/** Features this code relies on that the running broker lacks (it runs older code); [] when none or unknown. */
export async function missingBrokerFeatures(): Promise<string[]> {
  const health = await probeBrokerHealth(BROKER_URL);
  if (!health) return [];
  const have = new Set(health.features ?? []);
  return BROKER_FEATURES.filter((f) => !have.has(f));
}

/**
 * No agent uses the broker: no registered peer and no connected slot (driver-run
 * Codex agents have a connected slot but no peer row). Unknown counts as busy.
 */
export async function brokerIsIdle(brokerClient: BrokerClient): Promise<boolean> {
  try {
    const peers = await brokerClient.listPeers({ scope: "machine", cwd: process.cwd(), git_root: null });
    if (peers.length) return false;
    for (const s of await brokerClient.listSessions()) {
      if (s.status === "archived") continue;
      if ((await brokerClient.listSlots(s.id)).some((slot) => slot.status === "connected")) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Restart the broker on the code next to this file, leaving agents running.
 * A normal stop (SIGTERM) makes the broker kill every registered agent; a
 * restart instead asks it to just exit (SIGUSR2), or — for builds without that
 * — ends it outright (SIGKILL; SQLite in WAL mode loses nothing committed).
 * Agents' registrations, sessions and messages are in the database, so agents
 * carry on with the new broker on the same port after a moment.
 */
export async function restartBroker(brokerClient: BrokerClient): Promise<void> {
  const health = await probeBrokerHealth(BROKER_URL);
  if (health) {
    log(LOG_PREFIX, `Restarting the broker (pid ${health.pid ?? "?"}, ${health.peers} peer(s))`);
    if (health.pid !== undefined) {
      const graceful = process.platform !== "win32" && (health.features ?? []).includes("graceful-restart");
      process.kill(health.pid, graceful ? "SIGUSR2" : "SIGKILL");
    } else if (health.peers === 0) {
      stopBrokerProcess(health, resolveBrokerPort());
    } else {
      throw new Error("The broker does not report its pid; stop it with `multiagents broker stop` once its agents are done");
    }
    for (let i = 0; i < 50 && await brokerClient.isAlive(); i++) await Bun.sleep(100);
  }
  await ensureBroker(brokerClient);
}

export async function ensureBroker(brokerClient: BrokerClient): Promise<void> {
  if (await brokerClient.isAlive()) {
    log(LOG_PREFIX, "Broker already running");
    return;
  }

  log(LOG_PREFIX, "Starting broker daemon...");
  const brokerScript = new URL("../broker.ts", import.meta.url).pathname;
  const proc = Bun.spawn(["bun", brokerScript], {
    stdio: ["ignore", "ignore", "inherit"],
  });
  proc.unref();

  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 200));
    if (await brokerClient.isAlive()) {
      log(LOG_PREFIX, "Broker started");
      return;
    }
  }
  throw new Error("Failed to start broker daemon after 6 seconds");
}

// --- Event handler ---

function handleEvent(event: AgentEvent): void {
  log(LOG_PREFIX, `[${event.severity}] ${event.message}`);

  // Auto-respawn on crash (unless flapping or the slot was intentionally released)
  if (event.type === "agent_crashed" && event.data && !event.data.is_flapping) {
    respawnAfterCrash(event).catch((err) => log(LOG_PREFIX, `Crash handler error: ${err}`));
  } else if (event.type === "agent_completed" && event.data) {
    // Codex agents exit with code 0 when they finish their turn, but they may
    // not have actually completed their task. Check task_state — if the agent
    // hasn't signaled done (still "idle" or "addressing_feedback"), auto-respawn
    // with a continuation prompt so it picks up where it left off.
    const brokerClient = new BrokerClient(BROKER_URL);
    autoRestartIfIncomplete(event.slotId, event.sessionId, brokerClient)
      .then((restarted) => {
        if (!restarted) {
          pendingEvents.push(event);
        }
      })
      .catch((err) => {
        log(LOG_PREFIX, `Auto-restart check error: ${err}`);
        pendingEvents.push(event);
      });
  } else {
    pendingEvents.push(event);
  }
}

async function respawnAfterCrash(event: AgentEvent): Promise<void> {
  const sessionMeta = activeSessions.get(event.sessionId);
  if (!sessionMeta) return;
  const brokerClient = new BrokerClient(BROKER_URL);

  // A released slot exits on purpose (remove_agent, release_agent); respawning it
  // would create an unassigned ghost agent that then receives the team's traffic.
  if (await slotIsReleased(event.slotId, brokerClient)) {
    log(LOG_PREFIX, `Slot ${event.slotId} exited after being released — not respawning`);
    return;
  }

  const crashEvent = await handleAgentCrash(event.slotId, event.data!.exit_code as number, event.sessionId, brokerClient);
  pendingEvents.push(crashEvent);
  if (crashEvent.data?.is_flapping) return;

  try {
    const result = await respawnGuard.run(event.slotId, async () => {
      const { respawnAgent } = await import("./recovery.ts");
      const launched = await respawnAgent(event.sessionId, event.slotId, brokerClient, sessionMeta.projectDir);
      trackLaunch(event.sessionId, event.slotId, launched, brokerClient);
      return launched;
    });
    if (!result) {
      log(LOG_PREFIX, `Slot ${event.slotId} is already being respawned — skipping crash respawn`);
      return;
    }
    log(LOG_PREFIX, `Auto-respawned slot ${event.slotId} (PID ${result.pid}${result.codexDriver ? ", CodexDriver" : result.claudeDriver ? ", ClaudeDriver" : ""})`);
    pendingEvents.push({
      type: "agent_restarted",
      severity: "info",
      slotId: event.slotId,
      sessionId: event.sessionId,
      message: `Slot ${event.slotId} auto-respawned after crash (PID ${result.pid})`,
    });
  } catch (err) {
    log(LOG_PREFIX, `Failed to auto-respawn slot ${event.slotId}: ${err}`);
  }
}

/** Flap detection for code-0 auto-restarts (separate from crash flap detection). */
const completionRestartHistory: Map<number, number[]> = new Map();
const COMPLETION_RESTART_LIMIT = 3; // max code-0 restarts in FLAP_WINDOW_MS

/** Check if a completed agent actually finished its task; if not, respawn it. */
async function autoRestartIfIncomplete(
  slotId: number,
  sessionId: string,
  brokerClient: BrokerClient,
): Promise<boolean> {
  try {
    const taskInfo = await brokerClient.getTaskState(slotId);
    const state = taskInfo.task_state;
    const name = taskInfo.display_name ?? `Slot ${slotId}`;

    // Only restart if the agent hasn't completed its work
    // "working" = actively implementing (was incorrectly "in_progress" before)
    if (state === "idle" || state === "working" || state === "addressing_feedback") {
      // Flap detection for code-0 exits — prevent infinite restart loops
      const now = Date.now();
      const history = completionRestartHistory.get(slotId) ?? [];
      const recent = history.filter((t) => now - t < FLAP_WINDOW_MS);
      recent.push(now);
      completionRestartHistory.set(slotId, recent);

      if (recent.length >= COMPLETION_RESTART_LIMIT) {
        log(LOG_PREFIX, `${name} hit code-0 restart limit (${recent.length} in 5 min) — stopping auto-restart`);
        pendingEvents.push({
          type: "agent_flapping",
          severity: "critical",
          slotId,
          sessionId,
          message: `${name} keeps exiting without completing work (${recent.length} restarts). Stopped auto-restart. Investigate why the agent exits early.`,
        });
        return false;
      }

      log(LOG_PREFIX, `${name} exited with code 0 but task_state="${state}" — auto-restarting (${recent.length}/${COMPLETION_RESTART_LIMIT})`);

      const sessionMeta = activeSessions.get(sessionId);
      if (!sessionMeta) {
        log(LOG_PREFIX, `No session metadata for ${sessionId}, cannot restart`);
        return false;
      }

      const result = await respawnGuard.run(slotId, async () => {
        const { respawnAgent } = await import("./recovery.ts");
        const launched = await respawnAgent(sessionId, slotId, brokerClient, sessionMeta.projectDir);
        trackLaunch(sessionId, slotId, launched, brokerClient);
        return launched;
      });
      if (!result) {
        log(LOG_PREFIX, `${name} is already being respawned — skipping code-0 restart`);
        return true;
      }
      log(LOG_PREFIX, `Auto-restarted ${name} (PID ${result.pid}${result.codexDriver ? ", CodexDriver" : result.claudeDriver ? ", ClaudeDriver" : ""})`);

      pendingEvents.push({
        type: "agent_restarted",
        severity: "info",
        slotId,
        sessionId,
        message: `${name} auto-restarted (was task_state="${state}", exited code 0)`,
      });
      return true;
    }

    // Agent completed normally (done_pending_review, approved, released)
    if (state === "approved") {
      log(LOG_PREFIX, `${name} completed with task_state="approved" — keeping online in standby awaiting human review/release`);
      try {
        await brokerClient.updateSlot({ id: slotId, status: "connected" });
      } catch { /* ok */ }
      return false;
    }
    log(LOG_PREFIX, `${name} completed with task_state="${state}" — no restart needed`);
    return false;
  } catch (err) {
    log(LOG_PREFIX, `Failed to check task state for slot ${slotId}: ${err}`);
    return false;
  }
}

/** Track session metadata for restart purposes. */
const activeSessions: Map<string, { projectDir: string }> = new Map();

// --- Host options ---

export interface RuntimeOptions {
  /** Open the TUI and web dashboards after create_team / resume_session (the web host already is one). */
  launchDashboards: boolean;
  /** Recorded as the actor of releases and other lifecycle changes. */
  actor: string;
}

const runtimeOptions: RuntimeOptions = { launchDashboards: true, actor: "__orchestrator__" };

export function configureRuntime(opts: Partial<RuntimeOptions>): void {
  Object.assign(runtimeOptions, opts);
}

/** Whether this process launched (and so supervises) agents of the session. */
export function isManagedSession(sessionId: string): boolean {
  return activeProcesses.has(sessionId) || [...activeDrivers.sessionIds()].includes(sessionId);
}

/** Slot ids of the session whose agent process this process owns. */
export function managedSlotIds(sessionId: string): number[] {
  const ids = new Set<number>(activeProcesses.get(sessionId)?.keys() ?? []);
  for (const [sid, drivers] of activeDrivers.sessions()) {
    if (sid === sessionId) for (const slotId of drivers.keys()) ids.add(slotId);
  }
  return [...ids];
}

/** A human gate holds an all-approved session open until a person releases it. */
async function humanGateEnabled(sessionId: string, brokerClient: BrokerClient): Promise<boolean> {
  try {
    const session = await brokerClient.getSession(sessionId);
    return safeJsonParse<Record<string, unknown>>(session.config, {}).human_gate === true;
  } catch {
    return false;
  }
}

export interface ToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
  /** Structured outcome for programmatic hosts (the MCP host ignores it). */
  data?: Record<string, unknown>;
}

function fail(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

// --- Tool definitions ---

export const ORCHESTRATOR_TOOLS = [
  {
    name: "create_team",
    description: `Create a new multi-agent team session. Launches headless agents with assigned roles and file ownership. The project_dir will be created if it does not exist, and git will be initialized if needed.

IMPORTANT — For best results, provide detailed role_descriptions including platform/framework, expertise, and constraints. The richer the description, the better the agent performs.

Recommended team compositions:
- Feature development: Software Engineer + Code Reviewer + QA Engineer
- UI feature: UI/UX Designer + Software Engineer + Code Reviewer + QA Engineer
- Bug fix: Software Engineer + QA Engineer

Core roles: 'Software Engineer', 'UI/UX Designer', 'QA Engineer', 'Code Reviewer'
Prefix with platform: 'Android Software Engineer', 'Web QA Engineer', 'iOS UI/UX Designer'

Each agent receives role-specific best practices, tool discovery hints, and completion criteria automatically based on their role name and description. Agents communicate bidirectionally and loop until all parties approve.`,
    inputSchema: {
      type: "object" as const,
      properties: {
        project_dir: { type: "string", description: "Absolute path where agents will work. Will be created if it does not exist." },
        session_name: { type: "string", description: "Short name for this session. Used to generate session_id." },
        agents: {
          type: "array",
          items: {
            type: "object",
            properties: {
              agent_type: { type: "string", enum: ["claude", "codex", "gemini", "api"], description: "api = an OpenAI-compatible provider configured in the dashboard (DeepSeek, Qwen, …); set provider." },
              provider: { type: "string", description: "For agent_type api: the provider id (see the dashboard's API providers)." },
              name: { type: "string", description: "Display name for the agent, e.g., 'Alice' or 'Backend Engineer'" },
              role: { type: "string", description: "Core role: 'Software Engineer', 'UI/UX Designer', 'QA Engineer', 'Code Reviewer'. Prefix with platform for specificity: 'Android Software Engineer', 'Web QA Engineer'." },
              role_description: { type: "string", description: "Detailed role brief including platform (web/android/ios/cli/api), framework/stack, specific expertise, constraints, and acceptance criteria. The richer this is, the better the agent performs." },
              initial_task: { type: "string", description: "Specific task with acceptance criteria. Include what 'done' looks like, files to modify, APIs to use, and verification steps." },
              file_ownership: { type: "array", items: { type: "string" }, description: "Glob patterns for files this agent owns exclusively, e.g., 'src/auth/**'" },
              model: { type: "string", description: "Model for this agent, e.g. 'opus' / 'sonnet' (claude), 'gpt-5' (codex), 'gemini-2.5-pro' (gemini). Default: the CLI's default." },
              effort: { type: "string", description: "Reasoning effort: claude low|medium|high|xhigh|max, codex minimal|low|medium|high." },
              approval_mode: { type: "string", enum: ["bypass", "auto", "accept_edits", "ask"], description: "Who approves tool calls: bypass (never ask, default), auto (the CLI's reviewer; risky calls go to a person), accept_edits (edits pass, the rest asks), ask (a person approves every call). Gemini supports only bypass." },
            },
            required: ["agent_type", "name", "role", "role_description", "initial_task"],
          },
        },
        plan: {
          type: "array",
          description: "Plan items to track progress. Include review and QA tasks, not just implementation. Example: [{label: 'Implement auth API', agent_name: 'Engineer'}, {label: 'Review auth code', agent_name: 'Reviewer'}, {label: 'Test auth E2E', agent_name: 'QA'}]",
          items: {
            type: "object",
            properties: {
              label: { type: "string", description: "What needs to be done" },
              agent_name: { type: "string", description: "Name of the agent assigned to this item" },
            },
            required: ["label"],
          },
        },
        human_gate: { type: "boolean", description: "Hold the session open once every agent is approved, until a person releases it (no auto-end). Default false." },
      },
      required: ["project_dir", "session_name", "agents"],
    },
  },
  {
    name: "get_team_status",
    description: "Get current status of all agents in a multiagents session — their roles, connection state, task state (idle/working/done/addressing_feedback), and what they are working on. Use the session_id returned by create_team.",
    inputSchema: {
      type: "object" as const,
      properties: {
        session_id: { type: "string" },
      },
      required: ["session_id"],
    },
  },
  {
    name: "broadcast_to_team",
    description: "Send a message to ALL connected agents in a multiagents session. Use for requirement changes, priority shifts, or announcements that every team member must see.",
    inputSchema: {
      type: "object" as const,
      properties: {
        session_id: { type: "string" },
        message: { type: "string" },
        exclude_roles: { type: "array", items: { type: "string" } },
      },
      required: ["session_id", "message"],
    },
  },
  {
    name: "direct_agent",
    description: "Send a direct message to a specific agent by name, role, or slot ID. The agent receives this as a peer message and must respond.",
    inputSchema: {
      type: "object" as const,
      properties: {
        session_id: { type: "string" },
        target: { type: "string", description: "Agent name, role, or slot ID" },
        message: { type: "string" },
      },
      required: ["session_id", "target", "message"],
    },
  },
  {
    name: "add_agent",
    description: "Spawn and add a new agent to an existing multiagents session. The agent auto-connects to the broker, receives team context, and gets role-specific best practices injected automatically based on role name and description.",
    inputSchema: {
      type: "object" as const,
      properties: {
        session_id: { type: "string" },
        agent_type: { type: "string", enum: ["claude", "codex", "gemini", "api"], description: "api = an OpenAI-compatible provider configured in the dashboard (DeepSeek, Qwen, …); set provider." },
        provider: { type: "string", description: "For agent_type api: the provider id (see the dashboard's API providers)." },
        name: { type: "string", description: "Display name for the agent" },
        role: { type: "string", description: "Core role: 'Software Engineer', 'UI/UX Designer', 'QA Engineer', 'Code Reviewer'. Prefix with platform for specificity." },
        role_description: { type: "string", description: "Detailed role brief including platform, framework, expertise, constraints. The richer this is, the better the agent performs." },
        initial_task: { type: "string", description: "Specific task with acceptance criteria. Include what 'done' looks like." },
        file_ownership: { type: "array", items: { type: "string" }, description: "Glob patterns for files this agent owns exclusively" },
        model: { type: "string", description: "Model for this agent, e.g. 'opus' / 'sonnet' (claude), 'gpt-5' (codex), 'gemini-2.5-pro' (gemini). Default: the CLI's default." },
        effort: { type: "string", description: "Reasoning effort: claude low|medium|high|xhigh|max, codex minimal|low|medium|high." },
        approval_mode: { type: "string", enum: ["bypass", "auto", "accept_edits", "ask"], description: "Who approves tool calls: bypass (never ask, default), auto (the CLI's reviewer; risky calls go to a person), accept_edits (edits pass, the rest asks), ask (a person approves every call). Gemini supports only bypass." },
      },
      required: ["session_id", "agent_type", "name", "role", "role_description", "initial_task"],
    },
  },
  {
    name: "remove_agent",
    description: "Gracefully stop and remove an agent from the session. Kills the CLI process and marks the slot as disconnected.",
    inputSchema: {
      type: "object" as const,
      properties: {
        session_id: { type: "string" },
        target: { type: "string", description: "Agent name, role, or slot ID" },
      },
      required: ["session_id", "target"],
    },
  },
  {
    name: "control_session",
    description: "Control a multiagents session. Actions: pause_all (pause every agent), resume_all (resume every agent), pause_agent (pause one by name/role), resume_agent (resume one), extend_budget (add minutes to time limit), set_budget (set exact time limit), status (get control state).",
    inputSchema: {
      type: "object" as const,
      properties: {
        session_id: { type: "string" },
        action: { type: "string", enum: ["pause_all", "resume_all", "pause_agent", "resume_agent", "extend_budget", "set_budget", "status"] },
        target: { type: "string", description: "Agent name/role/slot for agent-level actions, or guardrail_id for set_budget" },
        value: { type: "number", description: "New value for budget actions" },
      },
      required: ["session_id", "action"],
    },
  },
  {
    name: "adjust_guardrail",
    description: "View or update multiagents session guardrail limits (e.g. max restarts per agent). Use action='view' to see all guardrails, action='update' to change one.",
    inputSchema: {
      type: "object" as const,
      properties: {
        session_id: { type: "string" },
        action: { type: "string", enum: ["view", "update"] },
        guardrail_id: { type: "string" },
        new_value: { type: "number" },
      },
      required: ["session_id", "action"],
    },
  },
  {
    name: "get_session_log",
    description: "Get the inter-agent message history for a multiagents session. Returns timestamped messages between agents with sender/recipient info.",
    inputSchema: {
      type: "object" as const,
      properties: {
        session_id: { type: "string" },
        limit: { type: "number" },
        since: { type: "number", description: "Epoch ms timestamp to get messages after" },
      },
      required: ["session_id"],
    },
  },
  {
    name: "release_agent",
    description: "Release a specific agent from the multiagents session, allowing it to disconnect. Only use after their work is approved and complete. Agents cannot self-disconnect — only the orchestrator can release them.",
    inputSchema: {
      type: "object" as const,
      properties: {
        session_id: { type: "string" },
        target: { type: "string", description: "Agent name, role, or slot ID" },
        message: { type: "string", description: "Optional release message" },
      },
      required: ["session_id", "target"],
    },
  },
  {
    name: "release_all",
    description: "Release ALL agents in a multiagents session, allowing them to disconnect. Use when the entire team's work is complete and production-grade.",
    inputSchema: {
      type: "object" as const,
      properties: {
        session_id: { type: "string" },
        message: { type: "string", description: "Optional release message" },
        approved_only: { type: "boolean", description: "Release only agents whose task_state is approved. Default false." },
      },
      required: ["session_id"],
    },
  },
  {
    name: "end_session",
    description: "End a multiagents session: releases and stops all agents, archives the session. Use when the project is complete.",
    inputSchema: {
      type: "object" as const,
      properties: {
        session_id: { type: "string" },
        create_pr: { type: "boolean" },
      },
      required: ["session_id"],
    },
  },
  {
    name: "cleanup_dead_slots",
    description: "Remove disconnected/dead slots from a session that will never reconnect. Useful when crashed agents left stale slots behind.",
    inputSchema: {
      type: "object" as const,
      properties: {
        session_id: { type: "string" },
        keep_released: { type: "boolean", description: "If true, keep slots in 'released' state (default: false — removes all non-connected)" },
      },
      required: ["session_id"],
    },
  },
  {
    name: "list_sessions",
    description: "List all multiagents sessions (active, paused, archived). Use to discover sessions from previous conversations that can be resumed with resume_session.",
    inputSchema: {
      type: "object" as const,
      properties: {
        status_filter: { type: "string", enum: ["all", "active", "paused", "archived"], description: "Filter by session status. Default: all" },
      },
    },
  },
  {
    name: "resume_session",
    description: "Resume a previously paused or stopped multiagents session. Respawns all disconnected agents with their previous role, context, message history, and plan items. Use list_sessions first to find the session_id.",
    inputSchema: {
      type: "object" as const,
      properties: {
        session_id: { type: "string", description: "Session ID to resume (from list_sessions)" },
        agents_to_skip: { type: "array", items: { type: "string" }, description: "Agent names or roles to NOT respawn (optional)" },
      },
      required: ["session_id"],
    },
  },
  {
    name: "delete_session",
    description: "Permanently delete a multiagents session and all its data (slots, messages, plans, file locks). Use when a session is no longer needed. Kills any running agents first. Cannot be undone.",
    inputSchema: {
      type: "object" as const,
      properties: {
        session_id: { type: "string", description: "Session ID to delete (from list_sessions)" },
      },
      required: ["session_id"],
    },
  },
  {
    name: "get_guide",
    description: "Get comprehensive documentation and guidance for using multiagents. Call with no topic to see all available topics. Topics: overview, quickstart, roles, workflows, tools, session_lifecycle, troubleshooting, examples, best_practices. Start with 'quickstart' for a step-by-step tutorial.",
    inputSchema: {
      type: "object" as const,
      properties: {
        topic: { type: "string", enum: ["overview", "quickstart", "roles", "workflows", "tools", "session_lifecycle", "troubleshooting", "examples", "best_practices"], description: "Guide topic to read. Omit to see the topic list." },
      },
    },
  },
];

// --- Tool implementations ---

export async function callOrchestratorTool(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  const brokerClient = new BrokerClient(BROKER_URL);

  try {
    switch (name) {
      // ---- create_team ----
      case "create_team": {
        const { project_dir, session_name, agents, plan: planItems, human_gate } = args as {
          project_dir: string;
          session_name: string;
          agents: AgentLaunchConfig[];
          plan?: { label: string; agent_name?: string }[];
          human_gate?: boolean;
        };

        // Detect available agents — check ALL before failing, report what IS available
        const unavailable: { name: string; type: string }[] = [];
        const availableTypes = new Set<string>();
        for (const agentCfg of agents) {
          const detection = await detectAgent(agentCfg.agent_type);
          if (!detection.available) {
            unavailable.push({ name: agentCfg.name, type: agentCfg.agent_type });
          } else {
            availableTypes.add(agentCfg.agent_type);
          }
        }
        if (unavailable.length > 0) {
          // Check what IS available on this machine
          const allTypes: Array<"claude" | "codex" | "gemini" | "api"> = ["claude", "codex", "gemini", "api"];
          for (const t of allTypes) {
            const d = await detectAgent(t);
            if (d.available) availableTypes.add(t);
          }
          const availableList = availableTypes.size > 0
            ? `Available agent CLIs on this machine: ${[...availableTypes].join(", ")}.`
            : "No agent CLIs found. Install claude, codex, or gemini CLI first.";
          const failedList = unavailable.map(u => `${u.name} (${u.type})`).join(", ");
          return fail(`Cannot create team — the following agent CLIs are not installed: ${failedList}.\n\n${availableList}\n\nPlease adjust your team to only use available agent types, or install the missing CLIs.`);
        }

        // Generate unique session ID — check existing sessions to avoid collisions
        let existingIds: string[] = [];
        try {
          existingIds = (await brokerClient.listSessions()).map((s) => s.id);
        } catch { /* broker may not support list yet — proceed with base slug */ }
        const sessionId = uniqueSessionId(session_name, existingIds);

        // Auto-create project directory if it doesn't exist
        if (!fs.existsSync(project_dir)) {
          fs.mkdirSync(project_dir, { recursive: true });
        }

        // Init git if not already a repo (needed for file coordination, but session works without it)
        let gitRoot = await getGitRoot(project_dir);
        if (!gitRoot) {
          try {
            const initProc = Bun.spawnSync(["git", "init"], { cwd: project_dir });
            if (initProc.exitCode === 0) {
              gitRoot = project_dir;
            }
          } catch { /* git not installed — session still works without it */ }
        }

        // Create session in broker
        await brokerClient.createSession({
          id: sessionId,
          name: session_name,
          project_dir,
          git_root: gitRoot,
          ...(human_gate ? { config: { human_gate: true } } : {}),
        });

        const sessionProcs = new Map<number, Subprocess>();
        activeProcesses.set(sessionId, sessionProcs);
        activeSessions.set(sessionId, { projectDir: project_dir });

        // Launch each agent with staggered delays to prevent race conditions.
        // Codex agents share a global skills directory (~/.codex/system-skills/)
        // that gets corrupted when multiple instances initialize simultaneously.
        // Gemini via npx can also race on package caching.
        const launchedAgents: { name: string; slot_id: number; pid: number }[] = [];
        const launchedTypes = new Set<string>();
        for (const agentCfg of agents) {
          // Stagger if we've already launched an agent of this type
          if (launchedTypes.has(agentCfg.agent_type)) {
            await new Promise((r) => setTimeout(r, 3000));
          }
          launchedTypes.add(agentCfg.agent_type);

          const result = await launchAgent(sessionId, project_dir, agentCfg, brokerClient);
          trackLaunch(sessionId, result.slotId, result, brokerClient);

          // Announce to previously launched agents
          const slot = await brokerClient.getSlot(result.slotId);
          await announceNewMember(sessionId, slot, agentCfg, brokerClient);

          launchedAgents.push({
            name: agentCfg.name,
            slot_id: result.slotId,
            pid: result.pid,
          });
        }

        // Create plan if provided, then broadcast to each agent with their assigned items
        let planSummary = "";
        if (planItems && planItems.length > 0) {
          const slotByName = new Map(launchedAgents.map((a) => [a.name, a.slot_id]));
          const lastAgentSlot = launchedAgents[launchedAgents.length - 1]?.slot_id;

          // Every plan item MUST have an assignee — unassigned items go to
          // the last agent in the list (responsible for final verification)
          const items = planItems.map((item) => {
            const resolved = item.agent_name ? slotByName.get(item.agent_name) : undefined;
            return {
              label: item.label,
              assigned_to_slot: resolved ?? lastAgentSlot,
            };
          });
          await brokerClient.createPlan({
            session_id: sessionId,
            title: session_name,
            items,
          });

          // Fetch the created plan to get actual item IDs
          const plan = await brokerClient.getPlan(sessionId);
          if (plan?.items) {
            // Send each agent their personalized plan context
            for (const agent of launchedAgents) {
              const myItems = plan.items.filter((i: any) => i.assigned_to_slot === agent.slot_id);
              if (myItems.length === 0) continue;

              const slot = await brokerClient.getSlot(agent.slot_id);
              if (!slot?.peer_id) continue;

              const itemLines = myItems.map((i: any) =>
                `  [ ] #${i.id}: ${i.label}`
              ).join("\n");

              await brokerClient.sendMessage({
                from_id: "orchestrator",
                to_id: slot.peer_id,
                text: `PLAN — Your assigned items:\n${itemLines}\n\nAs you complete each item, call: update_plan({item_id: <ID>, status: "done"}).\nCall get_plan to see the full plan anytime.`,
                msg_type: "system",
                session_id: sessionId,
              });
            }
          }

          planSummary = `\nPlan: ${planItems.length} items tracked.`;
        }

        const status = await getTeamStatus(sessionId, brokerClient);
        const display = formatTeamStatusForDisplay(status);

        // Auto-launch dashboards (TUI in terminal + web in browser)
        launchDashboard(sessionId, project_dir);
        launchWebDashboard(sessionId, project_dir);

        return {
          content: [{
            type: "text",
            text: [
              `Session "${sessionId}" created with ${launchedAgents.length} agents.${planSummary}`,
              "",
              display,
              "",
              "IMPORTANT: Agents take 15-60 seconds to start up (loading MCP servers, connecting to broker).",
              "They will show as 'starting' until they register. This is NORMAL — do NOT call cleanup_dead_slots",
              "or assume agents have crashed. Wait at least 60 seconds before checking status.",
              "",
              `Dashboard launched — run \`multiagents dashboard ${sessionId}\` to reopen.`,
            ].join("\n"),
          }],
          data: { session_id: sessionId, agents: launchedAgents },
        };
      }

      // ---- get_team_status ----
      case "get_team_status": {
        const { session_id } = args as { session_id: string };
        const status = await getTeamStatus(session_id, brokerClient);
        const display = formatTeamStatusForDisplay(status);

        // Include any pending events
        const events = pendingEvents.splice(0, pendingEvents.length);
        const eventText = events.length > 0
          ? "\n\nRecent events:\n" + events.map((e) => `[${e.severity}] ${e.message}`).join("\n")
          : "";

        // Check for BLOCKED messages from agents to orchestrator
        let blockedText = "";
        try {
          const recentMsgs = await brokerClient.getMessageLog(session_id, { limit: 50 });
          const blockedMsgs = recentMsgs.filter((m: any) =>
            m.to_id === "orchestrator" && m.text && /BLOCKED|NEED HELP|ESCALAT/i.test(m.text)
          );
          if (blockedMsgs.length > 0) {
            blockedText = "\n\nBLOCKED AGENTS (need your help):\n" +
              blockedMsgs.slice(0, 5).map((m: any) => {
                const fromSlot = status.agents.find((a) => a.slot_id === m.from_slot_id);
                const fromName = fromSlot?.name ?? m.from_id;
                return `  [!] ${fromName}: ${m.text.slice(0, 200)}`;
              }).join("\n");
          }
        } catch { /* best effort */ }

        // Completion check: all agents approved → suggest releasing
        let completionText = "";
        const connectedAgents = status.agents.filter((a) => a.status === "connected");
        const allApproved = connectedAgents.length > 0 && connectedAgents.every((a) => a.task_state === "approved");
        const allDoneOrApproved = connectedAgents.length > 0 && connectedAgents.every((a) =>
          a.task_state === "approved" || a.task_state === "released"
        );
        if (allApproved) {
          completionText = "\n\nALL AGENTS APPROVED — Team work is complete. You can now call release_all to release all agents, or end_session to archive the session.";
        } else if (!allDoneOrApproved && connectedAgents.length > 0) {
          const needsWork = connectedAgents.filter((a) => a.task_state !== "approved" && a.task_state !== "released");
          completionText = `\n\nCompletion: ${connectedAgents.length - needsWork.length}/${connectedAgents.length} agents approved. Still working: ${needsWork.map((a) => `${a.name} (${a.task_state})`).join(", ")}`;
        }

        return { content: [{ type: "text", text: display + eventText + blockedText + completionText }] };
      }

      // ---- broadcast_to_team ----
      case "broadcast_to_team": {
        const { session_id, message, exclude_roles } = args as {
          session_id: string;
          message: string;
          exclude_roles?: string[];
        };
        const result = await broadcastToTeam(session_id, message, brokerClient, exclude_roles);
        return { content: [{ type: "text", text: `Broadcast delivered to ${result.delivered_to} agents.` }] };
      }

      // ---- direct_agent ----
      case "direct_agent": {
        const { session_id, target, message } = args as {
          session_id: string;
          target: string;
          message: string;
        };
        const slot = await resolveTarget(session_id, target, brokerClient);
        if (!slot || !slot.peer_id) {
          return fail(`Could not find connected agent matching "${target}".`);
        }

        await brokerClient.sendMessage({
          from_id: "orchestrator",
          to_id: slot.peer_id,
          text: message,
          msg_type: "chat",
          session_id,
        });

        return { content: [{ type: "text", text: `Message sent to ${slot.display_name ?? `slot ${slot.id}`}.` }] };
      }

      // ---- add_agent ----
      case "add_agent": {
        const { session_id, agent_type, name: agentName, role, role_description, initial_task, file_ownership, model, effort, approval_mode, provider } = args as {
          session_id: string;
          agent_type: "claude" | "codex" | "gemini" | "api";
          provider?: string;
          name: string;
          role: string;
          role_description: string;
          initial_task: string;
          file_ownership?: string[];
          model?: string;
          effort?: string;
          approval_mode?: AgentLaunchConfig["approval_mode"];
        };

        const detection = await detectAgent(agent_type);
        if (!detection.available) {
          return fail(agent_type === "api" ? "Error: no API provider is configured — add one in the dashboard (API providers)." : `Error: ${agent_type} CLI not found.`);
        }

        const session = await brokerClient.getSession(session_id);
        const config: AgentLaunchConfig = {
          agent_type,
          name: agentName,
          role,
          role_description,
          initial_task,
          file_ownership,
          model,
          effort,
          approval_mode,
          provider,
        };

        const result = await launchAgent(session_id, session.project_dir, config, brokerClient);
        if (!activeSessions.has(session_id)) {
          activeSessions.set(session_id, { projectDir: session.project_dir });
        }
        trackLaunch(session_id, result.slotId, result, brokerClient);

        const slot = await brokerClient.getSlot(result.slotId);
        await announceNewMember(session_id, slot, config, brokerClient);

        return {
          content: [{
            type: "text",
            text: `Added ${agentName} (${agent_type}) as ${role} in slot ${result.slotId} (PID ${result.pid}).`,
          }],
          data: { slot_id: result.slotId, pid: result.pid },
        };
      }

      // ---- remove_agent ----
      case "remove_agent": {
        const { session_id, target } = args as { session_id: string; target: string };
        const slot = await resolveTarget(session_id, target, brokerClient);
        if (!slot) {
          return fail(`Could not find agent matching "${target}".`);
        }

        // Release BEFORE stopping, so the exit handlers see "released" and skip auto-respawn
        await brokerClient.updateSlot({ id: slot.id, status: "disconnected", task_state: "released" });

        const driverState = activeDrivers.delete(session_id, slot.id);
        if (driverState) {
          await closeDriver(driverState);
        }
        const sessionProcs = activeProcesses.get(session_id);
        const proc = sessionProcs?.get(slot.id);
        if (proc) {
          try { proc.kill(); } catch { /* already dead */ }
          sessionProcs!.delete(slot.id);
        }
        clearSlotTracking(slot.id);
        completionRestartHistory.delete(slot.id);

        // Notify remaining team
        const slots = await brokerClient.listSlots(session_id);
        for (const s of slots) {
          if (s.id !== slot.id && s.status === "connected" && s.peer_id) {
            await brokerClient.sendMessage({
              from_id: "orchestrator",
              to_id: s.peer_id,
              text: `[Team Update] ${slot.display_name ?? `Agent #${slot.id}`} (${slot.role ?? "unassigned"}) has been removed from the team.`,
              msg_type: "team_change",
              session_id,
            });
          }
        }

        return { content: [{ type: "text", text: `Removed ${slot.display_name ?? `slot ${slot.id}`} from the session.` }] };
      }

      // ---- control_session ----
      case "control_session": {
        const { session_id, action, target, value } = args as {
          session_id: string;
          action: string;
          target?: string;
          value?: number;
        };
        const result = await controlSession(session_id, action, brokerClient, target, value);
        return { content: [{ type: "text", text: result.message }], ...(result.status === "error" ? { isError: true } : {}) };
      }

      // ---- adjust_guardrail ----
      case "adjust_guardrail": {
        const { session_id, action, guardrail_id, new_value } = args as {
          session_id: string;
          action: "view" | "update";
          guardrail_id?: string;
          new_value?: number;
        };

        if (action === "view") {
          const checks = await checkGuardrails(session_id, brokerClient);
          const lines = checks.map((c) => {
            const icon = c.status === "triggered" ? "[!]" : c.status === "warning" ? "[?]" : "[ok]";
            return `${icon} ${c.message}`;
          });
          return { content: [{ type: "text", text: lines.join("\n") }] };
        }

        if (action === "update") {
          if (!guardrail_id || new_value === undefined) {
            return fail("guardrail_id and new_value required for update.");
          }
          const updated = await brokerClient.updateGuardrail({
            session_id,
            guardrail_id,
            new_value,
            changed_by: "orchestrator",
          });
          return { content: [{ type: "text", text: `Updated ${guardrail_id} to ${new_value} ${updated.unit}.` }] };
        }

        return fail(`Unknown guardrail action: ${action}`);
      }

      // ---- get_session_log ----
      case "get_session_log": {
        const { session_id, limit, since } = args as {
          session_id: string;
          limit?: number;
          since?: number;
        };
        const messages = await brokerClient.getMessageLog(session_id, { limit: limit ?? 50, since });
        const lines = messages.map((m) => {
          const from = m.from_slot_id !== null ? `slot ${m.from_slot_id}` : m.from_id;
          const to = m.to_slot_id !== null ? `slot ${m.to_slot_id}` : m.to_id;
          return `[${m.sent_at}] ${from} -> ${to} (${m.msg_type}): ${m.text.slice(0, 200)}`;
        });
        return { content: [{ type: "text", text: lines.length > 0 ? lines.join("\n") : "No messages found." }] };
      }

      // ---- release_agent ----
      case "release_agent": {
        const { session_id, target, message } = args as { session_id: string; target: string; message?: string };
        const slot = await resolveTarget(session_id, target, brokerClient);
        if (!slot) {
          const slots = await brokerClient.listSlots(session_id);
          return fail(`Agent "${target}" not found. Available: ${slots.map(s => s.display_name || s.role || s.id).join(", ")}`);
        }
        const result = await brokerClient.releaseAgent({
          session_id,
          target_slot_id: slot.id,
          released_by: runtimeOptions.actor,
          message,
        });
        return {
          content: [{ type: "text", text: `Released ${slot.display_name || slot.role || slot.id}. Task state: ${result.task_state}. Agent can now disconnect.` }],
        };
      }

      // ---- release_all ----
      case "release_all": {
        const { session_id, message, approved_only } = args as { session_id: string; message?: string; approved_only?: boolean };
        const slots = await brokerClient.listSlots(session_id);

        // Warn if not all agents are approved
        const connectedSlots = slots.filter((s) => s.status === "connected");
        const notApproved = connectedSlots.filter((s) =>
          s.task_state !== "approved" && s.task_state !== "released"
        );
        if (notApproved.length > 0 && !approved_only) {
          const warning = `WARNING: ${notApproved.length} agent(s) not yet approved: ${notApproved.map((s) => `${s.display_name || s.role || s.id} (${s.task_state || "idle"})`).join(", ")}. Releasing anyway as requested.`;
          log(LOG_PREFIX, warning);
          // Still proceed — orchestrator explicitly asked to release
        }

        let released = 0;
        for (const slot of slots) {
          const releasable = approved_only
            ? slot.task_state === "approved"
            : slot.task_state !== "released" && slot.task_state !== "idle";
          if (releasable) {
            await brokerClient.releaseAgent({
              session_id,
              target_slot_id: slot.id,
              released_by: runtimeOptions.actor,
              message: message || "All agents released. Session complete.",
            });
            released++;
          }
        }
        return {
          content: [{ type: "text", text: approved_only
            ? `Released ${released} approved agent(s).`
            : `Released ${released} agent(s). All agents can now disconnect.` }],
          data: { released },
        };
      }

      // ---- cleanup_dead_slots ----
      case "cleanup_dead_slots": {
        const { session_id, keep_released } = args as { session_id: string; keep_released?: boolean };
        const slots = await brokerClient.listSlots(session_id);
        let removed = 0;
        const removedNames: string[] = [];

        const now = Date.now();
        let skippedStarting = 0;

        for (const slot of slots) {
          const isDead = slot.status === "disconnected" && slot.task_state !== "released";
          const isReleased = slot.task_state === "released";
          const shouldRemove = isDead || (isReleased && !keep_released);

          // SAFETY: Never clean up slots that are still starting up.
          // A slot that has never been connected (last_connected is null) is still
          // booting its MCP server. Deleting it destroys the session.
          if (shouldRemove && isDead && !slot.last_connected) {
            skippedStarting++;
            continue; // Still starting — don't delete
          }
          // Also skip slots that were recently connected (within 2 min) — might be restarting
          if (shouldRemove && isDead && slot.last_disconnected && (now - slot.last_disconnected < 120_000)) {
            skippedStarting++;
            continue;
          }

          if (shouldRemove) {
            // Delete the slot from the broker DB
            await brokerClient.deleteSlot(slot.id);
            removedNames.push(slot.display_name || slot.role || `slot-${slot.id}`);
            removed++;

            // Also remove from active process tracking
            const sessionProcs = activeProcesses.get(session_id);
            if (sessionProcs) {
              const proc = sessionProcs.get(slot.id);
              if (proc) {
                try { proc.kill(); } catch { /* already dead */ }
                sessionProcs.delete(slot.id);
              }
            }
          }
        }

        const startingNote = skippedStarting > 0
          ? `\nSkipped ${skippedStarting} slot(s) still starting up — these agents are booting and will connect shortly. Do NOT clean them up.`
          : "";
        return {
          content: [{
            type: "text",
            text: (removed > 0
              ? `Cleaned up ${removed} dead slot(s): ${removedNames.join(", ")}`
              : `No dead slots found. All ${slots.length} slot(s) are active.`) + startingNote,
          }],
        };
      }

      // ---- end_session ----
      case "end_session": {
        const { session_id, create_pr } = args as { session_id: string; create_pr?: boolean };

        stopSession(session_id);

        // Clean driver-mode sentinel file
        try {
          const session = await brokerClient.getSession(session_id);
          const sentinelPath = require("node:path").join(session.project_dir, ".multiagents", ".driver-mode");
          require("node:fs").unlinkSync(sentinelPath);
        } catch { /* ok */ }

        // Mark all slots as disconnected
        const slots = await brokerClient.listSlots(session_id);
        for (const slot of slots) {
          if (slot.status === "connected") {
            await brokerClient.updateSlot({ id: slot.id, status: "disconnected" });
          }
        }

        // Archive session
        await brokerClient.updateSession({
          id: session_id,
          status: "archived",
        });

        // Clean up per-slot tracking state (memory leak prevention)
        for (const slot of slots) {
          clearSlotTracking(slot.id);
          completionRestartHistory.delete(slot.id);
        }
        clearAllCrashHistory();

        let prMessage = "";
        if (create_pr) {
          prMessage = "\nNote: PR creation should be done by running `gh pr create` in the project directory.";
        }

        return {
          content: [{
            type: "text",
            text: `Session "${session_id}" ended. ${slots.length} agents stopped. Session archived.${prMessage}`,
          }],
        };
      }

      // ---- delete_session ----
      case "delete_session": {
        const { session_id } = args as { session_id: string };

        stopSession(session_id);

        // Clean up per-slot tracking state (memory leak prevention)
        clearAllTracking();
        clearAllCrashHistory();
        completionRestartHistory.clear();

        const result = await brokerClient.deleteSession(session_id);
        if (!result.ok) {
          return fail(`Session "${session_id}" not found.`);
        }

        return {
          content: [{
            type: "text",
            text: `Session "${session_id}" permanently deleted. Removed: ${result.deleted.slots} slot(s), ${result.deleted.messages} message(s), ${result.deleted.plans} plan(s).`,
          }],
        };
      }

      // ---- list_sessions ----
      case "list_sessions": {
        const { status_filter } = args as { status_filter?: string };
        const allSessions = await brokerClient.listSessions();

        // Filter by status
        const filtered = status_filter && status_filter !== "all"
          ? allSessions.filter((s: any) => s.status === status_filter)
          : allSessions;

        if (filtered.length === 0) {
          return { content: [{ type: "text", text: `No sessions found${status_filter ? ` with status "${status_filter}"` : ""}.` }] };
        }

        // Enrich each session with slot counts and plan progress
        const lines: string[] = ["=== Multiagents Sessions ===", ""];
        for (const session of filtered) {
          const sid = (session as any).id;
          let slotInfo = "";
          let planInfo = "";
          try {
            const slots = await brokerClient.listSlots(sid);
            const connected = slots.filter((s: any) => s.status === "connected").length;
            const disconnected = slots.filter((s: any) => s.status === "disconnected").length;
            slotInfo = ` | Agents: ${connected} online, ${disconnected} disconnected (${slots.length} total)`;

            // Plan progress
            const plan = await brokerClient.getPlan(sid);
            if (plan?.items && plan.items.length > 0) {
              const done = plan.items.filter((i: any) => i.status === "done").length;
              planInfo = ` | Plan: ${done}/${plan.items.length} done`;
            }
          } catch { /* best effort */ }

          const elapsed = Date.now() - ((session as any).created_at ?? 0);
          const isManaged = activeProcesses.has(sid) ? " [MANAGED]" : "";
          lines.push(`  ${sid}`);
          lines.push(`    Name: ${(session as any).name} | Status: ${(session as any).status}${isManaged} | Elapsed: ${formatDuration(elapsed)}`);
          lines.push(`    Dir: ${(session as any).project_dir}${slotInfo}${planInfo}`);
          lines.push("");
        }

        lines.push(`${filtered.length} session(s) found. Use resume_session to restart a paused/stopped session.`);

        return { content: [{ type: "text", text: lines.join("\n") }] };
      }

      // ---- resume_session ----
      case "resume_session": {
        const { session_id, agents_to_skip } = args as { session_id: string; agents_to_skip?: string[] };
        const skipSet = new Set((agents_to_skip ?? []).map(s => s.toLowerCase()));

        // Get session
        const session = await brokerClient.getSession(session_id);
        if (!session) {
          return fail(`Session "${session_id}" not found.`);
        }

        // Update session status to active
        await brokerClient.updateSession({
          id: session_id,
          status: "active",
          pause_reason: null,
          paused_at: null,
        });

        // Get all slots
        const slots = await brokerClient.listSlots(session_id);
        // A slot whose driver this orchestrator still runs is not respawned on top of it,
        // even if the broker lost track of its peer.
        const disconnected = slots.filter((s: any) =>
          s.status === "disconnected" &&
          s.task_state !== "released" &&
          !activeDrivers.isLive(session_id, s.id) &&
          !skipSet.has((s.display_name ?? "").toLowerCase()) &&
          !skipSet.has((s.role ?? "").toLowerCase())
        );

        if (disconnected.length === 0) {
          // Track session even if no agents to respawn (for monitoring loops)
          activeSessions.set(session_id, { projectDir: session.project_dir });
          if (!activeProcesses.has(session_id)) {
            activeProcesses.set(session_id, new Map());
          }
          return { content: [{ type: "text", text: `Session "${session_id}" resumed (status → active). No disconnected agents to respawn. ${slots.filter((s: any) => s.status === "connected").length} agent(s) already online.` }] };
        }

        // Respawn each disconnected agent with rich handoff context
        const respawned: string[] = [];
        const failed: string[] = [];
        const resumeLaunchedTypes = new Set<string>();

        for (const slot of disconnected) {
          try {
            // Detect agent CLI availability
            const detection = await detectAgent(slot.agent_type);
            if (!detection.available) {
              failed.push(`${slot.display_name || slot.role || slot.id} (${slot.agent_type} CLI not found)`);
              continue;
            }

            // Build rich handoff prompt
            const snapshot = safeJsonParse<Record<string, any>>(slot.context_snapshot, {});

            // Get message recap for this slot
            let recapLines: string[] = [];
            try {
              const messages = await brokerClient.getMessageLog(session_id, { limit: 30, with_slot: slot.id });
              recapLines = messages.map((m: any) =>
                `[${m.msg_type}] ${m.from_id}: ${(m.text ?? "").slice(0, 200)}`
              );
            } catch { /* ok */ }

            // Get plan items assigned to this slot
            let planItemLines: string[] = [];
            try {
              const plan = await brokerClient.getPlan(session_id);
              if (plan?.items) {
                const myItems = plan.items.filter((i: any) => i.assigned_to_slot === slot.id);
                planItemLines = myItems.map((i: any) => {
                  const marker = i.status === "done" ? "[x]" : i.status === "in_progress" ? "[~]" : "[ ]";
                  return `  ${marker} ${i.label}`;
                });
              }
            } catch { /* ok */ }

            // Build team context
            const teamContext = await buildTeamContext(session_id, slot.id, brokerClient);

            const handoffParts = [
              "SESSION RESUMED — You are being restarted to continue a previous session.",
              "",
              `Your role: ${slot.role ?? "unassigned"}`,
              slot.role_description ? `Role description: ${slot.role_description}` : "",
              snapshot.last_summary ? `Your last status: ${snapshot.last_summary}` : "",
              snapshot.task_state ? `Your task state when you left: ${snapshot.task_state}` : "",
              "",
              teamContext,
            ];

            if (planItemLines.length > 0) {
              handoffParts.push("", "Your assigned plan items:");
              handoffParts.push(...planItemLines);
            }

            if (recapLines.length > 0) {
              handoffParts.push("", "Recent message history (most recent last):");
              handoffParts.push(...recapLines);
            }

            handoffParts.push(
              "",
              "INSTRUCTIONS:",
              "1. Read the current state of the codebase — files may have changed since you disconnected.",
              "2. Call check_team_status to see who else is online and what state they are in.",
              "3. Call get_plan to see overall progress.",
              "4. Resume your work from where you left off. If your task_state was 'addressing_feedback', check for unresolved feedback first.",
              "5. Call set_summary to broadcast your current status to the team.",
            );

            const handoffTask = handoffParts.filter(Boolean).join("\n");

            // Stagger same-type agent launches to prevent race conditions
            if (resumeLaunchedTypes.has(slot.agent_type)) {
              await new Promise((r) => setTimeout(r, 3000));
            }
            resumeLaunchedTypes.add(slot.agent_type);

            // Relaunch into existing slot
            const result = await respawnGuard.run(slot.id, async () => {
              const launched = await relaunchIntoSlot(session_id, session.project_dir, slot, handoffTask, brokerClient);
              trackLaunch(session_id, launched.slotId, launched, brokerClient);
              return launched;
            });
            if (!result) {
              failed.push(`${slot.display_name || slot.role || slot.id}: respawn already in progress`);
              continue;
            }

            // Release held messages for this slot
            try {
              await brokerClient.releaseHeldMessages(session_id, slot.id);
            } catch { /* ok */ }

            respawned.push(`${slot.display_name || slot.role || slot.id} (PID ${result.pid})`);
          } catch (err) {
            failed.push(`${slot.display_name || slot.role || slot.id}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }

        // Track session for monitoring loops
        activeSessions.set(session_id, { projectDir: session.project_dir });

        // Launch dashboards (TUI + web)
        launchDashboard(session_id, session.project_dir);
        launchWebDashboard(session_id, session.project_dir);

        const lines: string[] = [`Session "${session_id}" resumed.`];
        if (respawned.length > 0) {
          lines.push(`Respawned ${respawned.length} agent(s): ${respawned.join(", ")}`);
        }
        if (failed.length > 0) {
          lines.push(`Failed to respawn ${failed.length}: ${failed.join("; ")}`);
        }
        const skipped = slots.length - disconnected.length - slots.filter((s: any) => s.status === "connected").length;
        if (skipped > 0) {
          lines.push(`Skipped ${skipped} slot(s) (released/archived).`);
        }
        lines.push(`\nDashboard launched. Use get_team_status to monitor progress.`);

        return { content: [{ type: "text", text: lines.join("\n") }] };
      }

      // ---- get_guide ----
      case "get_guide": {
        const { topic } = args as { topic?: string };
        if (!topic) {
          return { content: [{ type: "text", text: formatTopicList() }] };
        }
        const content = getGuide(topic as GuideTopic);
        if (!content) {
          return { content: [{ type: "text", text: `Unknown topic "${topic}".\n\n${formatTopicList()}` }] };
        }
        return { content: [{ type: "text", text: content }] };
      }

      default:
        return fail(`Unknown tool: ${name}`);
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log(LOG_PREFIX, `Tool error (${name}): ${errMsg}`);
    return { content: [{ type: "text", text: `Error: ${errMsg}` }], isError: true };
  }
}

// --- Background loops ---

let guardrailTimer: ReturnType<typeof setInterval> | null = null;
let conflictTimer: ReturnType<typeof setInterval> | null = null;

let loopsStarted = false;
const USAGE_LIMIT_CHECK_MS = Number(process.env.MULTIAGENTS_LIMIT_CHECK_MS) || 10_000;

export function startBackgroundLoops(brokerClient: BrokerClient): void {
  if (loopsStarted) return;
  loopsStarted = true;

  // Guardrail check loop
  guardrailTimer = setInterval(async () => {
    for (const sessionId of activeProcesses.keys()) {
      try {
        await enforceGuardrails(sessionId, brokerClient, handleEvent);
      } catch (err) {
        log(LOG_PREFIX, `Guardrail check error for ${sessionId}: ${err}`);
      }
    }
  }, GUARDRAIL_CHECK_INTERVAL);

  // Orphan slot cleanup — every 60s. Only slots whose agent connected but never
  // worked are deleted (deadSlotVerdict): a finished agent (e.g. Gemini exits 0
  // after approval) stays listed as offline until a person removes it.
  setInterval(async () => {
    const now = Date.now();
    for (const sessionId of activeProcesses.keys()) {
      try {
        const slots = await brokerClient.listSlots(sessionId);
        if (!slots.some((s) => s.status === "disconnected")) continue;
        const session = await brokerClient.getSession(sessionId);
        const config = safeJsonParse<Record<string, unknown>>(session.config, {});
        const sessionOnHold = session.status !== "active" || !!config.qa_mode
          || (config.human_gate === true && slots.some((s) => s.task_state === "approved"));
        const [messages, plan] = await Promise.all([
          brokerClient.getMessageLog(sessionId, { limit: 1000 }).catch(() => null),
          brokerClient.getPlan(sessionId).catch(() => null),
        ]);
        // Without the history, every slot counts as having taken part
        if (!messages) continue;
        const tookPart = new Set<number>([
          ...messages.map((m) => m.from_slot_id).filter((id): id is number => id != null),
          ...(plan?.items ?? []).map((i) => i.assigned_to_slot).filter((id): id is number => id != null),
        ]);
        for (const slot of slots) {
          const verdict = deadSlotVerdict({ slot, driven: activeDrivers.has(sessionId, slot.id), tookPart: tookPart.has(slot.id), sessionOnHold, now });
          if (verdict !== "delete") continue;
          try {
            await brokerClient.deleteSlot(slot.id);
            const deadFor = now - (slot.last_disconnected ?? slot.last_connected ?? now);
            log(LOG_PREFIX, `Auto-deleted orphan slot ${slot.id} (${slot.display_name || slot.role}) — never worked, disconnected for ${Math.round(deadFor / 60000)}m`);
          } catch { /* best effort */ }
        }
      } catch { /* ok */ }
    }
  }, 60_000);

  // --- Driver delivery loop ---
  // Every 3s: hand unacked messages to each driver (Claude: stdin user message,
  // Codex: steer into the active turn or start a new one), interrupt Codex turns
  // stuck in inference, and close drivers whose slot was released.
  const INTERRUPT_IDLE_MS = 60_000;

  async function interruptIfStuck(slotId: number, state: Extract<DriverSlot, { kind: "codex" }>): Promise<void> {
    const threadId = state.threadId ?? state.driver.threadId;
    const now = Date.now();
    // A running item (shell command, tool call) is legitimate work, never "stuck".
    if (
      !threadId ||
      !state.driver.activeTurnId ||
      state.driver.activeItems > 0 ||
      now - state.driver.lastNotificationActivity <= INTERRUPT_IDLE_MS ||
      now - state.lastNudge <= INTERRUPT_IDLE_MS
    ) return;

    state.lastNudge = now;
    log(LOG_PREFIX, `Codex slot ${slotId} silent for ${Math.round((now - state.driver.lastNotificationActivity) / 1000)}s mid-turn — interrupting and requesting signal_done`);
    await state.driver.interrupt(threadId);
    await new Promise((r) => setTimeout(r, 2000));
    if (state.driver.activeTurnId || state.busy) return;

    state.busy = true;
    state.driver.reply(threadId, "Your previous task is complete. Call signal_done NOW with a summary of what you accomplished. This is the ONLY thing you need to do.")
      .then((result) => {
        state.threadId = result.threadId;
        log(LOG_PREFIX, `Codex slot ${slotId} signal_done turn completed`);
      })
      .catch((err) => log(LOG_PREFIX, `Codex slot ${slotId} signal_done turn failed: ${err}`))
      .finally(() => { state.busy = false; });
  }

  // A released driver is closed once idle (releaseVerdict). Codex heartbeat
  // replies keep lastActivity fresh, so only its notifications count as output.
  async function closeIfReleased(sessionId: string, slotId: number, state: DriverSlot): Promise<void> {
    if (!(await slotIsReleased(slotId, brokerClient))) return;
    const now = Date.now();
    state.releasedAt ??= now;
    const peek = await brokerClient.peekUndelivered(slotId).catch(() => ({ count: 0 }));
    const verdict = releaseVerdict({
      busy: state.busy,
      turnActive: state.kind === "claude" ? state.driver.busy : state.driver.activeTurnId !== null,
      lastOutputAt: state.kind === "claude" ? state.driver.lastActivity : state.driver.lastNotificationActivity,
      releasedAt: state.releasedAt,
      pendingCount: peek.count,
      now,
    });
    if (verdict === "keep") return;
    activeDrivers.delete(sessionId, slotId);
    log(LOG_PREFIX, `Slot ${slotId} released ${Math.round((now - state.releasedAt) / 1000)}s ago and idle — closing ${state.kind} driver`);
    // Not awaited: a Claude close waits for the turn to end and must not stall other slots.
    closeDriver(state).catch((err) => log(LOG_PREFIX, `Closing driver for slot ${slotId} failed: ${err}`));
  }

  // One tick at a time: a slow driver call must not let the next tick hand out the same messages again.
  setInterval(nonOverlapping(async () => {
    for (const [sessionId, drivers] of activeDrivers.sessions()) {
      const slots = new Map((await brokerClient.listSlots(sessionId).catch(() => [] as Slot[])).map((s) => [s.id, s]));
      const qa = await qaModeOn(sessionId, brokerClient);
      for (const [slotId, state] of drivers) {
        if (!state.driver.alive) continue;

        const slot = slots.get(slotId);
        if (slot) {
          try { await reconcileDriver(slot, state, qa); } catch (err) { log(LOG_PREFIX, `Settings sync failed for slot ${slotId}: ${err}`); }
        }

        if (state.kind === "codex") {
          try { await interruptIfStuck(slotId, state); } catch (err) { log(LOG_PREFIX, `Interrupt check failed for slot ${slotId}: ${err}`); }
        }

        try {
          const outcome = await deliverPendingMessages(sessionId, slotId, state, brokerClient);
          if (outcome === "failed") log(LOG_PREFIX, `Delivery to slot ${slotId} failed — messages stay queued for retry`);
        } catch (err) {
          log(LOG_PREFIX, `Delivery error for slot ${slotId}: ${err}`);
        }

        try { await closeIfReleased(sessionId, slotId, state); } catch (err) { log(LOG_PREFIX, `Release check failed for slot ${slotId}: ${err}`); }
      }
    }
  }), 3_000);

  // Usage limits — pause agents that reached their token/cost limit
  setInterval(nonOverlapping(async () => {
    for (const sessionId of activeProcesses.keys()) {
      try { await enforceUsageLimits(sessionId, brokerClient); } catch (err) { log(LOG_PREFIX, `Limit check failed for ${sessionId}: ${err}`); }
    }
  }), USAGE_LIMIT_CHECK_MS);

  // Stuck agent nudge loop (disabled by default to prevent noisy spam; set MULTIAGENTS_ENABLE_NUDGE=1 to enable)
  if (process.env.MULTIAGENTS_ENABLE_NUDGE === "1") {
    setInterval(async () => {
      for (const sessionId of activeProcesses.keys()) {
        try {
          // Agents waiting for the person's questions are silent on purpose
          if (await qaModeOn(sessionId, brokerClient)) continue;
          const slots = await brokerClient.listSlots(sessionId);
          for (const slot of slots) {
            if (slot.status !== "connected" || !slot.peer_id) continue;
            if (slot.paused === true || (slot.paused as unknown as number) === 1) continue;

            // Skip agents in truly terminal task states — no point nudging them
            const taskState = (slot as any).task_state;
            if (taskState === "approved" || taskState === "released") continue;
            // Note: done_pending_review agents are NOT skipped — they may need
            // to respond to feedback or review requests from teammates.

            // Codex driver-managed agents get nudges delivered via the
            // forwarding loop (steer or reply). Don't skip them — they need
            // nudges too, especially to prompt signal_done after long turns.

            // Check last_connected or context_snapshot for activity
            const lastActivity = (() => {
              if (slot.context_snapshot) {
                try {
                  const snap = JSON.parse(slot.context_snapshot);
                  if (snap.updated_at) return snap.updated_at;
                } catch { /* ok */ }
              }
              return slot.last_connected ?? 0;
            })();

            const silentMs = Date.now() - lastActivity;
            if (silentMs > 1 * 60 * 1000) {
              const agentName = slot.display_name || `slot ${slot.id}`;
              const silentMin = Math.round(silentMs / 60000);

              // Nudge the agent
              await brokerClient.sendMessage({
                from_id: "orchestrator",
                to_id: slot.peer_id,
                text: `[NUDGE] You have been silent for ${silentMin} minutes. ` +
                      `Check your teammates with check_team_status and check_messages. ` +
                      `If you are done, call signal_done. If you are blocked, send a message to "orchestrator" explaining what you need.`,
                msg_type: "system",
                session_id: sessionId,
              });

              // Also alert the orchestrator user via pending events
              pendingEvents.push({
                type: "agent_silent",
                severity: silentMs > 5 * 60 * 1000 ? "warning" : "info",
                slotId: slot.id,
                sessionId,
                message: `${agentName} (${slot.role || "unknown"}) silent for ${silentMin}m — task_state: ${(slot as any).task_state || "idle"}. May need intervention.`,
              });
              log(LOG_PREFIX, `Nudged silent agent ${agentName} (${silentMin}m silent)`);
            }
          }
        } catch { /* ok */ }
      }
    }, 45_000);
  }

  // Conflict detection loop — basic git status monitoring
  conflictTimer = setInterval(async () => {
    for (const sessionId of activeProcesses.keys()) {
      try {
        const session = await brokerClient.getSession(sessionId);
        if (session.status !== "active" || !session.git_root) continue;

        const proc = Bun.spawn(["git", "status", "--porcelain"], {
          cwd: session.project_dir,
          stdout: "pipe",
          stderr: "ignore",
        });
        const output = await new Response(proc.stdout).text();
        const exitCode = await proc.exited;

        if (exitCode === 0) {
          // Check for merge conflicts (lines starting with UU, AA, DD, etc.)
          const conflictLines = output
            .split("\n")
            .filter((l) => /^(UU|AA|DD|AU|UA|DU|UD)\s/.test(l));

          if (conflictLines.length > 0) {
            handleEvent({
              type: "git_conflict",
              severity: "critical",
              slotId: -1,
              sessionId,
              message: `Git conflicts detected: ${conflictLines.length} file(s)`,
              data: { files: conflictLines.map((l) => l.slice(3).trim()) },
            });
          }
        }
      } catch (err) {
        log(LOG_PREFIX, `Conflict check error for ${sessionId}: ${err}`);
      }
    }
  }, CONFLICT_CHECK_INTERVAL);

  // Agent escalation monitor — check for messages sent TO "orchestrator" and surface as events
  const seenEscalations = new Set<string>();
  setInterval(async () => {
    for (const sessionId of activeProcesses.keys()) {
      try {
        const messages = await brokerClient.getMessageLog(sessionId, { limit: 30 });
        for (const msg of messages) {
          if (msg.to_id !== "orchestrator") continue;
          // Deduplicate by message id or sent_at+from_id
          const key = `${msg.from_id}:${msg.sent_at}`;
          if (seenEscalations.has(key)) continue;
          seenEscalations.add(key);

          const isBlocked = /BLOCKED|NEED HELP|ESCALAT|STUCK|CANNOT PROCEED/i.test(msg.text);
          if (isBlocked) {
            const slots = await brokerClient.listSlots(sessionId);
            const fromSlot = slots.find((s) => s.peer_id === msg.from_id);
            const fromName = fromSlot?.display_name || fromSlot?.role || msg.from_id;

            pendingEvents.push({
              type: "agent_blocked",
              severity: "warning",
              slotId: fromSlot?.id ?? -1,
              sessionId,
              message: `AGENT BLOCKED — ${fromName}: ${msg.text.slice(0, 300)}`,
            });
            log(LOG_PREFIX, `Agent escalation from ${fromName}: ${msg.text.slice(0, 100)}`);
          }
        }

        // Prune old escalation keys (keep set from growing unbounded)
        if (seenEscalations.size > 500) {
          for (const escalationKey of [...seenEscalations].slice(0, 250)) {
            seenEscalations.delete(escalationKey);
          }
        }
      } catch { /* ok */ }
    }
  }, 15_000);

  // --- Session auto-end: archive session when all agents are approved/released ---
  // Checks every 30s. Waits for a 30s grace period after the last approval
  // to allow agents to see the final state before killing processes.
  const sessionCompletionTimers: Map<string, number> = new Map();
  setInterval(async () => {
    for (const sessionId of activeProcesses.keys()) {
      try {
        // The person is talking to the team: never end the session under them
        if (await qaModeOn(sessionId, brokerClient)) { sessionCompletionTimers.delete(sessionId); continue; }
        const slots = await brokerClient.listSlots(sessionId);
        if (slots.length === 0) continue;

        // --- Auto-approve orphaned done_pending_review agents ---
        // When all reviewer/QA agents are approved/released/disconnected but some
        // non-reviewer agents are still at done_pending_review, there's nobody left
        // to approve them. Auto-approve to unblock session completion.
        const reviewerSlots = slots.filter((s) => s.role && /qa|review|test|lead/i.test(s.role));
        const allReviewersDone = reviewerSlots.length > 0 && reviewerSlots.every(
          (s) => (s as any).task_state === "approved" || (s as any).task_state === "released" || s.status === "disconnected"
        );
        if (allReviewersDone) {
          const orphaned = slots.filter(
            (s) => (s as any).task_state === "done_pending_review" && !(s.role && /qa|review|test|lead/i.test(s.role))
          );
          for (const slot of orphaned) {
            log(LOG_PREFIX, `Auto-approving orphaned ${slot.display_name ?? `slot ${slot.id}`} (all reviewers done, no one left to approve)`);
            await brokerClient.updateSlot({ id: slot.id, task_state: "approved" } as any);
            pendingEvents.push({
              type: "auto_approved",
              severity: "info",
              slotId: slot.id,
              sessionId,
              message: `${slot.display_name ?? `slot ${slot.id}`} auto-approved: all reviewers finished, no pending review possible.`,
            });
          }
        }

        // --- Auto-approve reviewers when all workers are approved ---
        const workerSlots = slots.filter((s) => !(s.role && /qa|review|test|lead/i.test(s.role)) && (s as any).task_state !== "released");
        if (workerSlots.length > 0 && workerSlots.every((s) => (s as any).task_state === "approved")) {
          const activeReviewers = reviewerSlots.filter((s) => (s as any).task_state !== "approved" && (s as any).task_state !== "released");
          for (const rev of activeReviewers) {
            log(LOG_PREFIX, `Auto-approving reviewer ${rev.display_name ?? `slot ${rev.id}`} (all worker tasks approved)`);
            await brokerClient.updateSlot({ id: rev.id, task_state: "approved" } as any);
          }
        }

        const allDone = slots.every(
          (s) => (s as any).task_state === "approved" || (s as any).task_state === "released" || s.status === "disconnected"
        );
        const anyApproved = slots.some((s) => (s as any).task_state === "approved" || (s as any).task_state === "released");

        // A human gate keeps approved agents waiting for a person's release
        const awaitingHuman = allDone && slots.some((s) => (s as any).task_state === "approved") &&
          await humanGateEnabled(sessionId, brokerClient);

        if (allDone && anyApproved && !awaitingHuman) {
          const existingTimer = sessionCompletionTimers.get(sessionId);
          if (!existingTimer) {
            sessionCompletionTimers.set(sessionId, Date.now());
            log(LOG_PREFIX, `Session ${sessionId}: all agents done — starting 30s grace period before auto-end`);
            pendingEvents.push({
              type: "session_completing",
              severity: "info",
              slotId: -1,
              sessionId,
              message: `All agents approved/released. Session will auto-end in 30s.`,
            });
          } else if (Date.now() - existingTimer > 30_000) {
            // Grace period elapsed — auto-end the session
            log(LOG_PREFIX, `Session ${sessionId}: auto-ending (all agents approved for 30s)`);

            stopSession(sessionId);

            // Mark all connected slots as disconnected
            for (const slot of slots) {
              if (slot.status === "connected") {
                await brokerClient.updateSlot({ id: slot.id, status: "disconnected" });
              }
            }

            // Archive the session
            await brokerClient.updateSession({ id: sessionId, status: "archived" });

            // Clean up tracking state
            for (const slot of slots) {
              clearSlotTracking(slot.id);
              completionRestartHistory.delete(slot.id);
            }
            sessionCompletionTimers.delete(sessionId);

            pendingEvents.push({
              type: "session_ended",
              severity: "info",
              slotId: -1,
              sessionId,
              message: `Session auto-ended: all agents approved. ${slots.length} agents stopped and session archived.`,
            });
          }
        } else {
          // Reset timer if conditions no longer met (agent restarted, etc.)
          sessionCompletionTimers.delete(sessionId);
        }
      } catch { /* ok */ }
    }
  }, 15_000);

  // --- Smart non-driver agent respawn ---
  //
  // Problem: process-launched agents (Gemini) only see teammate messages in
  // their next MCP tool result. After signal_done or when idle, the LLM stops
  // calling tools and messages pile up unacked. Teammates are blocked waiting.
  //
  // Solution: measure actual message staleness, not agent idle time.
  //   - A connected agent is judged by messages its adapter never claimed: a
  //     claimed one is merely waiting for the agent's next tool call
  //   - Disconnected agents with any actionable unacked messages → respawn immediately
  //   - Driver-managed agents (Claude, Codex) → skip, the delivery loop handles them
  //   - Paused agents are left alone
  //
  const CONNECTED_STALE_MS = STUCK_THRESHOLD_MS;
  const lastRespawnAttempt: Map<number, number> = new Map();

  setInterval(async () => {
    for (const sessionId of activeProcesses.keys()) {
      try {
        // Teammates' messages held during Q&A mode are no reason to respawn anyone
        if (await qaModeOn(sessionId, brokerClient)) continue;
        const slots = await brokerClient.listSlots(sessionId);
        for (const slot of slots) {
          const taskState = (slot as any).task_state;
          if (taskState === "released") continue;

          // Skip driver-managed slots — the delivery loop handles them
          if (activeDrivers.has(sessionId, slot.id)) continue;

          // Only act on processes this orchestrator launched; a connected slot it
          // does not own may be a human's interactive session.
          const owned = activeProcesses.get(sessionId)?.has(slot.id) === true;
          if (slot.status === "connected" && !owned) continue;

          const inbox = watchdogInbox(slot, await brokerClient.peekUndelivered(slot.id));
          if (!inbox || inbox.count === 0) continue;

          // Only act on actionable message types
          const hasActionable = inbox.msg_types.some(
            (t) => t === "review_request" || t === "task_complete" || t === "feedback" || t === "system"
          );
          if (!hasActionable) continue;

          const now = Date.now();

          const sessionProcs = activeProcesses.get(sessionId);
          const hasRunningProc = sessionProcs?.has(slot.id) === true;

          // A connected agent is stuck only when messages stay unclaimed past the threshold,
          // UNLESS its process already completed and is in standby, in which case wake it up immediately!
          if (slot.status === "connected" && hasRunningProc) {
            const messageAge = inbox.oldest_at ? now - inbox.oldest_at : 0;
            if (messageAge < CONNECTED_STALE_MS) continue;
          }

          // Throttle respawns (at most once per 45s per slot)
          const lastAttempt = lastRespawnAttempt.get(slot.id) ?? 0;
          if (now - lastAttempt < 45_000) continue;
          lastRespawnAttempt.set(slot.id, now);

          const agentName = slot.display_name ?? `slot ${slot.id}`;
          const sessionMeta = activeSessions.get(sessionId);
          if (!sessionMeta) continue;

          // If connected but not polling — kill the stale process first
          if (slot.status === "connected") {
            const messageAgeSec = inbox.oldest_at ? Math.round((now - inbox.oldest_at) / 1000) : 0;
            log(LOG_PREFIX, `${agentName} (${slot.agent_type}) has ${inbox.count} unclaimed message(s) for ${messageAgeSec}s — not polling, killing process`);
            const sessionProcs = activeProcesses.get(sessionId);
            const proc = sessionProcs?.get(slot.id);
            if (proc) {
              try { proc.kill(); } catch { /* ok */ }
              sessionProcs?.delete(slot.id);
            }
            // Brief wait for broker to register disconnect
            await new Promise((r) => setTimeout(r, 1000));
          }

          log(LOG_PREFIX, `Respawning ${agentName} (${slot.agent_type}) — ${inbox.count} unread messages`);

          try {
            const result = await respawnGuard.run(slot.id, async () => {
              const { respawnAgent } = await import("./recovery.ts");
              const launched = await respawnAgent(sessionId, slot.id, brokerClient, sessionMeta.projectDir);
              trackLaunch(sessionId, slot.id, launched, brokerClient);
              return launched;
            });
            if (!result) continue; // another path is already respawning this slot

            pendingEvents.push({
              type: "agent_restarted",
              severity: "info",
              slotId: slot.id,
              sessionId,
              message: `${agentName} auto-respawned: ${inbox.count} unread messages waiting ${inbox.oldest_at ? Math.round((now - inbox.oldest_at) / 1000) : "?"}s`,
            });
          } catch (err) {
            log(LOG_PREFIX, `Failed to respawn ${agentName}: ${err}`);
          }
        }
      } catch { /* ok */ }
    }
  }, 10_000);
}

/** Stop every agent this process launched (the host exits afterwards). */
export function shutdownRuntime(): void {
  log(LOG_PREFIX, "Shutting down — killing all managed agent processes");
  const sessions = new Set([...activeSessions.keys(), ...activeProcesses.keys(), ...activeDrivers.sessionIds()]);
  for (const sessionId of sessions) {
    stopSession(sessionId);
  }
}
