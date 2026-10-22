#!/usr/bin/env bun
// ============================================================================
// multiagents — Web Dashboard Server
// ============================================================================
// Standalone Bun.serve() on port 7900. Fetches state from broker (7899) and
// pushes live updates to connected browsers via WebSocket. It also hosts the
// orchestrator runtime, so teams and agents launched from the browser are
// supervised by this process (see dashboard/control.ts for the actions).
//
// Usage:
//   bun dashboard/server.ts [session-id]
//   multiagents web [session-id]
// ============================================================================

import { BrokerClient } from "../shared/broker-client.ts";
import { DASHBOARD_REFRESH } from "../shared/constants.ts";
import { resolveBrokerPort, brokerUrl } from "../shared/broker-url.ts";
import type { Session, Slot, Peer, Message, GuardrailState, FileLock, FileOwnership, ApprovalRequest, LiveActivity } from "../shared/types.ts";
import type { PlanState } from "../shared/broker-client.ts";
import { configureRuntime, ensureBroker, startBackgroundLoops, shutdownRuntime, isManagedSession, managedSlotIds, missingBrokerFeatures, restartBroker, brokerIsIdle } from "../orchestrator/runtime.ts";
import { handleFs } from "./files.ts";
import { getPlanUsage } from "../orchestrator/plan-usage.ts";
import { handleControl, exportSession, listActivity, awaitingHuman, ApiError, CONTROL_ACTIONS, HUMAN_ID, type ControlContext } from "./control.ts";

// --- Configuration ---

const WEB_DASHBOARD_PORT = parseInt(process.env.MULTIAGENTS_WEB_PORT ?? "7900", 10);
const BROKER_PORT = resolveBrokerPort();
const BROKER_URL = brokerUrl();
const broker = new BrokerClient(BROKER_URL);
const controlCtx: ControlContext = { broker, brokerPort: BROKER_PORT };

// Lifecycle actions from the browser run the orchestrator's own code, as the human
configureRuntime({ launchDashboards: false, actor: HUMAN_ID });

// --- Session resolution (same logic as TUI) ---

async function resolveSessionId(explicit?: string): Promise<string | null> {
  if (explicit) return explicit;

  // Try local session file
  try {
    const path = require("node:path");
    const fs = require("node:fs");
    const sessionPath = path.resolve(process.cwd(), ".multiagents", "session.json");
    const data = JSON.parse(fs.readFileSync(sessionPath, "utf-8"));
    if (data.session_id) return data.session_id;
  } catch { /* no local session */ }

  // Try broker — find most recent active session
  try {
    const sessions = await broker.listSessions();
    const active = sessions
      .filter((s: Session) => s.status === "active" || s.status === "paused")
      .sort((a: Session, b: Session) => (b.last_active_at ?? 0) - (a.last_active_at ?? 0));
    return active[0]?.id ?? null;
  } catch { /* broker down */ }

  return null;
}

// --- Dashboard state (mirrors TUI DashboardState) ---

interface DashboardState {
  sessionId: string | null;
  session: Session | null;
  slots: Slot[];
  peers: Peer[];
  messages: Message[];
  guardrails: GuardrailState[];
  fileLocks: FileLock[];
  fileOwnership: FileOwnership[];
  plan: PlanState | null;
  knowledge: Array<{ key: string; value: string; category: string; created_by_name: string | null; updated_at: number }>;
  brokerAlive: boolean;
  /** Features the running broker lacks: it runs code from before an update */
  brokerMissing: string[];
  brokerUrl: string;
  /** Every session on the broker, for the sidebar */
  sessions: Session[];
  /** Registered peers machine-wide */
  peerCount: number;
  /** Slots whose agent process this dashboard launched and supervises */
  managedSlots: number[];
  managed: boolean;
  humanGate: boolean;
  /** Q&A mode: the team's work is on hold while the person asks questions */
  qaMode: boolean;
  /** What each busy agent is doing right now, by slot id */
  live: Record<string, LiveActivity>;
  awaitingHuman: boolean;
  /** Tool calls waiting for a person */
  approvals: ApprovalRequest[];
  /** Usage limits from the session config */
  limits: Record<string, number>;
  timestamp: number;
}

/** The broker's missing features: checked every 30s, and on every build while some are missing (a restart clears them). */
let brokerCheck: { at: number; missing: string[] } = { at: 0, missing: [] };
async function brokerMissingCached(): Promise<string[]> {
  if (brokerCheck.missing.length || Date.now() - brokerCheck.at > 30_000) brokerCheck = { at: Date.now(), missing: await missingBrokerFeatures().catch(() => []) };
  return brokerCheck.missing;
}

