#!/usr/bin/env bun
/**
 * multiagents broker daemon
 *
 * A singleton HTTP server on localhost backed by SQLite.
 * Tracks registered agent peers, routes messages, manages sessions,
 * file locks, ownership zones, and guardrails.
 *
 * Auto-launched by the MCP server if not already running.
 * Run directly: bun broker.ts
 */

import { Database } from "bun:sqlite";
import { normalize } from "node:path";
import {
  DEFAULT_DB_PATH,
  DEFAULT_LOCK_TIMEOUT_MS,
  MAX_LOCK_TIMEOUT_MS,
  RECONNECT_RECAP_LIMIT,
  DEFAULT_GUARDRAILS,
  CLEANUP_INTERVAL,
  BROKER_FEATURES,
} from "./shared/constants.ts";
import { generatePeerId, safeJsonParse } from "./shared/utils.ts";
import { resolveBrokerPort } from "./shared/broker-url.ts";
import type {
  RegisterRequest,
  RegisterResponse,
  HeartbeatRequest,
  SetSummaryRequest,
  ListPeersRequest,
  SendMessageRequest,
  SendMessageResult,
  PollMessagesRequest,
  PollMessagesResponse,
  SetRoleRequest,
  RenamePeerRequest,
  CreateSessionRequest,
  UpdateSessionRequest,
  CreateSlotRequest,
  UpdateSlotRequest,
  AcquireFileRequest,
  AcquireFileResult,
  ReleaseFileRequest,
  AssignOwnershipRequest,
  UpdateGuardrailRequest,
  MessageLogOptions,
  SignalDoneRequest,
  SubmitFeedbackRequest,
  ApproveRequest,
  ReleaseAgentRequest,
  Peer,
  Message,
  Session,
  Slot,
  FileLock,
  FileOwnership,
  AgentType,
  SlotCandidate,
  KnowledgePutRequest,
  KnowledgePutResponse,
  KnowledgeEntry,
  KnowledgeListRequest,
  KnowledgeGetRequest,
  KnowledgeDeleteRequest,
  ActivityAddRequest,
  ActivityEntry,
  LiveActivity,
  ApprovalRequest,
  AddPlanItemRequest,
  EditPlanItemRequest,
} from "./shared/types.ts";

// --- Configuration ---

const PORT = resolveBrokerPort();

const DB_PATH = process.env.MULTIAGENTS_DB ?? DEFAULT_DB_PATH;
const BROKER_VERSION = ((await Bun.file(new URL("./package.json", import.meta.url)).json()) as { version: string }).version;

// Ensure parent directory exists
const dbDir = DB_PATH.substring(0, DB_PATH.lastIndexOf("/"));
if (dbDir) {
  try {
    const { mkdirSync } = require("node:fs");
    mkdirSync(dbDir, { recursive: true });
  } catch {}
}

// --- Database setup ---

const db = new Database(DB_PATH);
db.run("PRAGMA journal_mode = WAL");
db.run("PRAGMA busy_timeout = 3000");

// Original tables
db.run(`
  CREATE TABLE IF NOT EXISTS peers (
    id TEXT PRIMARY KEY,
    pid INTEGER NOT NULL,
    cwd TEXT NOT NULL,
    git_root TEXT,
    tty TEXT,
    summary TEXT NOT NULL DEFAULT '',
    registered_at TEXT NOT NULL,
    last_seen TEXT NOT NULL
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_id TEXT NOT NULL,
    to_id TEXT NOT NULL,
    text TEXT NOT NULL,
    sent_at TEXT NOT NULL,
    delivered INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (from_id) REFERENCES peers(id),
    FOREIGN KEY (to_id) REFERENCES peers(id)
  )
`);

// New tables
db.run(`
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    project_dir TEXT NOT NULL,
    git_root TEXT,
    status TEXT DEFAULT 'active',
    pause_reason TEXT,
    paused_at INTEGER,
    config TEXT DEFAULT '{}',
    created_at INTEGER NOT NULL,
    last_active_at INTEGER NOT NULL
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS slots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    agent_type TEXT NOT NULL,
    display_name TEXT,
    role TEXT,
    role_description TEXT,
    role_assigned_by TEXT,
    peer_id TEXT,
    status TEXT DEFAULT 'disconnected',
    paused INTEGER DEFAULT 0,
    paused_at INTEGER,
    task_state TEXT DEFAULT 'idle',
    last_peer_pid INTEGER,
    last_connected INTEGER,
    last_disconnected INTEGER,
    context_snapshot TEXT,
    input_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    cache_read_tokens INTEGER DEFAULT 0
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS file_locks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    file_path TEXT NOT NULL,
    held_by_slot INTEGER NOT NULL,
    held_by_peer TEXT NOT NULL,
    acquired_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    lock_type TEXT DEFAULT 'exclusive',
    purpose TEXT,
    UNIQUE(session_id, file_path)
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS file_ownership (
    session_id TEXT NOT NULL,
    slot_id INTEGER NOT NULL,
    path_pattern TEXT NOT NULL,
    assigned_at INTEGER NOT NULL,
    assigned_by TEXT,
    PRIMARY KEY (session_id, path_pattern)
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS guardrail_overrides (
    session_id TEXT NOT NULL,
    guardrail_id TEXT NOT NULL,
    value REAL NOT NULL,
    changed_at INTEGER NOT NULL,
    changed_by TEXT,
    reason TEXT,
    PRIMARY KEY (session_id, guardrail_id)
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS guardrail_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    guardrail_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    current_usage REAL,
    limit_value REAL,
    slot_id INTEGER,
    timestamp INTEGER NOT NULL,
    metadata TEXT
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS plans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    title TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS plan_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    plan_id INTEGER NOT NULL REFERENCES plans(id),
    parent_id INTEGER,
    label TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    assigned_to_slot INTEGER,
    completed_at INTEGER,
    sort_order INTEGER DEFAULT 0
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    slot_id INTEGER NOT NULL,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    detail TEXT,
    data TEXT,
    ts INTEGER NOT NULL
  )
`);
db.run("CREATE INDEX IF NOT EXISTS idx_activity_session ON activity (session_id, id)");

db.run(`
  CREATE TABLE IF NOT EXISTS approvals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    slot_id INTEGER NOT NULL,
    tool TEXT NOT NULL,
    title TEXT NOT NULL,
    input TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    always INTEGER NOT NULL DEFAULT 0,
    note TEXT,
    decided_by TEXT,
    created_at INTEGER NOT NULL,
    decided_at INTEGER
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS knowledge (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'context',
    created_by_slot INTEGER,
    created_by_name TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(session_id, key)
  )
`);

// Columns added after a table first shipped; the ALTER fails harmlessly once the column exists.
// Runs after every CREATE TABLE so a fresh database gets them too.
function addColumn(stmt: string): boolean {
  try {
    db.run(stmt);
    return true;
  } catch {
    return false;
  }
}

for (const stmt of [
  "ALTER TABLE peers ADD COLUMN session_id TEXT",
  "ALTER TABLE peers ADD COLUMN slot_id INTEGER",
  "ALTER TABLE peers ADD COLUMN agent_type TEXT DEFAULT 'claude'",
  "ALTER TABLE peers ADD COLUMN status TEXT DEFAULT 'idle'",
  "ALTER TABLE messages ADD COLUMN session_id TEXT",
  "ALTER TABLE messages ADD COLUMN from_slot_id INTEGER",
  "ALTER TABLE messages ADD COLUMN to_slot_id INTEGER",
  "ALTER TABLE messages ADD COLUMN msg_type TEXT DEFAULT 'chat'",
  "ALTER TABLE messages ADD COLUMN delivered_at TEXT",
  "ALTER TABLE messages ADD COLUMN held INTEGER DEFAULT 0",
  "ALTER TABLE slots ADD COLUMN task_state TEXT DEFAULT 'idle'",
  "ALTER TABLE slots ADD COLUMN input_tokens INTEGER DEFAULT 0",
  "ALTER TABLE slots ADD COLUMN output_tokens INTEGER DEFAULT 0",
  "ALTER TABLE slots ADD COLUMN cache_read_tokens INTEGER DEFAULT 0",
  "ALTER TABLE slots ADD COLUMN cost_usd REAL DEFAULT 0",
]) {
  addColumn(stmt);
}

// Before acked_at existed a poll consumed what it returned, so every delivered
// message of an older database counts as acked or it would be replayed.
if (addColumn("ALTER TABLE messages ADD COLUMN acked_at TEXT")) {
  db.run("UPDATE messages SET acked_at = COALESCE(delivered_at, sent_at) WHERE delivered = 1 AND acked_at IS NULL");
}

// Session names without ASCII letters used to slugify to "", leaving a session
// no client can address. Give such a session a real id, in every table.
{
  const orphan = db.query("SELECT created_at FROM sessions WHERE id = ''").get() as { created_at: number } | null;
  if (orphan) {
    let newId = `session-${orphan.created_at.toString(36)}`;
    while (db.query("SELECT 1 FROM sessions WHERE id = ?").get(newId)) newId += "x";
    const tables = (db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[])
      .map((t) => t.name)
      .filter((t) => t !== "sessions" && (db.query(`PRAGMA table_info(${t})`).all() as { name: string }[]).some((c) => c.name === "session_id"));
    db.transaction(() => {
      db.run("PRAGMA defer_foreign_keys = ON");
      db.run("UPDATE sessions SET id = ? WHERE id = ''", [newId]);
      for (const t of tables) db.run(`UPDATE ${t} SET session_id = ? WHERE session_id = ''`, [newId]);
    })();
    console.error(`[multiagents broker] renamed the session with an empty id to "${newId}"`);
  }
}

// --- Context snapshot builder ---

