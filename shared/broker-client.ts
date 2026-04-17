import type {
  RegisterRequest,
  RegisterResponse,
  HeartbeatRequest,
  SetSummaryRequest,
  ListPeersRequest,
  Peer,
  SendMessageRequest,
  SendMessageResult,
  PollMessagesRequest,
  PollMessagesResponse,
  SetRoleRequest,
  RenamePeerRequest,
  CreateSessionRequest,
  Session,
  UpdateSessionRequest,
  CreateSlotRequest,
  Slot,
  UpdateSlotRequest,
  AcquireFileRequest,
  AcquireFileResult,
  ReleaseFileRequest,
  AssignOwnershipRequest,
  FileLock,
  FileOwnership,
  GuardrailState,
  UpdateGuardrailRequest,
  MessageLogOptions,
  Message,
  PeerId,
  SignalDoneRequest,
  SubmitFeedbackRequest,
  ApproveRequest,
  ReleaseAgentRequest,
  UnregisterResult,
  KnowledgePutRequest,
  KnowledgePutResponse,
  KnowledgeEntry,
  KnowledgeListRequest,
  KnowledgeGetRequest,
  KnowledgeDeleteRequest,
  KnowledgeCategory,
} from "./types.ts";

/** HTTP client for the multiagents broker API. */
export class BrokerClient {
  constructor(private baseUrl: string) {}