async function fetchState(sessionId: string | null): Promise<DashboardState> {
  const state: DashboardState = {
    sessionId,
    session: null,
    slots: [],
    peers: [],
    messages: [],
    guardrails: [],
    fileLocks: [],
    fileOwnership: [],
    plan: null,
    knowledge: [],
    brokerAlive: false,
    brokerMissing: [],
    brokerUrl: BROKER_URL,
    sessions: [],
    peerCount: 0,
    managedSlots: [],
    managed: false,
    humanGate: false,
    qaMode: false,
    live: {},
    awaitingHuman: false,
    approvals: [],
    limits: {},
    timestamp: Date.now(),
  };

  try {
    state.brokerAlive = await broker.isAlive();
  } catch {
    return state;
  }
  state.brokerMissing = state.brokerAlive ? await brokerMissingCached() : [];

  if (!state.brokerAlive) return state;

  state.sessions = await broker.listSessions().catch(() => []);
  if (!sessionId) return state;

  try {
    const [session, slots, messages, guardrails, fileLocks, fileOwnership, plan, knowledge, approvals, live] = await Promise.all([
      broker.getSession(sessionId).catch(() => null),
      broker.listSlots(sessionId).catch(() => []),
      broker.getMessageLog(sessionId, { limit: 200 }).catch(() => []),
      broker.getGuardrails(sessionId).catch(() => []),
      broker.listFileLocks(sessionId).catch(() => []),
      broker.listFileOwnership(sessionId).catch(() => []),
      broker.getPlan(sessionId).catch(() => null),
      broker.listKnowledge(sessionId).catch(() => []),
      broker.listApprovals(sessionId, "pending").catch(() => []),
      broker.listLiveActivity(sessionId).catch(() => ({})),
    ]);

    // Get peers for slot enrichment
    const peers = await broker.listPeers({
      scope: "machine",
      cwd: process.cwd(),
      git_root: null,
    }).catch(() => []);

    state.session = session;
    state.slots = slots;
    state.peers = peers;
    state.messages = messages;
    state.guardrails = guardrails;
    state.fileLocks = fileLocks;
    state.fileOwnership = fileOwnership;
    state.plan = plan;
    state.knowledge = knowledge;
    state.peerCount = peers.length;
    state.managedSlots = managedSlotIds(sessionId);
    state.managed = isManagedSession(sessionId);
    state.approvals = approvals;
    state.live = live;
    try {
      const config = JSON.parse(session?.config ?? "{}");
      state.humanGate = config.human_gate === true;
      state.qaMode = !!config.qa_mode;
      state.limits = config.limits && typeof config.limits === "object" ? config.limits : {};
    } catch { /* malformed config */ }
    state.awaitingHuman = awaitingHuman(session, slots);
  } catch (e) {
    console.error(`[web-dashboard] Fetch error: ${e}`);
  }

  return state;
}

// --- WebSocket management ---

const wsClients = new Set<any>();
let currentState: DashboardState | null = null;
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let pollGeneration = 0; // Incremented on session switch to kill stale poll loops
let userPinnedSession = false; // True when user explicitly selected a session — disables auto-switch

// Fetches overlap (poll ticks and post-mutation refreshes); only a newer fetch may replace what clients saw.
let fetchSeq = 0;
let broadcastSeq = 0;

async function fetchAndBroadcast(): Promise<DashboardState> {
  const seq = ++fetchSeq;
  const state = await fetchState(sessionId);
  if (seq > broadcastSeq) {
    broadcastSeq = seq;
    currentState = state;
    broadcastState(state);
  }
  return state;
}

function broadcastState(state: DashboardState) {
  const json = JSON.stringify({ type: "state", data: state });
  for (const ws of wsClients) {
    try {
      ws.send(json);
    } catch {
      wsClients.delete(ws);
    }
  }
}

/** Check if a session is effectively complete (all agents done + disconnected) */
function isSessionComplete(state: DashboardState): boolean {
  if (!state.slots.length) return false;
  const allDisconnected = state.slots.every(s => s.status === "disconnected");
  if (!allDisconnected) return false;
  const allDone = state.slots.every(s =>
    s.task_state === "approved" || s.task_state === "released" || s.task_state === "done_pending_review"
  );
  return allDone;
}

