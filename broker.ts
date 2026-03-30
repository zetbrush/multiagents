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
  DEFAULT_BROKER_PORT,
  DEFAULT_DB_PATH,
  DEFAULT_LOCK_TIMEOUT_MS,
  MAX_LOCK_TIMEOUT_MS,
  RECONNECT_RECAP_LIMIT,
  DEFAULT_GUARDRAILS,
  CLEANUP_INTERVAL,
} from "./shared/constants.ts";
import { generatePeerId } from "./shared/utils.ts";
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
  Peer,
  Message,
  Session,
  Slot,
  FileLock,
  FileOwnership,
  AgentType,
  SlotCandidate,
} from "./shared/types.ts";

// --- Configuration ---

const PORT = parseInt(process.env.MULTIAGENTS_PORT ?? String(DEFAULT_BROKER_PORT), 10);

const DB_PATH = process.env.MULTIAGENTS_DB ?? DEFAULT_DB_PATH;

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

// Add new columns to existing tables (idempotent via try/catch)
const alterStatements = [
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
];

for (const stmt of alterStatements) {
  try {
    db.run(stmt);
  } catch {
    // Column already exists — ignore
  }
}

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
    context_snapshot TEXT
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

// --- Context snapshot builder ---

/** Build a rich context snapshot for a disconnecting peer/slot. */
function buildContextSnapshot(peer: { summary?: string | null; cwd?: string | null }, slotId: number): string {
  const slotRow = db.query("SELECT task_state FROM slots WHERE id = ?").get(slotId) as { task_state: string } | null;

  // Get plan items assigned to this slot (if any plan exists)
  let planItems: { label: string; status: string }[] = [];
  try {
    const planRow = db.query(
      "SELECT pi.label, pi.status FROM plan_items pi JOIN plans p ON pi.plan_id = p.id JOIN slots s ON p.session_id = s.session_id WHERE pi.assigned_to_slot = ? ORDER BY pi.sort_order",
    ).all(slotId) as { label: string; status: string }[];
    planItems = planRow;
  } catch { /* plan tables may not have data */ }

  return JSON.stringify({
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

      // Process dead — clean up peer (after snapshot capture)
      db.run("DELETE FROM peers WHERE id = ?", [peer.id]);
      db.run("DELETE FROM messages WHERE to_id = ? AND delivered = 0", [peer.id]);

      // Release file locks held by this peer
      db.run("DELETE FROM file_locks WHERE held_by_peer = ?", [peer.id]);
    }
  }

  // Clean expired file locks
  db.run("DELETE FROM file_locks WHERE expires_at < ?", [now]);
}

cleanStalePeers();
setInterval(cleanStalePeers, CLEANUP_INTERVAL);

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

const selectUndelivered = db.prepare(
  "SELECT * FROM messages WHERE to_id = ? AND delivered = 0 AND held = 0 ORDER BY sent_at ASC"
);