function parseSnapshot(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** Build a rich context snapshot for a disconnecting peer/slot, keeping keys other writers stored (driver session ids). */
function buildContextSnapshot(peer: { summary?: string | null; cwd?: string | null }, slotId: number): string {
  const slotRow = db.query("SELECT task_state, context_snapshot FROM slots WHERE id = ?").get(slotId) as { task_state: string; context_snapshot: string | null } | null;

  // Get plan items assigned to this slot (if any plan exists)
  let planItems: { label: string; status: string }[] = [];
  try {
    const planRow = db.query(
      "SELECT pi.label, pi.status FROM plan_items pi JOIN plans p ON pi.plan_id = p.id JOIN slots s ON p.session_id = s.session_id WHERE pi.assigned_to_slot = ? ORDER BY pi.sort_order",
    ).all(slotId) as { label: string; status: string }[];
    planItems = planRow;
  } catch { /* plan tables may not have data */ }

  return JSON.stringify({
    ...parseSnapshot(slotRow?.context_snapshot),
    last_summary: peer.summary ?? null,
    last_status: "disconnected",
    last_cwd: peer.cwd ?? null,
    task_state: slotRow?.task_state ?? null,
    plan_items: planItems.length > 0 ? planItems : null,
    disconnected_at: Date.now(),
  });
}

// --- Stale peer cleanup ---

function cleanStalePeers() {
  const peers = db.query("SELECT id, pid, summary, cwd FROM peers").all() as { id: string; pid: number; summary: string; cwd: string }[];
  const now = Date.now();

  for (const peer of peers) {
    try {
      process.kill(peer.pid, 0);
    } catch {
      // Disconnect slots for this peer (capture rich snapshot before deleting peer)
      const slots = db.query("SELECT id FROM slots WHERE peer_id = ?").all(peer.id) as any[];
      for (const slot of slots) {
        const snapshot = buildContextSnapshot(peer, slot.id);
        db.run(
          "UPDATE slots SET status = 'disconnected', peer_id = NULL, last_disconnected = ?, context_snapshot = ? WHERE id = ?",
          [now, snapshot, slot.id]
        );
      }

      // Process dead — clean up peer (after snapshot capture). Messages are kept:
      // they are addressed to the slot as well and must reach the respawned agent.
      db.run("DELETE FROM peers WHERE id = ?", [peer.id]);

      // Release file locks held by this peer
      db.run("DELETE FROM file_locks WHERE held_by_peer = ?", [peer.id]);
    }
  }

  // Clean expired file locks
  db.run("DELETE FROM file_locks WHERE expires_at < ?", [now]);

  // Fix dangling slot references: slots that point to a peer_id no longer in the peers table.
  // This happens when a process dies between cleanup cycles or when kill -9 leaves zombies.
  const danglingSlots = db.query(
    "SELECT s.id, s.peer_id FROM slots s WHERE s.peer_id IS NOT NULL AND s.peer_id NOT IN (SELECT id FROM peers)"
  ).all() as { id: number; peer_id: string }[];
  for (const slot of danglingSlots) {
    db.run(
      "UPDATE slots SET status = 'disconnected', peer_id = NULL, last_disconnected = ? WHERE id = ?",
      [now, slot.id]
    );
  }

  // Clean orphan peers: alive processes with no session that have been idle for >5 min.
  // These are typically multiagents-peer adapters spawned by codex mcp-server
  // that outlived their parent process.
  const orphans = db.query(
    "SELECT id, pid, last_seen FROM peers WHERE session_id IS NULL"
  ).all() as { id: string; pid: number; last_seen: string }[];
  for (const orphan of orphans) {
    const idleMs = now - new Date(orphan.last_seen).getTime();
    if (idleMs > 5 * 60 * 1000) {
      // Kill the orphan process
      try { process.kill(orphan.pid, "SIGTERM"); } catch { /* already dead */ }
      db.run("DELETE FROM peers WHERE id = ?", [orphan.id]);
    }
  }
}

const CLEANUP_MS = parseInt(process.env.MULTIAGENTS_CLEANUP_INTERVAL_MS ?? String(CLEANUP_INTERVAL), 10);
cleanStalePeers();
setInterval(cleanStalePeers, CLEANUP_MS);

// --- Prepared statements ---

const insertPeer = db.prepare(`
  INSERT INTO peers (id, pid, cwd, git_root, tty, summary, registered_at, last_seen, session_id, slot_id, agent_type, status)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const updateLastSeen = db.prepare(
  "UPDATE peers SET last_seen = ? WHERE id = ?"
);

const updateSummary = db.prepare(
  "UPDATE peers SET summary = ? WHERE id = ?"
);

const deletePeer = db.prepare(
  "DELETE FROM peers WHERE id = ?"
);

const selectAllPeers = db.prepare(
  "SELECT * FROM peers"
);

const selectPeersByDirectory = db.prepare(
  "SELECT * FROM peers WHERE cwd = ?"
);

const selectPeersByGitRoot = db.prepare(
  "SELECT * FROM peers WHERE git_root = ?"
);

const insertMessage = db.prepare(`
  INSERT INTO messages (from_id, to_id, text, sent_at, delivered, session_id, from_slot_id, to_slot_id, msg_type, held)
  VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?)
`);

// A message follows the slot: a peer respawned into it receives what was addressed to its predecessor.
const selectUnacked = db.prepare(
  "SELECT * FROM messages WHERE (to_id = ? OR to_slot_id = ?) AND acked_at IS NULL AND held = 0 ORDER BY sent_at ASC"
);

const selectUnclaimed = db.prepare(
  "SELECT * FROM messages WHERE (to_id = ? OR to_slot_id = ?) AND delivered = 0 AND held = 0 ORDER BY sent_at ASC"
);

const selectUnackedBySlot = db.prepare(
  "SELECT * FROM messages WHERE to_slot_id = ? AND acked_at IS NULL AND held = 0 ORDER BY sent_at ASC"
);

const markDelivered = db.prepare(
  "UPDATE messages SET delivered = 1, delivered_at = COALESCE(delivered_at, ?) WHERE id = ?"
);

const markAcked = db.prepare(
  "UPDATE messages SET acked_at = ? WHERE id = ? AND acked_at IS NULL"
);

// --- Request handlers ---

function handleRegister(body: RegisterRequest): RegisterResponse {
  const agentType: AgentType = body.agent_type ?? "claude";
  const id = generatePeerId(agentType);
  const now = new Date().toISOString();
  const nowMs = Date.now();

  // Remove any existing registration for this PID
  const existing = db.query("SELECT id FROM peers WHERE pid = ?").get(body.pid) as { id: string } | null;
  if (existing) {
    deletePeer.run(existing.id);
  }

  // Explicit slot targeting — when orchestrator passes a specific slot_id
  // Resolve session_id: explicit > inferred from the slot's own record.
  // This fallback covers sandboxed agents (Codex, Gemini) that may lose
  // MULTIAGENTS_SESSION env var but still have MULTIAGENTS_SLOT.
  let effectiveSessionId = body.session_id;
  if (body.slot_id && !effectiveSessionId) {
    const slotRow = db.query("SELECT session_id FROM slots WHERE id = ?").get(body.slot_id) as { session_id: string } | null;
    if (slotRow) effectiveSessionId = slotRow.session_id;
  }

  if (body.slot_id && effectiveSessionId) {
    const targetSlot = db.query(
      "SELECT * FROM slots WHERE id = ? AND session_id = ?"
    ).get(body.slot_id, effectiveSessionId) as Slot | null;

    if (targetSlot) {
      insertPeer.run(id, body.pid, body.cwd, body.git_root, body.tty, body.summary, now, now, effectiveSessionId, targetSlot.id, agentType, "idle");
      db.run(
        "UPDATE slots SET peer_id = ?, status = 'connected', last_connected = ?, last_peer_pid = ? WHERE id = ?",
        [id, nowMs, body.pid, targetSlot.id]
      );
      const recap = db.query(
        "SELECT * FROM messages WHERE session_id = ? AND to_slot_id = ? ORDER BY sent_at DESC LIMIT ?"
      ).all(effectiveSessionId, targetSlot.id, RECONNECT_RECAP_LIMIT) as Message[];
      recap.reverse();
      const updatedSlot = db.query("SELECT * FROM slots WHERE id = ?").get(targetSlot.id) as Slot;
      return { id, slot: updatedSlot, recap };
    }
  }

  // Reconnect logic — match by role first, then by agent_type
  if (body.reconnect && body.session_id) {
    let disconnectedSlots = db.query(
      "SELECT * FROM slots WHERE session_id = ? AND agent_type = ? AND status = 'disconnected'"
    ).all(body.session_id, agentType) as Slot[];

    // If multiple matches and a role is provided, narrow by role
    if (disconnectedSlots.length > 1 && body.role) {
      const roleMatches = disconnectedSlots.filter((s) => s.role === body.role);
      if (roleMatches.length >= 1) {
        disconnectedSlots = roleMatches;
      }
    }

    if (disconnectedSlots.length >= 1) {
      // Pick the first match (exact role match preferred, or only candidate)
      const slot = disconnectedSlots[0];
      if (!slot) {
        return { id };
      }
      insertPeer.run(id, body.pid, body.cwd, body.git_root, body.tty, body.summary, now, now, body.session_id, slot.id, agentType, "idle");
      db.run(
        "UPDATE slots SET peer_id = ?, status = 'connected', last_connected = ?, last_peer_pid = ? WHERE id = ?",
        [id, nowMs, body.pid, slot.id]
      );

      const recap = db.query(
        "SELECT * FROM messages WHERE session_id = ? AND to_slot_id = ? ORDER BY sent_at DESC LIMIT ?"
      ).all(body.session_id, slot.id, RECONNECT_RECAP_LIMIT) as Message[];
      recap.reverse();

      const updatedSlot = db.query("SELECT * FROM slots WHERE id = ?").get(slot.id) as Slot;
      return { id, slot: updatedSlot, recap };
    }
    // 0 matches — fall through to create new slot if session exists
  }

  // Default registration (possibly with session)
  let slotResult: Slot | undefined;
  let slotId: number | null = null;

  if (body.session_id) {
    const session = db.query("SELECT id FROM sessions WHERE id = ?").get(body.session_id);
    if (session) {
      const res = db.run(
        "INSERT INTO slots (session_id, agent_type, display_name, role, status, last_connected, last_peer_pid) VALUES (?, ?, ?, ?, 'connected', ?, ?)",
        [body.session_id, agentType, body.display_name ?? null, body.role ?? null, nowMs, body.pid]
      );
      slotId = Number(res.lastInsertRowid);
      db.run("UPDATE sessions SET last_active_at = ? WHERE id = ?", [nowMs, body.session_id]);
    }
  }

  insertPeer.run(id, body.pid, body.cwd, body.git_root, body.tty, body.summary, now, now, body.session_id ?? null, slotId, agentType, "idle");

  if (slotId !== null) {
    db.run("UPDATE slots SET peer_id = ? WHERE id = ?", [id, slotId]);
    slotResult = db.query("SELECT * FROM slots WHERE id = ?").get(slotId) as Slot;
  }

  return slotResult ? { id, slot: slotResult } : { id };
}

function handleHeartbeat(body: HeartbeatRequest): void {
  updateLastSeen.run(new Date().toISOString(), body.id);
}

function handleSetSummary(body: SetSummaryRequest): void {
  updateSummary.run(body.summary, body.id);
}

function handleListPeers(body: ListPeersRequest): Peer[] {
  let peers: Peer[];

  switch (body.scope) {
    case "machine":
      peers = selectAllPeers.all() as Peer[];
      break;
    case "directory":
      peers = selectPeersByDirectory.all(body.cwd) as Peer[];
      break;
    case "repo":
      if (body.git_root) {
        peers = selectPeersByGitRoot.all(body.git_root) as Peer[];
      } else {
        peers = selectPeersByDirectory.all(body.cwd) as Peer[];
      }
      break;
    default:
      peers = selectAllPeers.all() as Peer[];
  }

  // Filter by agent_type
  if (body.agent_type && body.agent_type !== "all") {
    peers = peers.filter((p) => p.agent_type === body.agent_type);
  }

  // Filter by session_id
  if (body.session_id) {
    peers = peers.filter((p) => p.session_id === body.session_id);
  }

  // Exclude the requesting peer
  if (body.exclude_id) {
    peers = peers.filter((p) => p.id !== body.exclude_id);
  }

  // Verify each peer's process is still alive
  return peers.filter((p) => {
    try {
      process.kill(p.pid, 0);
      return true;
    } catch {
      deletePeer.run(p.id);
      return false;
    }
  });
}

function handleSendMessage(body: SendMessageRequest): SendMessageResult {
  const now = new Date().toISOString();
  let toId = body.to_id;
  let toSlotId = body.to_slot_id ?? null;
  const msgType = body.msg_type ?? "chat";
  const sessionId = body.session_id ?? null;

  // Resolve to_slot_id to to_id if needed
  if (!toId && toSlotId) {
    const slot = db.query("SELECT peer_id FROM slots WHERE id = ?").get(toSlotId) as { peer_id: string | null } | null;
    if (!slot) return { ok: false, error: `Slot ${toSlotId} not found` };
    // Slot may have no peer_id if managed by CodexDriver — message is stored
    // with to_slot_id and picked up by pollBySlot endpoint.
    toId = slot.peer_id ?? `__slot_${toSlotId}__`;
  }

  if (!toId) return { ok: false, error: "No target specified" };

  // Allow messages to "orchestrator" and driver-managed slots (no real peer_id)
  // "human" is the person at the dashboard: its messages are read there, never polled
  const isSpecialTarget = toId === "orchestrator" || toId === "__orchestrator__" || toId === "human" || toId.startsWith("__slot_");

  // Verify target exists (unless targeting orchestrator or driver-managed slot)
  if (!isSpecialTarget) {
    const target = db.query("SELECT id FROM peers WHERE id = ?").get(toId) as { id: string } | null;
    if (!target) return { ok: false, error: `Peer ${toId} not found` };
  }

  // Determine from_slot_id
  let fromSlotId: number | null = null;
  const fromPeer = db.query("SELECT slot_id FROM peers WHERE id = ?").get(body.from_id) as { slot_id: number | null } | null;
  if (fromPeer) fromSlotId = fromPeer.slot_id;

  // Check if target slot is paused
  let held = 0;
  if (toSlotId) {
    const targetSlot = db.query("SELECT paused FROM slots WHERE id = ?").get(toSlotId) as { paused: number } | null;
    if (targetSlot?.paused) held = 1;
  } else {
    // Look up slot from peer
    const targetPeer = db.query("SELECT slot_id FROM peers WHERE id = ?").get(toId) as { slot_id: number | null } | null;
    if (targetPeer?.slot_id) {
      toSlotId = targetPeer.slot_id;
      const targetSlot = db.query("SELECT paused FROM slots WHERE id = ?").get(toSlotId) as { paused: number } | null;
      if (targetSlot?.paused) held = 1;
    }
  }

  insertMessage.run(body.from_id, toId, body.text, now, sessionId, fromSlotId, toSlotId, msgType, held);

  const warning = held ? "Message held — target agent is paused" : undefined;
  return { ok: true, warning };
}

function handlePollMessages(body: PollMessagesRequest): PollMessagesResponse {
  // Check if the peer's slot is paused
  const peer = db.query("SELECT slot_id FROM peers WHERE id = ?").get(body.id) as { slot_id: number | null } | null;
  if (peer?.slot_id) {
    const slot = db.query("SELECT paused FROM slots WHERE id = ?").get(peer.slot_id) as { paused: number } | null;
    if (slot?.paused) {
      return { messages: [], paused: true };
    }
  }

  const rows = (body.unclaimed_only ? selectUnclaimed : selectUnacked).all(body.id, peer?.slot_id ?? null) as Message[];
  return { messages: handOff(qaFilter(peer?.slot_id ?? null, rows), body.retain !== true) };
}

const selectSlotSessionConfig = db.prepare(
  "SELECT s.config AS config FROM slots sl JOIN sessions s ON s.id = sl.session_id WHERE sl.id = ?"
);

/**
 * Q&A mode (session config `qa_mode`): the team's work is on hold and agents
 * only hear the person and the orchestrator; teammates' messages wait (stay
 * unclaimed) until the mode ends.
 */
function qaFilter(slotId: number | null, rows: Message[]): Message[] {
  if (slotId === null || rows.length === 0) return rows;
  const row = selectSlotSessionConfig.get(slotId) as { config: string | null } | null;
  if (!safeJsonParse<Record<string, unknown>>(row?.config ?? "{}", {}).qa_mode) return rows;
  return rows.filter((m) => m.from_id === "human" || m.from_id === "orchestrator" || m.from_id === "__orchestrator__");
}

/** Poll a slot's messages (driver-managed agents have no peer id). */
function handlePollBySlot(body: { slot_id: number; session_id?: string; retain?: boolean }): PollMessagesResponse {
  const slot = db.query("SELECT paused FROM slots WHERE id = ?").get(body.slot_id) as { paused: number } | null;
  if (slot?.paused) return { messages: [], paused: true };

  return { messages: handOff(qaFilter(body.slot_id, selectUnackedBySlot.all(body.slot_id) as Message[]), body.retain !== true) };
}

/**
 * Hand messages to a delivery mechanism. A plain poll consumes them (acked at
 * once); a `retain` poll keeps them pollable until the client acks them itself.
 */
function handOff(messages: Message[], consume: boolean): Message[] {
  const now = new Date().toISOString();
  for (const msg of messages) {
    if (!msg.delivered) {
      markDelivered.run(now, msg.id);
      msg.delivered = 1 as unknown as boolean;
      msg.delivered_at = now;
    }
    if (consume) {
      markAcked.run(now, msg.id);
      msg.acked_at = now;
    }
  }
  return messages;
}

/** Mark messages as acked: they reached the model and will not be polled again. */
function handleAckMessages(body: { ids?: unknown }): { ok: boolean; acked: number } {
  const now = new Date().toISOString();
  const ids = Array.isArray(body.ids) ? body.ids.filter((id): id is number => Number.isInteger(id)) : [];
  let acked = 0;
  for (const id of ids) {
    acked += markAcked.run(now, id).changes;
  }
  return { ok: true, acked };
}

function handleUnregister(body: { id: string }): { ok: boolean; denied?: boolean; reason?: string; task_state?: string } {
  const now = Date.now();
  // Look up peer and its slot
  const peer = db.query("SELECT slot_id, summary, cwd FROM peers WHERE id = ?").get(body.id) as any;
  if (peer?.slot_id) {
    // Check task_state gating — in a session, agents can ONLY disconnect when explicitly released
    const slot = db.query("SELECT task_state, session_id FROM slots WHERE id = ?").get(peer.slot_id) as any;
    if (slot && slot.session_id && slot.task_state !== "released") {
      return {
        ok: false,
        denied: true,
        reason: `Cannot disconnect: task_state is '${slot.task_state}'. Only the team lead or orchestrator can release you. Stay active, communicate with your team, and wait for release.`,
        task_state: slot.task_state,
      };
    }

    const snapshot = buildContextSnapshot(peer, peer.slot_id);
    db.run(
      "UPDATE slots SET status = 'disconnected', peer_id = NULL, last_disconnected = ?, context_snapshot = ? WHERE id = ?",
      [now, snapshot, peer.slot_id]
    );
    // Release file locks
    db.run("DELETE FROM file_locks WHERE held_by_peer = ?", [body.id]);
  }
  deletePeer.run(body.id);
  return { ok: true };
}

// --- Role & rename ---

function handleSetRole(body: SetRoleRequest): { ok: boolean } {
  const slotId = body.slot_id;
  if (slotId) {
    db.run(
      "UPDATE slots SET role = ?, role_description = ?, role_assigned_by = ? WHERE id = ?",
      [body.role, body.role_description, body.assigner_id, slotId]
    );
  }
  // Insert system message to target
  const now = new Date().toISOString();
  const text = JSON.stringify({ role: body.role, role_description: body.role_description });
  insertMessage.run(body.assigner_id, body.peer_id, text, now, null, null, slotId ?? null, "role_assignment", 0);
  return { ok: true };
}

function handleRenamePeer(body: RenamePeerRequest): { ok: boolean } {
  if (body.slot_id) {
    db.run("UPDATE slots SET display_name = ? WHERE id = ?", [body.display_name, body.slot_id]);
  }
  const now = new Date().toISOString();
  const text = JSON.stringify({ display_name: body.display_name });
  insertMessage.run(body.assigner_id, body.peer_id, text, now, null, null, body.slot_id ?? null, "rename", 0);
  return { ok: true };
}

// --- Knowledge Store ---

function handleKnowledgePut(body: KnowledgePutRequest): KnowledgePutResponse {
  if (!body.session_id) throw new Error("session_id required");
  if (!body.key || !body.key.trim()) throw new Error("key required");
  if (!body.value || !body.value.trim()) throw new Error("value required");

  const now = Date.now();
  const category = body.category ?? "context";

  // Check existence first for created/updated distinction, then upsert atomically.
  // Both are synchronous bun:sqlite calls in the same event loop tick — no race window.
  const existed = db.query("SELECT 1 FROM knowledge WHERE session_id = ? AND key = ?").get(body.session_id, body.key) !== null;

  db.run(
    `INSERT INTO knowledge (session_id, key, value, category, created_by_slot, created_by_name, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_id, key) DO UPDATE SET
       value = excluded.value,
       category = excluded.category,
       created_by_slot = excluded.created_by_slot,
       created_by_name = excluded.created_by_name,
       updated_at = excluded.updated_at`,
    [body.session_id, body.key, body.value, category, body.slot_id ?? null, body.slot_name ?? null, now, now]
  );

  const entry = db.query("SELECT * FROM knowledge WHERE session_id = ? AND key = ?").get(body.session_id, body.key) as KnowledgeEntry;
  return { ok: true, entry, action: existed ? "updated" : "created" };
}

function handleKnowledgeGet(body: KnowledgeGetRequest): KnowledgeEntry | { error: string } {
  if (!body.session_id) throw new Error("session_id required");
  if (!body.key) throw new Error("key required");
  const entry = db.query("SELECT * FROM knowledge WHERE session_id = ? AND key = ?").get(body.session_id, body.key) as KnowledgeEntry | null;
  if (!entry) return { error: `No knowledge entry found for key "${body.key}"` };
  return entry;
}

function handleKnowledgeList(body: KnowledgeListRequest): KnowledgeEntry[] {
  if (!body.session_id) return [];
  if (body.category) {
    return db.query("SELECT * FROM knowledge WHERE session_id = ? AND category = ? ORDER BY updated_at DESC").all(body.session_id, body.category) as KnowledgeEntry[];
  }
  return db.query("SELECT * FROM knowledge WHERE session_id = ? ORDER BY updated_at DESC").all(body.session_id) as KnowledgeEntry[];
}

function handleKnowledgeDelete(body: KnowledgeDeleteRequest): { ok: boolean } {
  if (!body.session_id) throw new Error("session_id required");
  if (!body.key) throw new Error("key required");
  db.run("DELETE FROM knowledge WHERE session_id = ? AND key = ?", [body.session_id, body.key]);
  return { ok: true };
}

// --- Sessions ---

function handleCreateSession(body: CreateSessionRequest): Session {
  if (typeof body.id !== "string" || !body.id.trim()) throw new Error("Session id must not be empty");
  const now = Date.now();
  db.run(
    "INSERT INTO sessions (id, name, project_dir, git_root, status, config, created_at, last_active_at) VALUES (?, ?, ?, ?, 'active', ?, ?, ?)",
    [body.id, body.name, body.project_dir, body.git_root ?? null, JSON.stringify(body.config ?? {}), now, now]
  );
  return db.query("SELECT * FROM sessions WHERE id = ?").get(body.id) as Session;
}

function handleGetSession(body: { id: string }): Session | null {
  return (db.query("SELECT * FROM sessions WHERE id = ?").get(body.id) as Session) ?? null;
}

function handleListSessions(): Session[] {
  return db.query("SELECT * FROM sessions ORDER BY last_active_at DESC").all() as Session[];
}

function handleDeleteSession(body: { id: string }): { ok: boolean; deleted: { slots: number; messages: number; plans: number; locks: number } } {
  const session = db.query("SELECT id FROM sessions WHERE id = ?").get(body.id) as { id: string } | null;
  if (!session) return { ok: false, deleted: { slots: 0, messages: 0, plans: 0, locks: 0 } };

  // Delete in dependency order: plan_items → plans → messages → file_locks → file_ownership → slots → session
  const plans = db.query("SELECT id FROM plans WHERE session_id = ?").all(body.id) as { id: number }[];
  for (const plan of plans) {
    db.run("DELETE FROM plan_items WHERE plan_id = ?", [plan.id]);
  }
  const planCount = plans.length;
  db.run("DELETE FROM plans WHERE session_id = ?", [body.id]);

  const msgResult = db.run("DELETE FROM messages WHERE session_id = ?", [body.id]);
  const msgCount = msgResult.changes;

  db.run("DELETE FROM file_locks WHERE session_id = ?", [body.id]);
  db.run("DELETE FROM file_ownership WHERE session_id = ?", [body.id]);

  // Delete peers associated with this session's slots
  const slots = db.query("SELECT id, peer_id FROM slots WHERE session_id = ?").all(body.id) as { id: number; peer_id: string | null }[];
  for (const slot of slots) {
    if (slot.peer_id) {
      db.run("DELETE FROM peers WHERE id = ?", [slot.peer_id]);
    }
  }
  const slotResult = db.run("DELETE FROM slots WHERE session_id = ?", [body.id]);
  const slotCount = slotResult.changes;

  // Delete guardrail overrides and events
  db.run("DELETE FROM guardrail_overrides WHERE session_id = ?", [body.id]);
  db.run("DELETE FROM guardrail_events WHERE session_id = ?", [body.id]);

  // Delete knowledge entries, the activity timeline and approvals
  db.run("DELETE FROM knowledge WHERE session_id = ?", [body.id]);
  db.run("DELETE FROM activity WHERE session_id = ?", [body.id]);
  db.run("DELETE FROM approvals WHERE session_id = ?", [body.id]);

  db.run("DELETE FROM sessions WHERE id = ?", [body.id]);

  return { ok: true, deleted: { slots: slotCount, messages: msgCount, plans: planCount, locks: 0 } };
}

function handleUpdateSession(body: UpdateSessionRequest): Session | null {
  const fields: string[] = [];
  const values: any[] = [];

  if (body.status !== undefined) { fields.push("status = ?"); values.push(body.status); }
  if (body.pause_reason !== undefined) { fields.push("pause_reason = ?"); values.push(body.pause_reason); }
  if (body.paused_at !== undefined) { fields.push("paused_at = ?"); values.push(body.paused_at); }
  let config = body.config;
  if (body.config_patch !== undefined) {
    const current = config ?? parseSnapshot((db.query("SELECT config FROM sessions WHERE id = ?").get(body.id) as { config: string | null } | null)?.config ?? null);
    config = { ...current, ...body.config_patch };
  }
  if (config !== undefined) { fields.push("config = ?"); values.push(JSON.stringify(config)); }

  fields.push("last_active_at = ?");
  values.push(Date.now());
  values.push(body.id);

  if (fields.length > 0) {
    db.run(`UPDATE sessions SET ${fields.join(", ")} WHERE id = ?`, values);
  }
  return (db.query("SELECT * FROM sessions WHERE id = ?").get(body.id) as Session) ?? null;
}

// --- Slots ---

function handleCreateSlot(body: CreateSlotRequest): Slot {
  const res = db.run(
    "INSERT INTO slots (session_id, agent_type, display_name, role, role_description) VALUES (?, ?, ?, ?, ?)",
    [body.session_id, body.agent_type, body.display_name ?? null, body.role ?? null, body.role_description ?? null]
  );
  return db.query("SELECT * FROM slots WHERE id = ?").get(Number(res.lastInsertRowid)) as Slot;
}

function handleGetSlot(body: { id: number }): Slot | null {
  return (db.query("SELECT * FROM slots WHERE id = ?").get(body.id) as Slot) ?? null;
}

function handleListSlots(body: { session_id: string }): Slot[] {
  return db.query("SELECT * FROM slots WHERE session_id = ?").all(body.session_id) as Slot[];
}

function handleUpdateSlot(body: UpdateSlotRequest): Slot | null {
  const fields: string[] = [];
  const values: any[] = [];

  if (body.peer_id !== undefined) { fields.push("peer_id = ?"); values.push(body.peer_id); }
  if (body.paused !== undefined) { fields.push("paused = ?"); values.push(body.paused ? 1 : 0); }
  if (body.paused_at !== undefined) { fields.push("paused_at = ?"); values.push(body.paused_at); }
  // Only accept valid slot statuses — reject "archived" or other ghost values
  if (body.status !== undefined && (body.status === "connected" || body.status === "disconnected")) {
    fields.push("status = ?"); values.push(body.status);
    // Auto-set last_disconnected when transitioning to disconnected.
    // Without this, the auto-cleanup loop uses last_connected as fallback,
    // which makes slots that ran for >5 min look like they've been dead
    // for >5 min and get deleted immediately.
    if (body.status === "disconnected") {
      fields.push("last_disconnected = ?"); values.push(Date.now());
    } else {
      fields.push("last_connected = ?"); values.push(Date.now());
    }
  }
  let snapshot = body.context_snapshot;
  if (body.context_patch !== undefined) {
    const current = snapshot ?? (db.query("SELECT context_snapshot FROM slots WHERE id = ?").get(body.id) as { context_snapshot: string | null } | null)?.context_snapshot;
    snapshot = JSON.stringify({ ...parseSnapshot(current), ...body.context_patch });
  }
  if (snapshot !== undefined) { fields.push("context_snapshot = ?"); values.push(snapshot); }
  if (body.display_name !== undefined) { fields.push("display_name = ?"); values.push(body.display_name); }
  if (body.role !== undefined) { fields.push("role = ?"); values.push(body.role); }
  if (body.role_description !== undefined) { fields.push("role_description = ?"); values.push(body.role_description); }
  if (body.task_state !== undefined) { fields.push("task_state = ?"); values.push(body.task_state); }
  if (body.input_tokens !== undefined) { fields.push("input_tokens = input_tokens + ?"); values.push(body.input_tokens); }
  if (body.output_tokens !== undefined) { fields.push("output_tokens = output_tokens + ?"); values.push(body.output_tokens); }
  if (body.cache_read_tokens !== undefined) { fields.push("cache_read_tokens = cache_read_tokens + ?"); values.push(body.cache_read_tokens); }
  if (body.cost_usd !== undefined) { fields.push("cost_usd = COALESCE(cost_usd, 0) + ?"); values.push(body.cost_usd); }

  if (fields.length > 0) {
    values.push(body.id);
    db.run(`UPDATE slots SET ${fields.join(", ")} WHERE id = ?`, values);
  }
  if (body.peer_id !== undefined && body.peer_id !== null) {
    const slot = db.query("SELECT session_id FROM slots WHERE id = ?").get(body.id) as { session_id: string } | null;
    if (slot) {
      db.run("UPDATE peers SET slot_id = ?, session_id = ? WHERE id = ?", [body.id, slot.session_id, body.peer_id]);
    }
  }
  return (db.query("SELECT * FROM slots WHERE id = ?").get(body.id) as Slot) ?? null;
}

/** Delete a slot and its associated file locks, ownership, and orphaned peer. */
function handleDeleteSlot(body: { id: number }): { ok: boolean; deleted: boolean } {
  const existing = db.query("SELECT id, peer_id FROM slots WHERE id = ?").get(body.id) as { id: number; peer_id: string | null } | null;
  if (!existing) return { ok: true, deleted: false };

  // Clean up associated data (file_locks uses "held_by_slot", not "slot_id")
  db.run("DELETE FROM file_locks WHERE held_by_slot = ?", [body.id]);
  db.run("DELETE FROM file_ownership WHERE slot_id = ?", [body.id]);
  // Remove the orphaned peer record if any
  if (existing.peer_id) {
    db.run("DELETE FROM peers WHERE id = ?", [existing.peer_id]);
  }
  db.run("DELETE FROM slots WHERE id = ?", [body.id]);
  return { ok: true, deleted: true };
}

// --- File locks & ownership ---

function handleAcquireFile(body: AcquireFileRequest): AcquireFileResult {
  const now = Date.now();
  const timeout = Math.min(body.timeout_ms ?? DEFAULT_LOCK_TIMEOUT_MS, MAX_LOCK_TIMEOUT_MS);
  const expiresAt = now + timeout;

  // Normalize the file path and strip leading ../ segments
  const filePath = normalize(body.file_path).replace(/^(\.\.[/\\])+/, "");

  // Check ownership zones — deny if file matches another slot's pattern
  const ownerships = db.query(
    "SELECT * FROM file_ownership WHERE session_id = ? AND slot_id != ?"
  ).all(body.session_id, body.slot_id) as FileOwnership[];

  for (const own of ownerships) {
    if (fileMatchesPattern(filePath, own.path_pattern)) {
      const ownerSlot = db.query("SELECT display_name FROM slots WHERE id = ?").get(own.slot_id) as { display_name: string | null } | null;
      return {
        status: "denied",
        owner: ownerSlot?.display_name ?? `slot-${own.slot_id}`,
        pattern: own.path_pattern,
        message: `File is in ownership zone of ${ownerSlot?.display_name ?? `slot-${own.slot_id}`} (pattern: ${own.path_pattern})`,
      };
    }
  }

  // Check existing locks
  const existing = db.query(
    "SELECT * FROM file_locks WHERE session_id = ? AND file_path = ? AND expires_at > ?"
  ).get(body.session_id, filePath, now) as FileLock | null;

  if (existing) {
    if (existing.held_by_slot === body.slot_id) {
      // Extend
      db.run("UPDATE file_locks SET expires_at = ? WHERE id = ?", [expiresAt, existing.id]);
      return { status: "extended", expires_at: expiresAt, message: "Lock extended" };
    }
    const holderSlot = db.query("SELECT display_name FROM slots WHERE id = ?").get(existing.held_by_slot) as { display_name: string | null } | null;
    return {
      status: "locked",
      held_by: holderSlot?.display_name ?? `slot-${existing.held_by_slot}`,
      expires_at: existing.expires_at,
      wait_estimate_ms: existing.expires_at - now,
      message: `File locked by ${holderSlot?.display_name ?? `slot-${existing.held_by_slot}`}`,
    };
  }

  // Acquire
  db.run(
    "INSERT INTO file_locks (session_id, file_path, held_by_slot, held_by_peer, acquired_at, expires_at, lock_type, purpose) VALUES (?, ?, ?, ?, ?, ?, 'exclusive', ?)",
    [body.session_id, filePath, body.slot_id, body.peer_id, now, expiresAt, body.purpose ?? null]
  );
  return { status: "acquired", expires_at: expiresAt, message: "Lock acquired" };
}

function handleReleaseFile(body: ReleaseFileRequest): { ok: boolean } {
  // Normalize the file path and strip leading ../ segments
  const filePath = normalize(body.file_path).replace(/^(\.\.[/\\])+/, "");
  db.run(
    "DELETE FROM file_locks WHERE session_id = ? AND file_path = ? AND held_by_peer = ?",
    [body.session_id, filePath, body.peer_id]
  );
  return { ok: true };
}

function handleAssignOwnership(body: AssignOwnershipRequest): { ok: boolean; status: string; message?: string } {
  for (const pattern of body.path_patterns) {
    // Check for overlapping patterns from other slots
    const conflict = db.query(
      "SELECT * FROM file_ownership WHERE session_id = ? AND slot_id != ? AND path_pattern = ?"
    ).get(body.session_id, body.slot_id, pattern) as FileOwnership | null;

    if (conflict) {
      return {
        ok: false,
        status: "conflict",
        message: `Pattern "${pattern}" already assigned to slot ${conflict.slot_id}`,
      };
    }
  }

  for (const pattern of body.path_patterns) {
    db.run(
      "INSERT OR REPLACE INTO file_ownership (session_id, slot_id, path_pattern, assigned_at, assigned_by) VALUES (?, ?, ?, ?, ?)",
      [body.session_id, body.slot_id, pattern, Date.now(), body.assigned_by]
    );
  }
  return { ok: true, status: "assigned" };
}

function handleListLocks(body: { session_id: string }): FileLock[] {
  const now = Date.now();
  return db.query(
    "SELECT * FROM file_locks WHERE session_id = ? AND expires_at > ?"
  ).all(body.session_id, now) as FileLock[];
}

function handleListOwnership(body: { session_id: string }): FileOwnership[] {
  return db.query(
    "SELECT * FROM file_ownership WHERE session_id = ?"
  ).all(body.session_id) as FileOwnership[];
}

function fileMatchesPattern(filePath: string, pattern: string): boolean {
  // Simple glob: "src/auth/*" matches "src/auth/login.ts"
  // Convert glob to regex
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "<<<GLOBSTAR>>>")
    .replace(/\*/g, "[^/]*")
    .replace(/<<<GLOBSTAR>>>/g, ".*");
  const re = new RegExp(`^${escaped}$`);
  return re.test(filePath);
}

// --- Guardrails ---

function computeGuardrailUsage(guardrailId: string, limit: number, warnPct: number, sessionId: string, action: string): { current: number; limit: number; percent: number; status: "ok" | "warning" | "triggered" } {
  let current = 0;

  switch (guardrailId) {
    case "session_duration": {
      const session = db.query("SELECT created_at FROM sessions WHERE id = ?").get(sessionId) as { created_at: number } | null;
      current = session ? (Date.now() - session.created_at) / 60000 : 0;
      break;
    }
    case "messages_total": {
      const row = db.query(
        "SELECT COUNT(*) as cnt FROM messages WHERE session_id = ?"
      ).get(sessionId) as { cnt: number };
      current = row.cnt;
      break;
    }
    case "messages_per_agent": {
      const rows = db.query(
        "SELECT from_slot_id, COUNT(*) as cnt FROM messages WHERE session_id = ? AND from_slot_id IS NOT NULL GROUP BY from_slot_id"
      ).all(sessionId) as { from_slot_id: number; cnt: number }[];
      current = rows.reduce((max, r) => Math.max(max, r.cnt), 0);
      break;
    }
    case "agent_count": {
      const row = db.query(
        "SELECT COUNT(*) as cnt FROM slots WHERE session_id = ? AND status = 'connected'"
      ).get(sessionId) as { cnt: number };
      current = row.cnt;
      break;
    }
    case "max_restarts": {
      const rows = db.query(
        "SELECT slot_id, COUNT(*) as cnt FROM guardrail_events WHERE session_id = ? AND event_type = 'agent_exited' AND slot_id IS NOT NULL GROUP BY slot_id"
      ).all(sessionId) as { slot_id: number; cnt: number }[];
      current = rows.reduce((max, r) => Math.max(max, r.cnt), 0);
      break;
    }
    case "idle_max": {
      const peers = db.query(
        "SELECT last_seen FROM peers WHERE session_id = ?"
      ).all(sessionId) as { last_seen: string }[];
      if (peers.length > 0) {
        const now = Date.now();
        const maxAge = peers.reduce((max, p) => {
          const age = (now - new Date(p.last_seen).getTime()) / 60000;
          return Math.max(max, age);
        }, 0);
        current = maxAge;
      }
      break;
    }
  }

  // Monitor-only stats: always "ok", no enforcement
  if (action === "monitor") {
    return { current, limit: 0, percent: 0, status: "ok" };
  }

  const percent = limit > 0 ? current / limit : 0;
  const status = percent >= 1 ? "triggered" : percent >= warnPct ? "warning" : "ok";
  return { current, limit, percent, status };
}

function handleGetGuardrails(body: { session_id: string }) {
  const overrides = db.query(
    "SELECT guardrail_id, value FROM guardrail_overrides WHERE session_id = ?"
  ).all(body.session_id) as { guardrail_id: string; value: number }[];

  const overrideMap = new Map(overrides.map((o) => [o.guardrail_id, o.value]));

  return DEFAULT_GUARDRAILS.map((g) => {
    const overridden = overrideMap.has(g.id);
    const currentValue = overrideMap.get(g.id) ?? g.default_value;
    const usage = computeGuardrailUsage(g.id, currentValue, g.warn_at_percent, body.session_id, g.action);
    return {
      ...g,
      current_value: currentValue,
      is_overridden: overridden,
      usage,
    };
  });
}

function handleUpdateGuardrail(body: UpdateGuardrailRequest) {
  const now = Date.now();
  db.run(
    "INSERT OR REPLACE INTO guardrail_overrides (session_id, guardrail_id, value, changed_at, changed_by, reason) VALUES (?, ?, ?, ?, ?, ?)",
    [body.session_id, body.guardrail_id, body.new_value, now, body.changed_by, body.reason ?? null]
  );
  // Log event
  db.run(
    "INSERT INTO guardrail_events (session_id, guardrail_id, event_type, limit_value, timestamp, metadata) VALUES (?, ?, 'override', ?, ?, ?)",
    [body.session_id, body.guardrail_id, body.new_value, now, JSON.stringify({ changed_by: body.changed_by, reason: body.reason })]
  );
  // Return the full updated guardrail state
  const allGuardrails = handleGetGuardrails({ session_id: body.session_id });
  return allGuardrails.find((g) => g.id === body.guardrail_id) ?? allGuardrails[0];
}

// --- Plans ---

const PLAN_ITEM_STATUSES = new Set(["pending", "in_progress", "blocked", "done"]);

interface CreatePlanRequest {
  session_id: string;
  title: string;
  items: { label: string; assigned_to_slot?: number; parent_id?: number }[];
}

function handleCreatePlan(body: CreatePlanRequest) {
  const now = Date.now();
  const existing = db.query("SELECT id FROM plans WHERE session_id = ?").get(body.session_id) as { id: number } | null;
  if (existing) {
    // Delete old plan items and plan, then recreate
    db.run("DELETE FROM plan_items WHERE plan_id = ?", [existing.id]);
    db.run("DELETE FROM plans WHERE id = ?", [existing.id]);
  }

  db.run(
    "INSERT INTO plans (session_id, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
    [body.session_id, body.title, now, now],
  );
  const plan = db.query("SELECT * FROM plans WHERE session_id = ? ORDER BY id DESC LIMIT 1").get(body.session_id) as any;

  for (let i = 0; i < body.items.length; i++) {
    const item = body.items[i];
    if (!item) continue;
    db.run(
      "INSERT INTO plan_items (plan_id, parent_id, label, status, assigned_to_slot, sort_order) VALUES (?, ?, ?, 'pending', ?, ?)",
      [plan.id, item.parent_id ?? null, item.label, item.assigned_to_slot ?? null, i],
    );
  }

  return handleGetPlan({ session_id: body.session_id });
}

function handleGetPlan(body: { session_id: string }) {
  const plan = db.query("SELECT * FROM plans WHERE session_id = ? ORDER BY id DESC LIMIT 1").get(body.session_id) as any;
  if (!plan) return { plan: null, items: [], completion: 0 };

  const items = db.query(
    "SELECT pi.*, s.display_name as assigned_name FROM plan_items pi LEFT JOIN slots s ON s.id = pi.assigned_to_slot WHERE pi.plan_id = ? ORDER BY pi.sort_order",
  ).all(plan.id) as any[];

  const total = items.length;
  const done = items.filter((i: any) => i.status === "done").length;
  const completion = total > 0 ? Math.round((done / total) * 100) : 0;

  return { plan, items, completion };
}

function handleUpdatePlanItem(body: { item_id: number; status: string; session_id?: string }) {
  const now = Date.now();
  const completedAt = body.status === "done" ? now : null;
  db.run(
    "UPDATE plan_items SET status = ?, completed_at = ? WHERE id = ?",
    [body.status, completedAt, body.item_id],
  );

  // Update the plan's updated_at timestamp
  const item = db.query("SELECT plan_id FROM plan_items WHERE id = ?").get(body.item_id) as any;
  if (item) {
    db.run("UPDATE plans SET updated_at = ? WHERE id = ?", [now, item.plan_id]);
  }

  // If session_id provided, return full plan state
  if (body.session_id) {
    return handleGetPlan({ session_id: body.session_id });
  }
  return { ok: true };
}

/** The plan item, provided it belongs to the session's plan. */
function sessionPlanItem(sessionId: string, itemId: number): { id: number; plan_id: number } | null {
  return db.query(
    "SELECT pi.id, pi.plan_id FROM plan_items pi JOIN plans p ON p.id = pi.plan_id WHERE pi.id = ? AND p.session_id = ?",
  ).get(itemId, sessionId) as { id: number; plan_id: number } | null;
}

/** Append an item to the session's plan, creating the plan if it has none. */
function handleAddPlanItem(body: AddPlanItemRequest) {
  if (!body.session_id) throw new Error("session_id required");
  if (!body.label || !body.label.trim()) throw new Error("label required");
  const now = Date.now();
  let plan = db.query("SELECT id FROM plans WHERE session_id = ? ORDER BY id DESC LIMIT 1").get(body.session_id) as { id: number } | null;
  if (!plan) {
    const session = db.query("SELECT name FROM sessions WHERE id = ?").get(body.session_id) as { name: string } | null;
    if (!session) throw new Error(`Session ${body.session_id} not found`);
    db.run("INSERT INTO plans (session_id, title, created_at, updated_at) VALUES (?, ?, ?, ?)", [body.session_id, body.title ?? session.name, now, now]);
    plan = db.query("SELECT id FROM plans WHERE session_id = ? ORDER BY id DESC LIMIT 1").get(body.session_id) as { id: number };
  }
  const last = db.query("SELECT MAX(sort_order) AS max FROM plan_items WHERE plan_id = ?").get(plan.id) as { max: number | null };
  db.run(
    "INSERT INTO plan_items (plan_id, parent_id, label, status, assigned_to_slot, sort_order) VALUES (?, NULL, ?, 'pending', ?, ?)",
    [plan.id, body.label.trim(), body.assigned_to_slot ?? null, (last.max ?? -1) + 1],
  );
  db.run("UPDATE plans SET updated_at = ? WHERE id = ?", [now, plan.id]);
  return handleGetPlan({ session_id: body.session_id });
}

/** Change an item's label, status or assignee (null unassigns). */
function handleEditPlanItem(body: EditPlanItemRequest) {
  const item = sessionPlanItem(body.session_id, body.item_id);
  if (!item) return null;
  const fields: string[] = [];
  const values: any[] = [];
  if (body.label !== undefined) {
    if (!body.label.trim()) throw new Error("label must not be empty");
    fields.push("label = ?"); values.push(body.label.trim());
  }
  if (body.status !== undefined) {
    if (!PLAN_ITEM_STATUSES.has(body.status)) throw new Error(`Invalid status "${body.status}"`);
    fields.push("status = ?", "completed_at = ?"); values.push(body.status, body.status === "done" ? Date.now() : null);
  }
  if (body.assigned_to_slot !== undefined) { fields.push("assigned_to_slot = ?"); values.push(body.assigned_to_slot); }
  if (fields.length > 0) {
    db.run(`UPDATE plan_items SET ${fields.join(", ")} WHERE id = ?`, [...values, item.id]);
    db.run("UPDATE plans SET updated_at = ? WHERE id = ?", [Date.now(), item.plan_id]);
  }
  return handleGetPlan({ session_id: body.session_id });
}

function handleDeletePlanItem(body: { session_id: string; item_id: number }) {
  const item = sessionPlanItem(body.session_id, body.item_id);
  if (!item) return null;
  db.run("DELETE FROM plan_items WHERE id = ?", [item.id]);
  db.run("UPDATE plans SET updated_at = ? WHERE id = ?", [Date.now(), item.plan_id]);
  return handleGetPlan({ session_id: body.session_id });
}

// --- Message log ---

function handleMessageLog(body: { session_id: string } & MessageLogOptions) {
  const limit = body.limit ?? 50;
  const conditions = ["m.session_id = ?"];
  const params: any[] = [body.session_id];

  if (body.since) {
    conditions.push("m.sent_at > ?");
    params.push(new Date(body.since).toISOString());
  }
  if (body.with_slot) {
    conditions.push("(m.from_slot_id = ? OR m.to_slot_id = ?)");
    params.push(body.with_slot, body.with_slot);
  }
  if (body.msg_type) {
    conditions.push("m.msg_type = ?");
    params.push(body.msg_type);
  }

  params.push(limit);

  const sql = `
    SELECT m.*,
      p.summary as from_summary,
      s.display_name as from_display_name,
      s.role as from_role,
      ts.display_name as to_display_name,
      ts.role as to_role
    FROM messages m
    LEFT JOIN peers p ON p.id = m.from_id
    LEFT JOIN slots s ON s.id = m.from_slot_id
    LEFT JOIN slots ts ON ts.id = m.to_slot_id
    WHERE ${conditions.join(" AND ")}
    ORDER BY m.sent_at DESC
    LIMIT ?
  `;

  const rows = db.query(sql).all(...params) as any[];
  rows.reverse();
  return rows;
}

// --- Hold / release messages ---

function handleHoldMessages(body: { session_id: string; slot_id: number }): { ok: boolean } {
  db.run("UPDATE slots SET paused = 1, paused_at = ? WHERE id = ? AND session_id = ?", [Date.now(), body.slot_id, body.session_id]);
  return { ok: true };
}

function handleReleaseHeld(body: { session_id: string; slot_id: number }) {
  // Get held messages
  const messages = db.query(
    "SELECT * FROM messages WHERE session_id = ? AND to_slot_id = ? AND held = 1 ORDER BY sent_at ASC"
  ).all(body.session_id, body.slot_id) as Message[];

  // Mark unheld
  db.run(
    "UPDATE messages SET held = 0 WHERE session_id = ? AND to_slot_id = ? AND held = 1",
    [body.session_id, body.slot_id]
  );

  // Unpause slot
  db.run("UPDATE slots SET paused = 0, paused_at = NULL WHERE id = ? AND session_id = ?", [body.slot_id, body.session_id]);

  return { messages };
}

// --- Activity timeline ---

const ACTIVITY_KEEP_PER_SLOT = 3000;
const ACTIVITY_TEXT_MAX = 20_000;

function clip(s: unknown, max = ACTIVITY_TEXT_MAX): string | null {
  if (s === undefined || s === null) return null;
  const str = typeof s === "string" ? s : JSON.stringify(s);
  return str.length > max ? str.slice(0, max) + `\n… (${str.length - max} more characters)` : str;
}

function handleActivityAdd(body: ActivityAddRequest): { ok: boolean; added: number } {
  if (!body.session_id || !Number.isInteger(body.slot_id)) throw new Error("session_id and slot_id required");
  const entries = Array.isArray(body.entries) ? body.entries.slice(0, 500) : [];
  const insert = db.prepare("INSERT INTO activity (session_id, slot_id, kind, title, detail, data, ts) VALUES (?, ?, ?, ?, ?, ?, ?)");
  db.transaction(() => {
    for (const e of entries) {
      insert.run(body.session_id, body.slot_id, String(e.kind), clip(e.title, 500) ?? "", clip(e.detail), e.data === undefined ? null : clip(e.data, 60_000), e.ts ?? Date.now());
    }
    // Keep the timeline bounded per agent
    const cutoff = db.query("SELECT id FROM activity WHERE slot_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?").get(body.slot_id, ACTIVITY_KEEP_PER_SLOT) as { id: number } | null;
    if (cutoff) db.run("DELETE FROM activity WHERE slot_id = ? AND id <= ?", [body.slot_id, cutoff.id]);
  })();
  return { ok: true, added: entries.length };
}

/** Oldest first; `after_id` pages forward, otherwise the latest `limit` entries. */
// --- Live activity: what each agent is doing right now (memory only) ---

/** A busy entry not refreshed this long ago belongs to a host that went away */
const LIVE_STALE_MS = 60_000;
const liveActivity = new Map<string, Map<number, LiveActivity>>();

function handleLiveSet(body: { session_id: string; slot_id: number; live: LiveActivity }): { ok: boolean } {
  if (!body.session_id || !Number.isInteger(body.slot_id) || !body.live || typeof body.live !== "object") throw new Error("session_id, slot_id and live required");
  const live = body.live;
  const entry: LiveActivity = {
    busy: live.busy === true,
    phase: ["idle", "waiting", "thinking", "writing", "tool"].includes(live.phase) ? live.phase : "waiting",
    text: typeof live.text === "string" ? live.text.slice(-8_000) : "",
    tool: typeof live.tool === "string" ? live.tool.slice(0, 500) : null,
    since: typeof live.since === "number" ? live.since : null,
    updatedAt: Date.now(),
  };
  let session = liveActivity.get(body.session_id);
  if (!session) liveActivity.set(body.session_id, (session = new Map()));
  if (entry.busy) session.set(body.slot_id, entry);
  else session.delete(body.slot_id);
  return { ok: true };
}

function handleLiveList(body: { session_id: string }): Record<string, LiveActivity> {
  const out: Record<string, LiveActivity> = {};
  const now = Date.now();
  for (const [slotId, live] of liveActivity.get(body.session_id) ?? []) {
    if (now - live.updatedAt < LIVE_STALE_MS) out[slotId] = live;
  }
  return out;
}

function handleActivityList(body: { session_id: string; slot_id?: number; after_id?: number; limit?: number }): ActivityEntry[] {
  const limit = Math.min(Math.max(body.limit ?? 300, 1), 2000);
  const cond = ["session_id = ?"];
  const params: any[] = [body.session_id];
  if (body.slot_id !== undefined && body.slot_id !== null) { cond.push("slot_id = ?"); params.push(body.slot_id); }
  if (body.after_id) {
    cond.push("id > ?"); params.push(body.after_id);
    return db.query(`SELECT * FROM activity WHERE ${cond.join(" AND ")} ORDER BY id ASC LIMIT ?`).all(...params, limit) as ActivityEntry[];
  }
  const rows = db.query(`SELECT * FROM activity WHERE ${cond.join(" AND ")} ORDER BY id DESC LIMIT ?`).all(...params, limit) as ActivityEntry[];
  return rows.reverse();
}

// --- Approvals: a tool call waiting for a person ---

function handleApprovalCreate(body: { session_id: string; slot_id: number; tool: string; title: string; input?: unknown }): ApprovalRequest {
  if (!body.session_id || !Number.isInteger(body.slot_id) || !body.tool) throw new Error("session_id, slot_id and tool required");
  const now = Date.now();
  const res = db.run(
    "INSERT INTO approvals (session_id, slot_id, tool, title, input, status, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)",
    [body.session_id, body.slot_id, body.tool, clip(body.title, 500) ?? body.tool, body.input === undefined ? null : clip(body.input, 60_000), now],
  );
  return db.query("SELECT * FROM approvals WHERE id = ?").get(Number(res.lastInsertRowid)) as ApprovalRequest;
}

function handleApprovalGet(body: { id: number }): ApprovalRequest | null {
  return (db.query("SELECT * FROM approvals WHERE id = ?").get(body.id) as ApprovalRequest) ?? null;
}

function handleApprovalList(body: { session_id: string; status?: string; limit?: number }): ApprovalRequest[] {
  const limit = Math.min(Math.max(body.limit ?? 100, 1), 500);
  if (body.status) {
    return db.query("SELECT * FROM approvals WHERE session_id = ? AND status = ? ORDER BY id ASC LIMIT ?").all(body.session_id, body.status, limit) as ApprovalRequest[];
  }
  return (db.query("SELECT * FROM approvals WHERE session_id = ? ORDER BY id DESC LIMIT ?").all(body.session_id, limit) as ApprovalRequest[]).reverse();
}

/** Decide a pending request; a request already decided or cancelled is not changed. */
function handleApprovalDecide(body: { id: number; session_id: string; decision: "allow" | "deny" | "cancel"; note?: string; always?: boolean; decided_by?: string }): ApprovalRequest | null {
  const status = body.decision === "allow" ? "allowed" : body.decision === "deny" ? "denied" : body.decision === "cancel" ? "cancelled" : null;
  if (!status) throw new Error(`Invalid decision "${body.decision}"`);
  const res = db.run(
    "UPDATE approvals SET status = ?, always = ?, note = ?, decided_by = ?, decided_at = ? WHERE id = ? AND session_id = ? AND status = 'pending'",
    [status, body.always ? 1 : 0, body.note ?? null, body.decided_by ?? null, Date.now(), body.id, body.session_id],
  );
  const row = handleApprovalGet({ id: body.id });
  if (!row || row.session_id !== body.session_id) return null;
  if (res.changes === 0 && body.decision !== "cancel") throw new Error(`Request ${body.id} is already ${row.status}`);
  return row;
}

// --- Agent event ---

function handleAgentEvent(body: { session_id: string; event_type: string; slot_id?: number; metadata?: unknown; data?: unknown }) {
  const metadata = body.metadata ?? body.data;
  db.run(
    "INSERT INTO guardrail_events (session_id, guardrail_id, event_type, slot_id, timestamp, metadata) VALUES (?, '', ?, ?, ?, ?)",
    [body.session_id, body.event_type, body.slot_id ?? null, Date.now(), metadata ? JSON.stringify(metadata) : null]
  );
  return { ok: true };
}

// --- HTTP Server ---

Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (req.method !== "POST") {
      if (path === "/health") {
        return Response.json({ status: "ok", peers: (selectAllPeers.all() as Peer[]).length, pid: process.pid, version: BROKER_VERSION, features: BROKER_FEATURES });
      }
      return new Response("multiagents broker", { status: 200 });
    }

    try {
      const body = await req.json();

      switch (path) {
        // --- Original endpoints ---
        case "/register":
          return Response.json(handleRegister(body as RegisterRequest));
        case "/heartbeat":
          handleHeartbeat(body as HeartbeatRequest);
          return Response.json({ ok: true });
        case "/set-summary":
          handleSetSummary(body as SetSummaryRequest);
          return Response.json({ ok: true });
        case "/list-peers":
          return Response.json(handleListPeers(body as ListPeersRequest));
        case "/send-message":
          return Response.json(handleSendMessage(body as SendMessageRequest));
        case "/poll-messages":
          return Response.json(handlePollMessages(body as PollMessagesRequest));
        case "/poll-by-slot":
          return Response.json(handlePollBySlot(body as { slot_id: number; session_id?: string; retain?: boolean }));
        case "/peek-undelivered": {
          // Non-consuming: `count` covers messages not yet acked, `unclaimed_count` those no delivery mechanism has picked up
          const { slot_id } = body as { slot_id: number };
          const rows = db.query(
            "SELECT msg_type, sent_at, delivered FROM messages WHERE to_slot_id = ? AND acked_at IS NULL AND held = 0 ORDER BY id ASC"
          ).all(slot_id) as { msg_type: string; sent_at: string; delivered: number }[];
          const unclaimed = rows.filter((r) => !r.delivered);
          const oldestAt = (list: typeof rows) => (list[0] ? new Date(list[0].sent_at).getTime() : 0);
          return Response.json({
            count: rows.length,
            msg_types: rows.map((r) => r.msg_type),
            oldest_at: oldestAt(rows),
            unclaimed_count: unclaimed.length,
            unclaimed_msg_types: unclaimed.map((r) => r.msg_type),
            unclaimed_oldest_at: oldestAt(unclaimed),
          });
        }
        case "/ack-messages":
          return Response.json(handleAckMessages(body as { ids?: unknown }));
        case "/unregister":
          return Response.json(handleUnregister(body as { id: string }));

        // --- Role & rename ---
        case "/set-role":
          return Response.json(handleSetRole(body as SetRoleRequest));
        case "/rename-peer":
          return Response.json(handleRenamePeer(body as RenamePeerRequest));

        // --- Sessions ---
        case "/sessions/create":
          return Response.json(handleCreateSession(body as CreateSessionRequest));
        case "/sessions/get": {
          const session = handleGetSession(body as { id: string });
          return session ? Response.json(session) : Response.json({ error: "Session not found" }, { status: 404 });
        }
        case "/sessions/list":
          return Response.json(handleListSessions());
        case "/sessions/update": {
          const updated = handleUpdateSession(body as UpdateSessionRequest);
          return updated ? Response.json(updated) : Response.json({ error: "Session not found" }, { status: 404 });
        }
        case "/sessions/delete":
          return Response.json(handleDeleteSession(body as { id: string }));

        // --- Slots ---
        case "/slots/create":
          return Response.json(handleCreateSlot(body as CreateSlotRequest));
        case "/slots/get": {
          const slot = handleGetSlot(body as { id: number });
          return slot ? Response.json(slot) : Response.json({ error: "Slot not found" }, { status: 404 });
        }
        case "/slots/list":
          return Response.json(handleListSlots(body as { session_id: string }));
        case "/slots/update": {
          const updatedSlot = handleUpdateSlot(body as UpdateSlotRequest);
          return updatedSlot ? Response.json(updatedSlot) : Response.json({ error: "Slot not found" }, { status: 404 });
        }
        case "/slots/delete":
          return Response.json(handleDeleteSlot(body as { id: number }));

        // --- File coordination ---
        case "/files/acquire":
          return Response.json(handleAcquireFile(body as AcquireFileRequest));
        case "/files/release":
          return Response.json(handleReleaseFile(body as ReleaseFileRequest));
        case "/files/assign-ownership":
          return Response.json(handleAssignOwnership(body as AssignOwnershipRequest));
        case "/files/locks":
          return Response.json(handleListLocks(body as { session_id: string }));
        case "/files/ownership":
          return Response.json(handleListOwnership(body as { session_id: string }));

        // --- Guardrails ---
        case "/guardrails":
          return Response.json(handleGetGuardrails(body as { session_id: string }));
        case "/guardrails/update":
          return Response.json(handleUpdateGuardrail(body as UpdateGuardrailRequest));

        // --- Plans ---
        case "/plan/create":
          return Response.json(handleCreatePlan(body as CreatePlanRequest));
        case "/plan/get":
          return Response.json(handleGetPlan(body as { session_id: string }));
        case "/plan/update-item":
          return Response.json(handleUpdatePlanItem(body as { item_id: number; status: string; session_id?: string }));
        // --- Activity & approvals ---
        case "/activity/add":
          return Response.json(handleActivityAdd(body as ActivityAddRequest));
        case "/activity/list":
          return Response.json(handleActivityList(body as { session_id: string; slot_id?: number; after_id?: number; limit?: number }));
        case "/activity/live/set":
          return Response.json(handleLiveSet(body as { session_id: string; slot_id: number; live: LiveActivity }));
        case "/activity/live/list":
          return Response.json(handleLiveList(body as { session_id: string }));
        case "/approvals/create":
          return Response.json(handleApprovalCreate(body as { session_id: string; slot_id: number; tool: string; title: string; input?: unknown }));
        case "/approvals/get": {
          const row = handleApprovalGet(body as { id: number });
          return row ? Response.json(row) : Response.json({ error: "Approval not found" }, { status: 404 });
        }
        case "/approvals/list":
          return Response.json(handleApprovalList(body as { session_id: string; status?: string; limit?: number }));
        case "/approvals/decide": {
          const row = handleApprovalDecide(body as { id: number; session_id: string; decision: "allow" | "deny" | "cancel"; note?: string; always?: boolean; decided_by?: string });
          return row ? Response.json(row) : Response.json({ error: "Approval not found in session" }, { status: 404 });
        }

        case "/plan/add-item":
          return Response.json(handleAddPlanItem(body as AddPlanItemRequest));
        case "/plan/edit-item": {
          const edited = handleEditPlanItem(body as EditPlanItemRequest);
          return edited ? Response.json(edited) : Response.json({ error: "Plan item not found in session" }, { status: 404 });
        }
        case "/plan/delete-item": {
          const remaining = handleDeletePlanItem(body as { session_id: string; item_id: number });
          return remaining ? Response.json(remaining) : Response.json({ error: "Plan item not found in session" }, { status: 404 });
        }

        // --- Message log ---
        case "/message-log":
          return Response.json(handleMessageLog(body as { session_id: string } & MessageLogOptions));

        // --- Hold / release ---
        case "/hold-messages":
          return Response.json(handleHoldMessages(body as { session_id: string; slot_id: number }));
        case "/release-held":
          return Response.json(handleReleaseHeld(body as { session_id: string; slot_id: number }));

        // --- Agent events ---
        case "/agent-event":
          return Response.json(handleAgentEvent(body as { session_id: string; event_type: string; slot_id?: number; metadata?: unknown; data?: unknown }));

        // --- Lifecycle ---
        case "/lifecycle/signal-done": {
          const { peer_id, session_id, summary } = body as SignalDoneRequest;
          const peer = db.query("SELECT * FROM peers WHERE id = ?").get(peer_id) as any;
          if (!peer || !peer.slot_id) return Response.json({ error: "Peer not found or no slot" }, { status: 404 });

          db.run("UPDATE peers SET summary = ? WHERE id = ?", [summary, peer_id]);

          const allSlots = db.query("SELECT * FROM slots WHERE session_id = ? AND id != ?").all(session_id, peer.slot_id) as any[];
          const thisSlot = db.query("SELECT * FROM slots WHERE id = ?").get(peer.slot_id) as any;

          // Reviewers/QA auto-approve on signal_done — they don't need external review.
          const isReviewerRole = thisSlot.role && /qa|review|test|lead/i.test(thisSlot.role);
          const newTaskState = isReviewerRole ? "approved" : "done_pending_review";
          db.run("UPDATE slots SET task_state = ? WHERE id = ?", [newTaskState, peer.slot_id]);

          let notifiedCount = 0;
          for (const targetSlot of allSlots) {
            // Notify connected peers AND driver-managed slots (no peer_id but status=connected)
            if (targetSlot.status === "connected") {
              const isReviewerLike = targetSlot.role && /qa|review|test|lead/i.test(targetSlot.role);
              const msgType = isReviewerLike ? "review_request" : "task_complete";
              const toId = targetSlot.peer_id ?? `__slot_${targetSlot.id}__`;
              db.run(
                "INSERT INTO messages (session_id, from_id, from_slot_id, to_id, to_slot_id, text, msg_type, sent_at, delivered, held) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)",
                [session_id, peer_id, peer.slot_id, toId, targetSlot.id,
                 `${thisSlot.display_name || peer_id} (${thisSlot.role || "unknown"}) has completed their work: ${summary}`,
                 msgType, new Date().toISOString(), targetSlot.paused ? 1 : 0]
              );
              notifiedCount++;
            }
          }

          return Response.json({ ok: true, task_state: newTaskState, notified_count: notifiedCount });
        }

        case "/lifecycle/submit-feedback": {
          const { peer_id, session_id, target_slot_id, feedback, actionable } = body as SubmitFeedbackRequest;
          const peer = db.query("SELECT * FROM peers WHERE id = ?").get(peer_id) as any;
          const targetSlot = db.query("SELECT * FROM slots WHERE id = ?").get(target_slot_id) as any;
          if (!targetSlot) return Response.json({ error: "Target slot not found" }, { status: 404 });

          if (actionable) {
            db.run("UPDATE slots SET task_state = 'addressing_feedback' WHERE id = ?", [target_slot_id]);
          }

          const feedbackToId = targetSlot.peer_id ?? `__slot_${target_slot_id}__`;
          db.run(
            "INSERT INTO messages (session_id, from_id, from_slot_id, to_id, to_slot_id, text, msg_type, sent_at, delivered, held) VALUES (?, ?, ?, ?, ?, ?, 'feedback', ?, 0, ?)",
            [session_id, peer_id, peer?.slot_id ?? null, feedbackToId, target_slot_id,
             feedback, new Date().toISOString(), targetSlot.paused ? 1 : 0]
          );

          return Response.json({ ok: true, task_state: actionable ? "addressing_feedback" : targetSlot.task_state, notified_count: 1 });
        }

        case "/lifecycle/approve": {
          const { peer_id, session_id, target_slot_id, message } = body as ApproveRequest;
          const peer = db.query("SELECT * FROM peers WHERE id = ?").get(peer_id) as any;
          const targetSlot = db.query("SELECT * FROM slots WHERE id = ?").get(target_slot_id) as any;
          if (!targetSlot) return Response.json({ error: "Target slot not found" }, { status: 404 });

          const approverSlot = peer?.slot_id ? db.query("SELECT * FROM slots WHERE id = ?").get(peer.slot_id) as any : null;
          const approverName = approverSlot?.display_name || peer_id;
          const approverRole = approverSlot?.role ?? "unknown";

          // Record the approval message first
          const approveToId = targetSlot.peer_id ?? `__slot_${target_slot_id}__`;
          db.run(
            "INSERT INTO messages (session_id, from_id, from_slot_id, to_id, to_slot_id, text, msg_type, sent_at, delivered, held) VALUES (?, ?, ?, ?, ?, ?, 'approval', ?, 0, ?)",
            [session_id, peer_id, peer?.slot_id ?? null, approveToId, target_slot_id,
             `APPROVED by ${approverName} (${approverRole})${message ? ": " + message : ""}`,
             new Date().toISOString(), targetSlot.paused ? 1 : 0]
          );

          // Count distinct approver roles for this slot (reviewer vs QA vs lead etc.)
          // Only transition to 'approved' if we have approvals from 2+ distinct roles,
          // OR if there's only one reviewer/QA-type role in the session.
          const approvalMessages = db.query(
            "SELECT DISTINCT m.from_slot_id FROM messages m WHERE m.session_id = ? AND m.to_slot_id = ? AND m.msg_type = 'approval'"
          ).all(session_id, target_slot_id) as { from_slot_id: number | null }[];

          const approverSlotIds = approvalMessages.map(m => m.from_slot_id).filter(Boolean) as number[];
          const approverRoles = new Set<string>();
          for (const sid of approverSlotIds) {
            const s = db.query("SELECT role FROM slots WHERE id = ?").get(sid) as { role: string } | null;
            if (s?.role) approverRoles.add(s.role.toLowerCase());
          }

          // Count how many distinct reviewer/QA roles exist in the session
          const allSlots = db.query("SELECT role FROM slots WHERE session_id = ? AND id != ?").all(session_id, target_slot_id) as { role: string }[];
          const reviewRoles = new Set<string>();
          for (const s of allSlots) {
            if (s.role && /qa|review|test|lead/i.test(s.role)) {
              reviewRoles.add(s.role.toLowerCase());
            }
          }

          // Transition to 'approved' if we have approvals from all review roles,
          // or if there's only one review role and it approved.
          const allReviewRolesApproved = reviewRoles.size > 0 && [...reviewRoles].every(r => approverRoles.has(r));
          const singleReviewerApproved = reviewRoles.size <= 1 && approverRoles.size >= 1;

          let newState: string;
          if (allReviewRolesApproved || singleReviewerApproved) {
            db.run("UPDATE slots SET task_state = 'approved' WHERE id = ?", [target_slot_id]);
            newState = "approved";
          } else {
            // Keep in done_pending_review — still waiting for more approvals
            newState = targetSlot.task_state;
          }

          const remaining = [...reviewRoles].filter(r => !approverRoles.has(r));
          const statusMsg = newState === "approved"
            ? "All required approvals received."
            : `Approval recorded (${approverRole}). Still waiting for: ${remaining.join(", ")}.`;

          return Response.json({ ok: true, task_state: newState, approvals: approverRoles.size, required: reviewRoles.size, message: statusMsg });
        }

        case "/lifecycle/release": {
          const { session_id, target_slot_id, released_by, message } = body as ReleaseAgentRequest;
          const targetSlot = db.query("SELECT * FROM slots WHERE id = ?").get(target_slot_id) as any;
          if (!targetSlot) return Response.json({ error: "Target slot not found" }, { status: 404 });

          db.run("UPDATE slots SET task_state = 'released' WHERE id = ?", [target_slot_id]);

          if (targetSlot.peer_id) {
            db.run(
              "INSERT INTO messages (session_id, from_id, from_slot_id, to_id, to_slot_id, text, msg_type, sent_at, delivered, held) VALUES (?, ?, NULL, ?, ?, ?, 'release', ?, 0, 0)",
              [session_id, released_by, targetSlot.peer_id, target_slot_id,
               `RELEASED: You are cleared to disconnect.${message ? " " + message : ""} Your work is complete. You may now exit.`,
               new Date().toISOString()]
            );
          }

          return Response.json({ ok: true, task_state: "released" });
        }

        case "/lifecycle/get-task-state": {
          const { slot_id } = body as { slot_id: number };
          const slot = db.query("SELECT id, task_state, display_name, role FROM slots WHERE id = ?").get(slot_id) as any;
          if (!slot) return Response.json({ error: "Slot not found" }, { status: 404 });
          return Response.json(slot);
        }

        // --- Knowledge Store ---

        case "/knowledge/put":
          return Response.json(handleKnowledgePut(body as KnowledgePutRequest));

        case "/knowledge/get":
          return Response.json(handleKnowledgeGet(body as KnowledgeGetRequest));

        case "/knowledge/list":
          return Response.json(handleKnowledgeList(body as KnowledgeListRequest));

        case "/knowledge/delete":
          return Response.json(handleKnowledgeDelete(body as KnowledgeDeleteRequest));

        default:
          return Response.json({ error: "not found" }, { status: 404 });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return Response.json({ error: msg }, { status: 500 });
    }
  },
});

console.error(`[multiagents broker] listening on 127.0.0.1:${PORT} (db: ${DB_PATH})`);

// --- Graceful shutdown: kill all registered peers and close DB ---
function shutdownBroker() {
  console.error("[multiagents broker] shutting down...");
  // Kill all registered peer processes so they don't become orphans
  const peers = db.query("SELECT id, pid FROM peers").all() as { id: string; pid: number }[];
  for (const peer of peers) {
    try {
      process.kill(peer.pid, "SIGTERM");
    } catch { /* already dead */ }
  }
  // Close DB cleanly (flushes WAL)
  try { db.close(); } catch {}
  process.exit(0);
}

process.on("SIGINT", shutdownBroker);
process.on("SIGTERM", shutdownBroker);

// Restart (a newer build takes over): leave the agents running, they keep their
// registrations in the database and talk to the next broker on the same port
try {
  process.on("SIGUSR2", () => {
    console.error("[multiagents broker] exiting for a restart; agents stay up");
    try { db.close(); } catch {}
    process.exit(0);
  });
} catch { /* no SIGUSR2 on this platform */ }