async function startPolling() {
  // Cancel any existing poll loop
  if (pollTimer) clearTimeout(pollTimer);
  const gen = ++pollGeneration;

  // Initial fetch
  await fetchAndBroadcast();

  // Recursive tick — reads the global `sessionId` each cycle
  async function tick() {
    // If a new startPolling() was called, this stale loop must die
    if (gen !== pollGeneration) return;

    const complete = currentState ? isSessionComplete(currentState) : false;
    const status = currentState?.session?.status;

    // For completed or archived sessions: auto-switch to newer active session (unless user pinned)
    if (!userPinnedSession && (complete || status === "archived") && sessionId) {
      try {
        const sessions = await broker.listSessions();
        const newer = sessions.find((s: any) =>
          s.status === "active" && s.id !== sessionId &&
          (s.created_at ?? 0) > (currentState?.session?.created_at ?? 0)
        );
        if (newer) {
          sessionId = newer.id;
          console.error(`[web-dashboard] Auto-switched to new session: ${newer.id}`);
        }
      } catch { /* broker down */ }
    }

    await fetchAndBroadcast();

    // Stop if superseded
    if (gen !== pollGeneration) return;

    // Schedule next tick: slow for completed/archived, fast for active
    const nextComplete = currentState ? isSessionComplete(currentState) : false;
    const nextStatus = currentState?.session?.status;
    const delay = (nextComplete || nextStatus === "archived") ? 3000
      : nextStatus === "paused" ? 2000
      : DASHBOARD_REFRESH;
    pollTimer = setTimeout(tick, delay);
  }

  pollTimer = setTimeout(tick, DASHBOARD_REFRESH);
}

// --- Resolve session and start ---

const sessionArg = process.argv[2];
let sessionId = await resolveSessionId(sessionArg);

function apiError(e: unknown): Response {
  let status = e instanceof ApiError ? e.status : 500;
  let message = e instanceof Error ? e.message : String(e);
  // Surface the broker's own answer rather than the client's wrapper around it
  const fromBroker = message.match(/^Broker POST \S+ failed \((\d+)\): (.*)$/s);
  if (fromBroker) {
    status = Number(fromBroker[1]);
    try { message = JSON.parse(fromBroker[2]!).error ?? fromBroker[2]; } catch { message = fromBroker[2]!; }
  }
  if (status >= 500) console.error(`[web-dashboard] API error: ${message}`);
  return Response.json({ ok: false, error: message }, { status });
}

// --- HTML serving ---

const DASHBOARD_DIR = new URL(".", import.meta.url).pathname;
const indexHtml = Bun.file(`${DASHBOARD_DIR}index.html`);
// The UI's own assets (a fixed list: nothing else in the directory is served)
const ASSETS: Record<string, string> = {
  "/app.js": "text/javascript; charset=utf-8",
  "/i18n.js": "text/javascript; charset=utf-8",
  "/styles.css": "text/css; charset=utf-8",
};

