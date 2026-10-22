// ============================================================================
// multiagents — Type Definitions
// ============================================================================
// Multi-agent, session, file coordination, and guardrail support.
// ============================================================================

// --- Core primitives ---

/** Unique ID for each agent instance (generated on registration, e.g. "cl-a1b2c3d4") */
export type PeerId = string;

/** Supported agent CLI types */
/** "api": an OpenAI-compatible API provider (DeepSeek, Qwen, …) driven in-process, see orchestrator/api-driver.ts */
export type AgentType = "claude" | "codex" | "gemini" | "api" | "custom";

/** Message types for routing and formatting */
export type MessageType =
  | "chat"
  | "role_assignment"
  | "rename"
  | "broadcast"
  | "team_change"
  | "control"
  | "system"
  // Lifecycle handoff messages
  | "task_complete"      // agent signals their work is done, awaiting review
  | "review_request"     // sent to QA/reviewer to start reviewing
  | "feedback"           // reviewer sends actionable feedback
  | "approval"           // reviewer/QA approves the work
  | "release";           // lead/orchestrator releases agent to disconnect

/** Session lifecycle states */
export type SessionStatus = "active" | "paused" | "archived";

/** Slot connection states */
export type SlotStatus = "connected" | "disconnected";

/**
 * Task lifecycle states per slot.
 * Agents cannot disconnect unless their task_state is "released".
 *
 * State machine:
 *   idle → working → done_pending_review → addressing_feedback → done_pending_review → ... → approved → released
 */
export type TaskState =
  | "idle"                  // just joined, not yet working
  | "working"               // actively implementing/testing/reviewing
  | "done_pending_review"   // signaled completion, waiting for review/QA
  | "addressing_feedback"   // received feedback, working on fixes
  | "approved"              // work approved by reviewer/QA/lead
  | "released";             // cleared to disconnect

/** Guardrail trigger actions */
export type GuardrailAction = "warn" | "pause" | "stop" | "monitor";

/** Guardrail scope */
export type GuardrailScope = "session" | "per_agent";

/** File lock types */
export type LockType = "exclusive" | "shared_read";

/** File acquire result status */
export type AcquireStatus = "acquired" | "locked" | "denied" | "extended";

// --- Domain models ---

export interface Peer {
  id: PeerId;
  session_id: string | null;
  slot_id: number | null;
  pid: number;
  agent_type: AgentType;
  cwd: string;
  git_root: string | null;
  tty: string | null;
  summary: string;
  status: string;
  registered_at: string; // ISO timestamp
  last_seen: string; // ISO timestamp
}

export interface Message {
  id: number;
  session_id: string | null;
  from_id: PeerId;
  from_slot_id: number | null;
  to_id: PeerId;
  to_slot_id: number | null;
  text: string;
  msg_type: MessageType;
  sent_at: string; // ISO timestamp
  delivered: boolean;
  delivered_at: string | null;
  /** Set once the message reached the model (piggybacked into a tool result or injected into a turn). */
  acked_at: string | null;
  held: boolean;
}

export interface Session {
  id: string; // slug: "auth-implementation"
  name: string; // display: "Auth Implementation"
  project_dir: string;
  git_root: string | null;
  status: SessionStatus;
  pause_reason: string | null;
  paused_at: number | null;
  config: string; // JSON
  created_at: number; // epoch ms
  last_active_at: number; // epoch ms
}

export interface Slot {
  id: number;
  session_id: string;
  agent_type: AgentType;
  display_name: string | null;
  role: string | null;
  role_description: string | null;
  role_assigned_by: string | null;
  peer_id: string | null;
  status: SlotStatus;
  task_state: TaskState;
  paused: boolean;
  paused_at: number | null;
  last_peer_pid: number | null;
  last_connected: number | null;
  last_disconnected: number | null;
  context_snapshot: string | null; // JSON: { last_summary, last_status, last_cwd }
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  /** USD as reported by the CLI (Claude); 0 where the CLI reports none */
  cost_usd: number;
}

export interface FileLock {
  id: number;
  session_id: string;
  file_path: string;
  held_by_slot: number;
  held_by_peer: string;
  acquired_at: number;
  expires_at: number;
  lock_type: LockType;
  purpose: string | null;
}

export interface FileOwnership {
  session_id: string;
  slot_id: number;
  path_pattern: string;
  assigned_at: number;
  assigned_by: string;
}

export interface Guardrail {
  id: string;
  label: string;
  description: string;
  current_value: number;
  default_value: number;
  unit: string;
  scope: GuardrailScope;
  action: GuardrailAction;
  warn_at_percent: number;
  adjustable: boolean;
  suggested_increases: number[];
}

export interface GuardrailState extends Guardrail {
  is_overridden: boolean;
  usage: {
    current: number;
    limit: number;
    percent: number;
    status: "ok" | "warning" | "triggered";
  };
}

// --- Broker API request/response types ---