  private async post<T>(path: string, body: unknown): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const res = await globalThis.fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => res.statusText);
        throw new Error(`Broker POST ${path} failed (${res.status}): ${text}`);
      }
      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  async isAlive(): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    try {
      const res = await globalThis.fetch(`${this.baseUrl}/health`, {
        method: "GET",
        signal: controller.signal,
      });
      return res.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  register(req: RegisterRequest): Promise<RegisterResponse> {
    return this.post("/register", req);
  }

  heartbeat(id: PeerId): Promise<{ ok: boolean }> {
    return this.post("/heartbeat", { id });
  }

  setSummary(id: PeerId, summary: string): Promise<{ ok: boolean }> {
    return this.post("/set-summary", { id, summary });
  }

  listPeers(req: ListPeersRequest): Promise<Peer[]> {
    return this.post("/list-peers", req);
  }

  sendMessage(req: SendMessageRequest): Promise<SendMessageResult> {
    return this.post("/send-message", req);
  }

  pollMessages(id: PeerId): Promise<PollMessagesResponse> {
    return this.post("/poll-messages", { id });
  }

  /** Poll undelivered messages by slot_id (for driver-managed agents without peer_id). */
  pollBySlot(slotId: number): Promise<PollMessagesResponse> {
    return this.post("/poll-by-slot", { slot_id: slotId });
  }

  /** Non-consuming peek at undelivered messages for a slot. */
  peekUndelivered(slotId: number): Promise<{ count: number; msg_types: string[]; oldest_at: number }> {
    return this.post("/peek-undelivered", { slot_id: slotId });
  }

  unregister(id: PeerId): Promise<UnregisterResult> {
    return this.post("/unregister", { id });
  }

  setRole(req: SetRoleRequest): Promise<{ ok: boolean }> {
    return this.post("/set-role", req);
  }

  renamePeer(req: RenamePeerRequest): Promise<{ ok: boolean }> {
    return this.post("/rename-peer", req);
  }

  createSession(req: CreateSessionRequest): Promise<Session> {
    return this.post("/sessions/create", req);
  }

  getSession(id: string): Promise<Session> {
    return this.post("/sessions/get", { id });
  }

  listSessions(): Promise<Session[]> {
    return this.post("/sessions/list", {});
  }

  deleteSession(id: string): Promise<{ ok: boolean; deleted: { slots: number; messages: number; plans: number; locks: number } }> {
    return this.post("/sessions/delete", { id });
  }

  updateSession(req: UpdateSessionRequest): Promise<Session> {
    return this.post("/sessions/update", req);
  }

  createSlot(req: CreateSlotRequest): Promise<Slot> {
    return this.post("/slots/create", req);
  }

  getSlot(id: number): Promise<Slot> {
    return this.post("/slots/get", { id });
  }

  listSlots(sessionId: string): Promise<Slot[]> {
    return this.post("/slots/list", { session_id: sessionId });
  }

  updateSlot(req: UpdateSlotRequest): Promise<Slot> {
    return this.post("/slots/update", req);
  }

  acquireFile(req: AcquireFileRequest): Promise<AcquireFileResult> {
    return this.post("/files/acquire", req);
  }

  releaseFile(req: ReleaseFileRequest): Promise<{ ok: boolean }> {
    return this.post("/files/release", req);
  }

  assignOwnership(req: AssignOwnershipRequest): Promise<{ ok: boolean }> {
    return this.post("/files/assign-ownership", req);
  }

  listFileLocks(sessionId: string): Promise<FileLock[]> {
    return this.post("/files/locks", { session_id: sessionId });
  }

  listFileOwnership(sessionId: string): Promise<FileOwnership[]> {
    return this.post("/files/ownership", { session_id: sessionId });
  }

  getGuardrails(sessionId: string): Promise<GuardrailState[]> {
    return this.post("/guardrails", { session_id: sessionId });
  }

  updateGuardrail(req: UpdateGuardrailRequest): Promise<GuardrailState> {
    return this.post("/guardrails/update", req);
  }

  getMessageLog(sessionId: string, opts?: MessageLogOptions): Promise<Message[]> {
    return this.post("/message-log", { session_id: sessionId, ...opts });
  }

  holdMessages(sessionId: string, slotId: number): Promise<{ ok: boolean }> {
    return this.post("/hold-messages", { session_id: sessionId, slot_id: slotId });
  }

  releaseHeldMessages(sessionId: string, slotId: number): Promise<{ ok: boolean }> {
    return this.post("/release-held", { session_id: sessionId, slot_id: slotId });
  }

  logAgentEvent(data: { session_id: string; peer_id: PeerId; slot_id?: number; event_type: string; data?: unknown }): Promise<{ ok: boolean }> {
    return this.post("/agent-event", data);
  }

  // --- Lifecycle handoff ---

  signalDone(req: SignalDoneRequest): Promise<{ ok: boolean; task_state: string }> {
    return this.post("/lifecycle/signal-done", req);
  }

  submitFeedback(req: SubmitFeedbackRequest): Promise<{ ok: boolean; task_state: string }> {
    return this.post("/lifecycle/submit-feedback", req);
  }

  approve(req: ApproveRequest): Promise<{ ok: boolean; task_state: string }> {
    return this.post("/lifecycle/approve", req);
  }

  releaseAgent(req: ReleaseAgentRequest): Promise<{ ok: boolean; task_state: string }> {
    return this.post("/lifecycle/release", req);
  }

  getTaskState(slotId: number): Promise<{ id: number; task_state: string; display_name: string | null; role: string | null }> {
    return this.post("/lifecycle/get-task-state", { slot_id: slotId });
  }

  // --- Plans ---

  createPlan(req: { session_id: string; title: string; items: { label: string; assigned_to_slot?: number }[] }): Promise<PlanState> {
    return this.post("/plan/create", req);
  }

  getPlan(sessionId: string): Promise<PlanState> {
    return this.post("/plan/get", { session_id: sessionId });
  }

  updatePlanItem(req: { item_id: number; status: string; session_id?: string }): Promise<PlanState | { ok: boolean }> {
    return this.post("/plan/update-item", req);
  }

  // --- Slot management ---

  deleteSlot(slotId: number): Promise<{ ok: boolean; deleted: boolean }> {
    return this.post("/slots/delete", { id: slotId });
  }

  // --- Knowledge Store ---

  putKnowledge(req: KnowledgePutRequest): Promise<KnowledgePutResponse> {
    return this.post("/knowledge/put", req);
  }

  getKnowledge(sessionId: string, key: string): Promise<KnowledgeEntry | { error: string }> {
    return this.post("/knowledge/get", { session_id: sessionId, key });
  }

  listKnowledge(sessionId: string, category?: KnowledgeCategory): Promise<KnowledgeEntry[]> {
    return this.post("/knowledge/list", { session_id: sessionId, category });
  }

  deleteKnowledge(sessionId: string, key: string): Promise<{ ok: boolean }> {
    return this.post("/knowledge/delete", { session_id: sessionId, key });
  }
}

export interface PlanItem {
  id: number;
  plan_id: number;
  parent_id: number | null;
  label: string;
  status: "pending" | "in_progress" | "done" | "blocked";
  assigned_to_slot: number | null;
  assigned_name: string | null;
  completed_at: number | null;
  sort_order: number;
}

export interface PlanState {
  plan: { id: number; session_id: string; title: string; created_at: number; updated_at: number } | null;
  items: PlanItem[];
  completion: number;
}