const server = Bun.serve({
  port: WEB_DASHBOARD_PORT,
  hostname: "127.0.0.1",

  async fetch(req, server) {
    const url = new URL(req.url);

    // WebSocket upgrade
    if (url.pathname === "/ws") {
      const upgraded = server.upgrade(req);
      if (!upgraded) {
        return new Response("WebSocket upgrade failed", { status: 400 });
      }
      return undefined as any;
    }

    // API: switch session
    if (url.pathname === "/api/session" && req.method === "POST") {
      const body = await req.json() as { session_id?: string };
      if (body.session_id) {
        sessionId = body.session_id;
        userPinnedSession = true; // User explicitly chose — don't auto-switch away
        await startPolling();
        return Response.json({ ok: true, session_id: sessionId });
      }
      return Response.json({ error: "session_id required" }, { status: 400 });
    }

    // API: list sessions
    if (url.pathname === "/api/sessions") {
      try {
        const sessions = await broker.listSessions();
        return Response.json(sessions);
      } catch {
        return Response.json([]);
      }
    }

    // API: broker status
    if (url.pathname === "/api/broker" && req.method === "GET") {
      const alive = await broker.isAlive();
      const sessions = alive ? await broker.listSessions().catch(() => []) : [];
      const peers = alive ? await broker.listPeers({ scope: "machine", cwd: "/", git_root: null }).catch(() => []) : [];
      return Response.json({
        alive,
        url: BROKER_URL,
        sessions: sessions.length,
        active_sessions: sessions.filter((s) => s.status === "active").length,
        peers: peers.length,
        current_session: sessionId,
      });
    }

    // API: project files for the explorer and preview (read-only, inside the project dir)
    if (url.pathname.startsWith("/api/fs/") && req.method === "GET") {
      try {
        return await handleFs(broker, url.pathname.slice("/api/fs/".length), url);
      } catch (e) {
        return apiError(e);
      }
    }

    // API: activity timeline (incremental with after_id)
    if (url.pathname === "/api/activity" && req.method === "GET") {
      try {
        return Response.json({ ok: true, result: await listActivity(controlCtx, url) });
      } catch (e) {
        return apiError(e);
      }
    }

    // API: what each agent is doing right now (polled fast while the chat is open)
    if (url.pathname === "/api/live" && req.method === "GET") {
      const id = url.searchParams.get("session_id");
      if (!id) return Response.json({ ok: false, error: "session_id required" }, { status: 400 });
      return Response.json({ ok: true, result: await broker.listLiveActivity(id).catch(() => ({})) });
    }

    // API: subscription plan limits of the CLIs (5-hour / weekly / daily windows)
    if (url.pathname === "/api/plan-usage" && req.method === "GET") {
      try {
        return Response.json({ ok: true, result: await getPlanUsage({ refresh: url.searchParams.get("refresh") === "1" }) });
      } catch (e) {
        return apiError(e);
      }
    }

    // API: session export (download)
    if (url.pathname === "/api/session/export" && req.method === "GET") {
      const id = url.searchParams.get("session_id");
      if (!id) return Response.json({ error: "session_id required" }, { status: 400 });
      try {
        const data = await exportSession(controlCtx, id);
        return new Response(JSON.stringify(data, null, 2), {
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Content-Disposition": `attachment; filename="session-${id.replace(/[^\w.-]/g, "_")}-export.json"`,
          },
        });
      } catch (e) {
        return apiError(e);
      }
    }

    // API: control actions (send, pause, release, add agent, plan, knowledge, ...)
    if (url.pathname.startsWith("/api/") && (req.method === "POST" || req.method === "GET")) {
      const action = url.pathname.slice("/api/".length);
      if (CONTROL_ACTIONS.includes(action)) {
        let body: Record<string, unknown> = {};
        if (req.method === "POST") {
          try {
            body = (await req.json()) as Record<string, unknown>;
          } catch {
            return Response.json({ ok: false, error: "Body must be JSON" }, { status: 400 });
          }
          if (!body || typeof body !== "object" || Array.isArray(body)) {
            return Response.json({ ok: false, error: "Body must be a JSON object" }, { status: 400 });
          }
        }
        try {
          const result = await handleControl(controlCtx, action, body);
          // A team started from the browser is what the user wants to watch next
          const created = action === "team/create" ? (result as { data?: { session_id?: string } }).data?.session_id : undefined;
          const createdSession = action === "session/create" ? (result as Session).id : undefined;
          if (created || createdSession) {
            sessionId = (created ?? createdSession)!;
            userPinnedSession = true;
            await startPolling();
          } else if (req.method === "POST") {
            await fetchAndBroadcast();
          }
          return Response.json({ ok: true, result });
        } catch (e) {
          return apiError(e);
        }
      }
    }

    // Serve index.html for root
    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(indexHtml, {
        headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" },
      });
    }
    const assetType = ASSETS[url.pathname];
    if (assetType) {
      return new Response(Bun.file(`${DASHBOARD_DIR}${url.pathname.slice(1)}`), {
        headers: { "Content-Type": assetType, "Cache-Control": "no-cache" },
      });
    }

    return new Response("Not found", { status: 404 });
  },

  websocket: {
    open(ws) {
      wsClients.add(ws);
      // Send current state immediately on connect
      if (currentState) {
        ws.send(JSON.stringify({ type: "state", data: currentState }));
      }
    },
    message(ws, msg) {
      // Handle ping/pong for keepalive
      if (msg === "ping") {
        ws.send("pong");
      }
    },
    close(ws) {
      wsClients.delete(ws);
    },
  },
});

// Start the broker if needed (as the orchestrator does) and the supervision
// loops for the agents this dashboard launches
try {
  await ensureBroker(broker);
  // A broker left running from before an update lacks what this dashboard needs;
  // with nobody connected it is restarted right away, otherwise the page offers it
  const missing = await missingBrokerFeatures();
  if (missing.length && await brokerIsIdle(broker)) {
    console.error(`[web-dashboard] The broker runs older code (missing: ${missing.join(", ")}) and has no agents — restarting it`);
    await restartBroker(broker);
  }
} catch (e) {
  console.error(`[web-dashboard] Broker unavailable: ${e instanceof Error ? e.message : e}`);
}
startBackgroundLoops(broker);

// Start polling
await startPolling();

// Agents launched from the browser belong to this process: stop them with it
function shutdown() {
  shutdownRuntime();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

console.error(`[web-dashboard] Listening on http://127.0.0.1:${WEB_DASHBOARD_PORT}`);
console.error(`[web-dashboard] Session: ${sessionId ?? "(none — waiting for session)"}`);

// Auto-open in browser (skip in test mode)
if (!process.env.MULTIAGENTS_NO_OPEN) {
  try {
    const platform = process.platform;
    const url = `http://127.0.0.1:${WEB_DASHBOARD_PORT}`;
    if (platform === "darwin") {
      Bun.spawn(["open", url], { stdio: ["ignore", "ignore", "ignore"] }).unref();
    } else if (platform === "linux") {
      Bun.spawn(["xdg-open", url], { stdio: ["ignore", "ignore", "ignore"] }).unref();
    }
  } catch { /* non-critical */ }
}