export interface RegisterRequest {
  pid: number;
  cwd: string;
  git_root: string | null;
  tty: string | null;
  summary: string;
  agent_type?: AgentType;
  session_id?: string;
  reconnect?: boolean;
  role?: string;
  display_name?: string;
  slot_id?: number;
}

export interface SlotCandidate {
  slot_id: number;
  display_name: string | null;
  role: string | null;
  last_summary: string | null;
}

export interface RegisterResponse {
  id: PeerId;
  slot?: Slot;
  recap?: Message[];
  choose_slot?: SlotCandidate[];
}

export interface HeartbeatRequest {
  id: PeerId;
}

export interface SetSummaryRequest {
  id: PeerId;
  summary: string;
}

export interface ListPeersRequest {
  scope: "machine" | "directory" | "repo";
  cwd: string;
  git_root: string | null;
  exclude_id?: PeerId;
  agent_type?: AgentType | "all";
  session_id?: string;
}

export interface SendMessageRequest {
  from_id: PeerId;
  to_id?: PeerId;
  to_slot_id?: number;
  text: string;
  msg_type?: MessageType;
  session_id?: string;
}

export interface SendMessageResult {
  ok: boolean;
  error?: string;
  warning?: string;
}

export interface PollMessagesRequest {
  id: PeerId;
  /** Only messages no delivery mechanism has handed off yet (driver-managed agents use this). */
  unclaimed_only?: boolean;
  /** Keep the returned messages pollable until the client acks them; by default a poll consumes them. */
  retain?: boolean;
}

export interface PollMessagesResponse {
  messages: Message[];
  paused?: boolean;
}

/** Non-consuming view of a slot's inbox: unacked messages, and the subset no delivery mechanism has picked up. */
export interface PeekResult {
  count: number;
  msg_types: string[];
  oldest_at: number;
  unclaimed_count: number;
  unclaimed_msg_types: string[];
  unclaimed_oldest_at: number;
}

export interface SetRoleRequest {
  peer_id: PeerId;
  assigner_id: PeerId;
  slot_id?: number;
  role: string;
  role_description: string;
}

export interface RenamePeerRequest {
  peer_id: PeerId;
  assigner_id: PeerId;
  slot_id?: number;
  display_name: string;
}

export interface AcquireFileRequest {
  session_id: string;
  peer_id: PeerId;
  slot_id: number;
  file_path: string;
  purpose?: string;
  timeout_ms?: number;
}

export interface AcquireFileResult {
  status: AcquireStatus;
  expires_at?: number;
  held_by?: string;
  owner?: string;
  pattern?: string;
  wait_estimate_ms?: number;
  message: string;
}

export interface ReleaseFileRequest {
  session_id: string;
  peer_id: PeerId;
  file_path: string;
}

export interface AssignOwnershipRequest {
  session_id: string;
  slot_id: number;
  path_patterns: string[];
  assigned_by: string;
}

export interface CreateSessionRequest {
  id: string;
  name: string;
  project_dir: string;
  git_root?: string | null;
  config?: Record<string, unknown>;
}

export interface UpdateSessionRequest {
  id: string;
  status?: SessionStatus;
  pause_reason?: string | null;
  paused_at?: number | null;
  config?: Record<string, unknown>;
  /** Keys merged into the existing config; other keys survive. */
  config_patch?: Record<string, unknown>;
}

export interface AddPlanItemRequest {
  session_id: string;
  label: string;
  assigned_to_slot?: number | null;
  /** Title for the plan when the session has none yet (default: the session name). */
  title?: string;
}

export interface EditPlanItemRequest {
  session_id: string;
  item_id: number;
  label?: string;
  status?: "pending" | "in_progress" | "blocked" | "done";
  /** null unassigns the item. */
  assigned_to_slot?: number | null;
}

export interface CreateSlotRequest {
  session_id: string;
  agent_type: AgentType;
  display_name?: string;
  role?: string;
  role_description?: string;
}

export interface UpdateSlotRequest {
  id: number;
  peer_id?: PeerId | null;
  paused?: boolean;
  paused_at?: number | null;
  status?: SlotStatus;
  task_state?: TaskState;
  context_snapshot?: string;
  /** Keys merged into the existing snapshot; other writers' keys (driver session ids) survive. */
  context_patch?: Record<string, unknown>;
  display_name?: string;
  role?: string;
  role_description?: string;
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  /** Added to the slot's running cost */
  cost_usd?: number;
}

// --- Lifecycle handoff requests ---

export interface SignalDoneRequest {
  peer_id: PeerId;
  session_id: string;
  summary: string; // what was accomplished
}

export interface SubmitFeedbackRequest {
  peer_id: PeerId;
  session_id: string;
  target_slot_id: number;
  feedback: string;
  actionable: boolean; // true = requires changes, false = informational
}

export interface ApproveRequest {
  peer_id: PeerId;
  session_id: string;
  target_slot_id: number;
  message?: string;
}