const markDelivered = db.prepare(
  "UPDATE messages SET delivered = 1, delivered_at = ? WHERE id = ?"
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
    if (!slot.peer_id) return { ok: false, error: `Slot ${toSlotId} has no connected peer` };
    toId = slot.peer_id;
  }

  if (!toId) return { ok: false, error: "No target specified" };

  // Allow messages to "orchestrator" — these are escalation messages read by the orchestrator's monitoring loop
  const isOrchestratorTarget = toId === "orchestrator" || toId === "__orchestrator__";

  // Verify target exists (unless targeting orchestrator)
  if (!isOrchestratorTarget) {
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

  const messages = selectUndelivered.all(body.id) as Message[];
  const now = new Date().toISOString();
  for (const msg of messages) {
    markDelivered.run(now, msg.id);
  }

  return { messages };
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

// --- Sessions ---

function handleCreateSession(body: CreateSessionRequest): Session {
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

  db.run("DELETE FROM sessions WHERE id = ?", [body.id]);

  return { ok: true, deleted: { slots: slotCount, messages: msgCount, plans: planCount, locks: 0 } };
}

function handleUpdateSession(body: UpdateSessionRequest): Session | null {
  const fields: string[] = [];
  const values: any[] = [];

  if (body.status !== undefined) { fields.push("status = ?"); values.push(body.status); }
  if (body.pause_reason !== undefined) { fields.push("pause_reason = ?"); values.push(body.pause_reason); }
  if (body.paused_at !== undefined) { fields.push("paused_at = ?"); values.push(body.paused_at); }
  if (body.config !== undefined) { fields.push("config = ?"); values.push(JSON.stringify(body.config)); }

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

  if (body.paused !== undefined) { fields.push("paused = ?"); values.push(body.paused ? 1 : 0); }
  if (body.paused_at !== undefined) { fields.push("paused_at = ?"); values.push(body.paused_at); }
  // Only accept valid slot statuses — reject "archived" or other ghost values
  if (body.status !== undefined && (body.status === "connected" || body.status === "disconnected")) {
    fields.push("status = ?"); values.push(body.status);
  }
  if (body.context_snapshot !== undefined) { fields.push("context_snapshot = ?"); values.push(body.context_snapshot); }
  if (body.display_name !== undefined) { fields.push("display_name = ?"); values.push(body.display_name); }
  if (body.role !== undefined) { fields.push("role = ?"); values.push(body.role); }
  if (body.role_description !== undefined) { fields.push("role_description = ?"); values.push(body.role_description); }
  if (body.task_state !== undefined) { fields.push("task_state = ?"); values.push(body.task_state); }
  if (body.input_tokens !== undefined) { fields.push("input_tokens = input_tokens + ?"); values.push(body.input_tokens); }
  if (body.output_tokens !== undefined) { fields.push("output_tokens = output_tokens + ?"); values.push(body.output_tokens); }
  if (body.cache_read_tokens !== undefined) { fields.push("cache_read_tokens = cache_read_tokens + ?"); values.push(body.cache_read_tokens); }

  if (fields.length > 0) {
    values.push(body.id);
    db.run(`UPDATE slots SET ${fields.join(", ")} WHERE id = ?`, values);
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

// --- Agent event ---

function handleAgentEvent(body: { session_id: string; event_type: string; slot_id?: number; metadata?: any }) {
  db.run(
    "INSERT INTO guardrail_events (session_id, guardrail_id, event_type, slot_id, timestamp, metadata) VALUES (?, '', ?, ?, ?, ?)",
    [body.session_id, body.event_type, body.slot_id ?? null, Date.now(), body.metadata ? JSON.stringify(body.metadata) : null]
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
        return Response.json({ status: "ok", peers: (selectAllPeers.all() as Peer[]).length });
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
          return Response.json(handleCreatePlan(body as any));
        case "/plan/get":
          return Response.json(handleGetPlan(body as { session_id: string }));
        case "/plan/update-item":
          return Response.json(handleUpdatePlanItem(body as any));

        // --- Message log ---
        case "/message-log":
          return Response.json(handleMessageLog(body));

        // --- Hold / release ---
        case "/hold-messages":
          return Response.json(handleHoldMessages(body as { session_id: string; slot_id: number }));
        case "/release-held":
          return Response.json(handleReleaseHeld(body as { session_id: string; slot_id: number }));

        // --- Agent events ---
        case "/agent-event":
          return Response.json(handleAgentEvent(body));

        // --- Lifecycle ---
        case "/lifecycle/signal-done": {
          const { peer_id, session_id, summary } = body;
          const peer = db.query("SELECT * FROM peers WHERE id = ?").get(peer_id) as any;
          if (!peer || !peer.slot_id) return Response.json({ error: "Peer not found or no slot" }, { status: 404 });

          db.run("UPDATE slots SET task_state = 'done_pending_review' WHERE id = ?", [peer.slot_id]);
          db.run("UPDATE peers SET summary = ? WHERE id = ?", [summary, peer_id]);

          const allSlots = db.query("SELECT * FROM slots WHERE session_id = ? AND id != ?").all(session_id, peer.slot_id) as any[];
          const thisSlot = db.query("SELECT * FROM slots WHERE id = ?").get(peer.slot_id) as any;

          for (const targetSlot of allSlots) {
            if (targetSlot.status === "connected" && targetSlot.peer_id) {
              const isReviewerLike = targetSlot.role && /qa|review|test|lead/i.test(targetSlot.role);
              const msgType = isReviewerLike ? "review_request" : "task_complete";
              db.run(
                "INSERT INTO messages (session_id, from_id, from_slot_id, to_id, to_slot_id, text, msg_type, sent_at, delivered, held) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)",
                [session_id, peer_id, peer.slot_id, targetSlot.peer_id, targetSlot.id,
                 `${thisSlot.display_name || peer_id} (${thisSlot.role || "unknown"}) has completed their work: ${summary}`,
                 msgType, new Date().toISOString(), targetSlot.paused ? 1 : 0]
              );
            }
          }

          return Response.json({ ok: true, task_state: "done_pending_review" });
        }

        case "/lifecycle/submit-feedback": {
          const { peer_id, session_id, target_slot_id, feedback, actionable } = body;
          const peer = db.query("SELECT * FROM peers WHERE id = ?").get(peer_id) as any;
          const targetSlot = db.query("SELECT * FROM slots WHERE id = ?").get(target_slot_id) as any;
          if (!targetSlot) return Response.json({ error: "Target slot not found" }, { status: 404 });

          if (actionable) {
            db.run("UPDATE slots SET task_state = 'addressing_feedback' WHERE id = ?", [target_slot_id]);
          }

          db.run(
            "INSERT INTO messages (session_id, from_id, from_slot_id, to_id, to_slot_id, text, msg_type, sent_at, delivered, held) VALUES (?, ?, ?, ?, ?, ?, 'feedback', ?, 0, ?)",
            [session_id, peer_id, peer?.slot_id ?? null, targetSlot.peer_id, target_slot_id,
             feedback, new Date().toISOString(), targetSlot.paused ? 1 : 0]
          );

          return Response.json({ ok: true, task_state: actionable ? "addressing_feedback" : targetSlot.task_state });
        }

        case "/lifecycle/approve": {
          const { peer_id, session_id, target_slot_id, message } = body;
          const peer = db.query("SELECT * FROM peers WHERE id = ?").get(peer_id) as any;
          const targetSlot = db.query("SELECT * FROM slots WHERE id = ?").get(target_slot_id) as any;
          if (!targetSlot) return Response.json({ error: "Target slot not found" }, { status: 404 });

          const approverSlot = peer?.slot_id ? db.query("SELECT * FROM slots WHERE id = ?").get(peer.slot_id) as any : null;
          const approverName = approverSlot?.display_name || peer_id;
          const approverRole = approverSlot?.role ?? "unknown";

          // Record the approval message first
          db.run(
            "INSERT INTO messages (session_id, from_id, from_slot_id, to_id, to_slot_id, text, msg_type, sent_at, delivered, held) VALUES (?, ?, ?, ?, ?, ?, 'approval', ?, 0, ?)",
            [session_id, peer_id, peer?.slot_id ?? null, targetSlot.peer_id, target_slot_id,
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
          const { session_id, target_slot_id, released_by, message } = body;
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
          const { slot_id } = body;
          const slot = db.query("SELECT id, task_state, display_name, role FROM slots WHERE id = ?").get(slot_id) as any;
          if (!slot) return Response.json({ error: "Slot not found" }, { status: 404 });
          return Response.json(slot);
        }

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
