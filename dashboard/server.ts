#!/usr/bin/env bun
// ============================================================================
// multiagents — Web Dashboard Server
// ============================================================================
// Standalone Bun.serve() on port 7900. Fetches state from broker (7899) and
// pushes live updates to connected browsers via WebSocket.
//
// Usage:
//   bun dashboard/server.ts [session-id]
//   multiagents web [session-id]
// ============================================================================

import { BrokerClient } from "../shared/broker-client.ts";
import {
  DEFAULT_BROKER_PORT,
  BROKER_HOSTNAME,
  DASHBOARD_REFRESH,
} from "../shared/constants.ts";
import type { Session, Slot, Peer, Message, GuardrailState, FileLock, FileOwnership } from "../shared/types.ts";
import type { PlanState } from "../shared/broker-client.ts";

// --- Configuration ---

const WEB_DASHBOARD_PORT = parseInt(process.env.MULTIAGENTS_WEB_PORT ?? "7900", 10);
const BROKER_PORT = parseInt(process.env.MULTIAGENTS_PORT ?? String(DEFAULT_BROKER_PORT), 10);
const BROKER_URL = `http://${BROKER_HOSTNAME}:${BROKER_PORT}`;
const broker = new BrokerClient(BROKER_URL);

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
    if (active.length > 0) return active[0].id;
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
  timestamp: number;
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
    timestamp: Date.now(),
  };

  try {
    state.brokerAlive = await broker.isAlive();
  } catch {
    return state;
  }

  if (!state.brokerAlive || !sessionId) return state;

  try {
    const [session, slots, messages, guardrails, fileLocks, fileOwnership, plan, knowledge] = await Promise.all([
      broker.getSession(sessionId).catch(() => null),
      broker.listSlots(sessionId).catch(() => []),
      broker.getMessageLog(sessionId, { limit: 200 }).catch(() => []),
      broker.getGuardrails(sessionId).catch(() => []),
      broker.listFileLocks(sessionId).catch(() => []),
      broker.listFileOwnership(sessionId).catch(() => []),
      broker.getPlan(sessionId).catch(() => null),
      broker.listKnowledge(sessionId).catch(() => []),
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
  } catch (e) {
    console.error(`[web-dashboard] Fetch error: ${e}`);
  }

  return state;
}

// --- WebSocket management ---

const wsClients = new Set<any>();
let currentState: DashboardState | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;

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

async function startPolling(sessionId: string | null) {
  if (pollTimer) clearInterval(pollTimer);

  // Initial fetch
  currentState = await fetchState(sessionId);
  broadcastState(currentState);

  // Poll at DASHBOARD_REFRESH interval (500ms for active, slower for paused/archived)
  pollTimer = setInterval(async () => {
    const refreshMs = currentState?.session?.status === "archived" ? 5000
      : currentState?.session?.status === "paused" ? 2000
      : DASHBOARD_REFRESH;

    currentState = await fetchState(sessionId);
    broadcastState(currentState);
  }, DASHBOARD_REFRESH);
}

// --- Resolve session and start ---

const sessionArg = process.argv[2];
let sessionId = await resolveSessionId(sessionArg);

// --- HTML serving ---

const DASHBOARD_DIR = new URL(".", import.meta.url).pathname;
const indexHtml = Bun.file(`${DASHBOARD_DIR}index.html`);

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
        await startPolling(sessionId);
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

    // API: guardrail adjust
    if (url.pathname === "/api/guardrail" && req.method === "POST") {
      const body = await req.json() as { session_id: string; guardrail_id: string; value: number; reason?: string };
      try {
        const result = await broker.updateGuardrail({
          session_id: body.session_id,
          guardrail_id: body.guardrail_id,
          value: body.value,
          reason: body.reason ?? "Adjusted via web dashboard",
          changed_by: "web-dashboard",
        });
        return Response.json(result);
      } catch (e) {
        return Response.json({ error: String(e) }, { status: 500 });
      }
    }

    // API: pause/resume session
    if (url.pathname === "/api/session/control" && req.method === "POST") {
      const body = await req.json() as { session_id: string; action: "pause" | "resume" };
      try {
        const result = await broker.updateSession({
          id: body.session_id,
          status: body.action === "pause" ? "paused" : "active",
          pause_reason: body.action === "pause" ? "Paused via web dashboard" : undefined,
          paused_at: body.action === "pause" ? Date.now() : undefined,
        });
        return Response.json(result);
      } catch (e) {
        return Response.json({ error: String(e) }, { status: 500 });
      }
    }

    // Serve index.html for root
    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(indexHtml, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
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

// Start polling
await startPolling(sessionId);

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