export interface ReleaseAgentRequest {
  session_id: string;
  target_slot_id: number;
  released_by: string; // peer_id or "__orchestrator__"
  message?: string;
}

export interface UnregisterResult {
  ok: boolean;
  denied?: boolean;
  reason?: string;
  task_state?: TaskState;
}

export interface UpdateGuardrailRequest {
  session_id: string;
  guardrail_id: string;
  new_value: number;
  changed_by: string;
  reason?: string;
}

export interface MessageLogOptions {
  limit?: number;
  since?: number;
  with_slot?: number;
  msg_type?: MessageType;
}

// --- Buffered message (adapter-level, for piggyback delivery) ---

export interface BufferedMessage extends Message {
  from_display_name?: string | null;
  from_agent_type?: AgentType;
  from_summary?: string | null;
  from_cwd?: string;
  from_role?: string | null;
}

// --- Session file (written to .multiagents/session.json) ---

export interface SessionFile {
  session_id: string;
  created_at: string; // ISO timestamp
  broker_port: number;
}

// --- Agent launch config (for orchestrator) ---

export interface AgentLaunchConfig {
  agent_type: AgentType;
  name: string;
  role: string;
  role_description: string;
  initial_task: string;
  file_ownership?: string[];
  report_to?: string;
  /** Model name or alias for the CLI (claude: opus/sonnet/haiku…, codex: gpt-…, gemini: gemini-…). */
  model?: string;
  /** Reasoning effort (claude: low…max, codex: minimal…high). */
  effort?: string;
  /** Who approves the agent's tool calls; default "bypass" (fully autonomous). */
  approval_mode?: ApprovalMode;
  /** For agent_type "api": the configured provider's id (shared/providers.ts) */
  provider?: string;
}

/**
 * How an agent's tool calls are approved:
 *   bypass       — never ask (fully autonomous)
 *   auto         — the CLI's own reviewer decides; risky calls come to a person (Claude "auto", Codex "on-request")
 *   accept_edits — file edits go through, commands and other tools ask (Claude only; Codex treats it like "ask")
 *   ask          — every tool call waits for a person
 */
export type ApprovalMode = "bypass" | "auto" | "accept_edits" | "ask";

/** One step of an agent's work as shown in the activity timeline. */
export type ActivityKind =
  | "thinking" | "text" | "tool_call" | "tool_result" | "command" | "file_change"
  | "approval" | "turn_end" | "status" | "error";

export interface ActivityEntry {
  id: number;
  session_id: string;
  slot_id: number;
  kind: ActivityKind;
  title: string;
  detail: string | null;
  /** JSON: tool input, diff, exit code, usage… */
  data: string | null;
  ts: number;
}

export interface ActivityAddRequest {
  session_id: string;
  slot_id: number;
  entries: Array<{ kind: ActivityKind; title: string; detail?: string | null; data?: unknown; ts?: number }>;
}

/** What an agent is doing right now (in memory on the broker, not stored). */
export interface LiveActivity {
  busy: boolean;
  /** waiting = between steps (the model is deciding what to do next) */
  phase: "idle" | "waiting" | "thinking" | "writing" | "tool";
  /** The thinking or reply being written, tail only */
  text: string;
  /** The tool step running (phase "tool") */
  tool: string | null;
  /** When the turn started (epoch ms) */
  since: number | null;
  updatedAt: number;
}

export type ApprovalStatus = "pending" | "allowed" | "denied" | "cancelled";

export interface ApprovalRequest {
  id: number;
  session_id: string;
  slot_id: number;
  tool: string;
  title: string;
  /** JSON of the tool input */
  input: string | null;
  status: ApprovalStatus;
  /** Allow this tool for the rest of the agent's session */
  always: number;
  note: string | null;
  decided_by: string | null;
  created_at: number;
  decided_at: number | null;
}

export interface TeamConfig {
  project_dir: string;
  session_name: string;
  agents: AgentLaunchConfig[];
}

// --- Knowledge Store ---

/** Category for knowledge entries */
export type KnowledgeCategory = "decision" | "convention" | "discovery" | "blocker" | "context";

/** A shared knowledge entry visible to all agents in a session */
export interface KnowledgeEntry {
  id: number;
  session_id: string;
  key: string;
  value: string;
  category: KnowledgeCategory;
  created_by_slot: number | null;
  created_by_name: string | null;
  created_at: number;
  updated_at: number;
}

export interface KnowledgePutRequest {
  session_id: string;
  key: string;
  value: string;
  category?: KnowledgeCategory;
  slot_id?: number;
  slot_name?: string;
}

export interface KnowledgePutResponse {
  ok: boolean;
  entry: KnowledgeEntry;
  action: "created" | "updated";
}

export interface KnowledgeListRequest {
  session_id: string;
  category?: KnowledgeCategory;
}

export interface KnowledgeGetRequest {
  session_id: string;
  key: string;
}

export interface KnowledgeDeleteRequest {
  session_id: string;
  key: string;
}
