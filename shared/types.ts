// ============================================================================
// multiagents — Type Definitions
// ============================================================================
// Multi-agent, session, file coordination, and guardrail support.
// ============================================================================

// --- Core primitives ---

/** Unique ID for each agent instance (generated on registration, e.g. "cl-a1b2c3d4") */
export type PeerId = string;

/** Supported agent CLI types */
export type AgentType = "claude" | "codex" | "gemini" | "custom";

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
}

export interface PollMessagesResponse {
  messages: Message[];
  paused?: boolean;
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
  paused?: boolean;
  paused_at?: number | null;
  status?: SlotStatus;
  task_state?: TaskState;
  context_snapshot?: string;
  display_name?: string;
  role?: string;
  role_description?: string;
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
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
}

export interface TeamConfig {
  project_dir: string;
  session_name: string;
  agents: AgentLaunchConfig[];
}
