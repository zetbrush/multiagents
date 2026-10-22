// ============================================================================
// multiagents — Web Dashboard control API
// ============================================================================
// The mutating half of the web dashboard. Every handler names its session
// explicitly and checks that the slot it touches belongs to that session.
// Agent lifecycle (launch, release, remove, end, resume) goes through the
// orchestrator runtime, the same code the orchestrator MCP tools run; plain
// records (messages, plan, knowledge, locks, guardrails) go to the broker.
// ============================================================================

import type { BrokerClient } from "../shared/broker-client.ts";
import type { AgentLaunchConfig, AgentType, ApprovalMode, KnowledgeCategory, Session, Slot } from "../shared/types.ts";
import { safeJsonParse } from "../shared/utils.ts";
import { createSessionRecord, exportSessionData } from "../shared/session-ops.ts";
import { callOrchestratorTool, restartBroker, missingBrokerFeatures, type ToolResult } from "../orchestrator/runtime.ts";
import { controlSession, broadcastToTeam } from "../orchestrator/session-control.ts";
import { detectAgent } from "../orchestrator/launcher.ts";
import { HUMAN_SENDER } from "../shared/constants.ts";
import { loadProviders, getProvider, saveProvider, deleteProvider, maskProvider, fetchProviderModels, normalizeBaseUrl, type ApiProvider } from "../shared/providers.ts";

/** Sender id of everything a person does from the browser. */
export const HUMAN_ID = HUMAN_SENDER;

const QA_HOLD_TEXT =
  "[HOLD — Q&A MODE] The person has put the team's work on hold to ask questions. Stop your current task now: " +
  "do not edit files, run commands or builds, or message teammates. Wait for the person's questions and answer each one " +
  "with send_message(to_id=\"human\"), briefly and directly; you may read files to answer. " +
  "Do not resume work until a [RESUME] message arrives.";
const QA_RESUME_TEXT =
  "[RESUME] The person ended Q&A mode. Continue your task where you left off; messages your teammates sent meanwhile arrive now.";

const AGENT_TYPES: AgentType[] = ["claude", "codex", "gemini", "api"];
const KNOWLEDGE_CATEGORIES: KnowledgeCategory[] = ["decision", "convention", "discovery", "blocker", "context"];
const PLAN_STATUSES = ["pending", "in_progress", "blocked", "done"] as const;

export class ApiError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

export interface ControlContext {
  broker: BrokerClient;
  brokerPort: number;
}

type Body = Record<string, unknown>;
type Handler = (ctx: ControlContext, body: Body) => Promise<unknown>;

// --- Validation helpers ---

function str(body: Body, key: string, opts: { optional?: boolean; allowEmpty?: boolean } = {}): string {
  const v = body[key];
  if (v === undefined || v === null || v === "") {
    if (opts.optional || (opts.allowEmpty && v === "")) return "";
    throw new ApiError(`${key} is required`);
  }
  if (typeof v !== "string") throw new ApiError(`${key} must be a string`);
  return v;
}

function int(body: Body, key: string): number {
  const v = typeof body[key] === "string" ? Number(body[key]) : body[key];
  if (typeof v !== "number" || !Number.isInteger(v)) throw new ApiError(`${key} must be an integer`);
  return v;
}

async function requireSession(ctx: ControlContext, body: Body): Promise<Session> {
  const id = str(body, "session_id");
  const session = await ctx.broker.getSession(id).catch(() => null);
  if (!session) throw new ApiError(`Session "${id}" not found`, 404);
  return session;
}

/** The slot, provided it belongs to the session: a stale tab must not act on another session's agent. */
async function requireSlot(ctx: ControlContext, session: Session, body: Body): Promise<Slot> {
  const slotId = int(body, "slot_id");
  const slot = (await ctx.broker.listSlots(session.id)).find((s) => s.id === slotId);
  if (!slot) throw new ApiError(`Agent slot ${slotId} is not part of session "${session.id}"`, 404);
  return slot;
}

/** Run an orchestrator tool; its failure becomes an API error rather than a quiet success. */
async function tool(name: string, args: Body): Promise<{ message: string; data?: Record<string, unknown> }> {
  const result: ToolResult = await callOrchestratorTool(name, args);
  const message = result.content.map((c) => c.text).join("\n");
  if (result.isError) throw new ApiError(message.replace(/^Error: /, ""), 422);
  return { message, data: result.data };
}

/** Peer id that addresses a slot, also when a driver runs it without one. */
function slotAddress(slot: Slot): string {
  return slot.peer_id ?? `__slot_${slot.id}__`;
}

// --- One launch at a time per key, so a double click cannot spawn agents twice ---

const inFlight = new Set<string>();

async function exclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
  if (inFlight.has(key)) throw new ApiError("The same operation is already running — wait for it to finish", 409);
  inFlight.add(key);
  try {
    return await fn();
  } finally {
    inFlight.delete(key);
  }
}

// --- Team workflow ---

export interface WorkflowOptions {
  require_reviewer_approval?: boolean;
  require_actionable_feedback?: boolean;
  /** Hold the session for a person once everything is approved (human gate). */
  human_release?: boolean;
}

/** Workflow rules every agent of a web-built team is told up front. */
export function workflowInstructions(goal: string, workflow: WorkflowOptions): string {
  const rules: string[] = [];
  if (workflow.require_reviewer_approval) {
    rules.push("Work is finished only when a reviewer has explicitly approved it (approve). Do not treat silence as approval.");
  }
  if (workflow.require_actionable_feedback) {
    rules.push("Reviewers: when you request changes, send concrete, actionable feedback (submit_feedback with actionable=true) naming what to change. Workers: revise only against such feedback.");
  }
  if (workflow.human_release) {
    rules.push("A human makes the final call: after approval, wait. Do not start new work, and do not disconnect until you receive a release message.");
  }
  const parts: string[] = [];
  if (goal.trim()) parts.push(`TEAM GOAL:\n${goal.trim()}`);
  if (rules.length) parts.push(`WORKFLOW RULES:\n${rules.map((r) => `- ${r}`).join("\n")}`);
  return parts.join("\n\n");
}

function parseAgentConfig(raw: unknown, index: number): AgentLaunchConfig {
  if (!raw || typeof raw !== "object") throw new ApiError(`Agent ${index + 1} is invalid`);
  const a = raw as Body;
  const agentType = str(a, "agent_type") as AgentType;
  if (!AGENT_TYPES.includes(agentType)) throw new ApiError(`Agent ${index + 1}: unknown type "${agentType}"`);
  const name = str(a, "name").trim();
  const role = str(a, "role").trim();
  if (!name || !role) throw new ApiError(`Agent ${index + 1}: name and role are required`);
  const ownership = Array.isArray(a.file_ownership)
    ? a.file_ownership.filter((p): p is string => typeof p === "string" && p.trim() !== "").map((p) => p.trim())
    : [];
  const settings = parseSettings(a, agentType, `Agent ${index + 1}: `);
  let provider: string | undefined;
  if (agentType === "api") {
    provider = str(a, "provider", { optional: true }).trim();
    const p = getProvider(provider);
    if (!p) throw new ApiError(`Agent ${index + 1}: pick an API provider (add one under API providers first)`);
    if (!settings.model && !p.default_model) throw new ApiError(`Agent ${index + 1}: pick a model for ${p.name}`);
  }
  return {
    agent_type: agentType,
    name,
    role,
    role_description: str(a, "role_description", { optional: true }).trim() || role,
    initial_task: str(a, "initial_task", { optional: true }).trim(),
    ...(ownership.length ? { file_ownership: ownership } : {}),
    ...(settings.model ? { model: settings.model } : {}),
    ...(settings.effort ? { effort: settings.effort } : {}),
    ...(settings.approval_mode ? { approval_mode: settings.approval_mode } : {}),
    ...(provider ? { provider } : {}),
  };
}

const APPROVAL_MODES: ApprovalMode[] = ["bypass", "auto", "accept_edits", "ask"];
const EFFORTS: Record<AgentType, string[]> = {
  claude: ["low", "medium", "high", "xhigh", "max"],
  codex: ["minimal", "low", "medium", "high"],
  gemini: [],
  // Sent as reasoning_effort; providers without it ignore or reject the field
  api: ["minimal", "low", "medium", "high"],
  custom: [],
};

/** Model, effort and approval mode from a request; "" clears a value (null). */
function parseSettings(body: Body, agentType: AgentType, prefix = ""): { model?: string | null; effort?: string | null; approval_mode?: ApprovalMode } {
  const out: { model?: string | null; effort?: string | null; approval_mode?: ApprovalMode } = {};
  if (body.model !== undefined) {
    const model = body.model === null ? "" : str(body, "model", { allowEmpty: true, optional: true }).trim();
    if (model && !/^[\w.:\/\[\]@-]{1,100}$/.test(model)) throw new ApiError(`${prefix}"${model}" is not a model name`);
    out.model = model || null;
  }
  if (body.effort !== undefined) {
    const effort = body.effort === null ? "" : str(body, "effort", { allowEmpty: true, optional: true }).trim();
    if (effort && !EFFORTS[agentType].includes(effort)) {
      throw new ApiError(`${prefix}${agentType} ${EFFORTS[agentType].length ? `effort must be one of ${EFFORTS[agentType].join(", ")}` : "has no effort setting"}`);
    }
    out.effort = effort || null;
  }
  if (body.approval_mode !== undefined && body.approval_mode !== null && body.approval_mode !== "") {
    const mode = str(body, "approval_mode") as ApprovalMode;
    if (!APPROVAL_MODES.includes(mode)) throw new ApiError(`${prefix}approval_mode must be one of ${APPROVAL_MODES.join(", ")}`);
    if (agentType === "gemini" && mode !== "bypass") throw new ApiError(`${prefix}Gemini agents run unattended (yolo); step approvals need Claude or Codex`);
    out.approval_mode = mode;
  }
  return out;
}

function positiveOrNull(body: Body, key: string): number | null | undefined {
  const v = body[key];
  if (v === undefined) return undefined;
  if (v === null || v === "" || v === 0) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new ApiError(`${key} must be a positive number`);
  return n;
}

// --- Handlers ---

const AVAILABILITY_TTL_MS = 5 * 60_000;
let availability: { at: number; result: Record<string, boolean> } | null = null;

const handlers: Record<string, Handler> = {
  // ---- Broker / environment ----

  async "agents/available"() {
    // Detection spawns the CLIs (gemini via npx, up to 15s), so the answer is cached briefly
    if (!availability || Date.now() - availability.at > AVAILABILITY_TTL_MS) {
      const entries = await Promise.all(AGENT_TYPES.map(async (t) => [t, (await detectAgent(t)).available] as const));
      availability = { at: Date.now(), result: Object.fromEntries(entries) };
    }
    return availability.result;
  },

  /** Restart a broker that runs code from before an update (data is in SQLite and survives). */
  async "broker/restart"(ctx) {
    await restartBroker(ctx.broker);
    const missing = await missingBrokerFeatures();
    if (missing.length) throw new ApiError(`The broker still lacks: ${missing.join(", ")}`, 500);
    return { message: "Broker restarted" };
  },

  // ---- API providers ("Other" agents: any OpenAI-compatible API) ----

  async "providers/list"() {
    return loadProviders().map(maskProvider);
  },

  async "providers/save"(_ctx, body) {
    const name = str(body, "name").trim();
    const base = str(body, "base_url").trim();
    if (!name || !base) throw new ApiError("Name and base URL are required");
    let extra: Record<string, unknown> | undefined;
    const rawExtra = typeof body.extra_body === "string" ? body.extra_body.trim() : "";
    if (rawExtra) {
      try { extra = JSON.parse(rawExtra); } catch { throw new ApiError("Extra request fields must be a JSON object"); }
      if (!extra || typeof extra !== "object" || Array.isArray(extra)) throw new ApiError("Extra request fields must be a JSON object");
    }
    try {
      const saved = saveProvider({
        id: str(body, "id", { optional: true }).trim() || undefined,
        name, base_url: base,
        api_key: str(body, "api_key", { optional: true, allowEmpty: true }),
        default_model: str(body, "default_model", { optional: true, allowEmpty: true }),
        extra_body: extra ?? {},
        input_price: body.input_price as number | undefined,
        output_price: body.output_price as number | undefined,
        context_tokens: body.context_tokens as number | undefined,
      });
      availability = null; // "api" becomes available
      return { message: `Saved ${saved.name}`, provider: maskProvider(saved) };
    } catch (e) {
      throw new ApiError(e instanceof Error ? e.message : String(e));
    }
  },

  async "providers/delete"(_ctx, body) {
    const id = str(body, "id");
    if (!deleteProvider(id)) throw new ApiError("No such provider", 404);
    availability = null;
    return { message: "Provider removed" };
  },

  /** Check a provider (saved, or the form's unsaved values) by listing its models. */
  async "providers/models"(_ctx, body) {
    const id = str(body, "id", { optional: true }).trim();
    const stored = id ? getProvider(id) : null;
    const base = str(body, "base_url", { optional: true }).trim();
    const key = str(body, "api_key", { optional: true, allowEmpty: true }).trim();
    const p: ApiProvider | null = base
      ? { id: stored?.id ?? "unsaved", name: str(body, "name", { optional: true }).trim() || stored?.name || "Provider", base_url: normalizeBaseUrl(base), api_key: key || stored?.api_key || "" }
      : stored;
    if (!p) throw new ApiError("Give a base URL or a saved provider");
    try {
      const models = await fetchProviderModels(p);
      return { message: `${p.name}: ${models.length} model(s)`, models };
    } catch (e) {
      throw new ApiError(e instanceof Error ? e.message : String(e), 502);
    }
  },

  // ---- Sessions ----

  async "session/create"(ctx, body) {
    const name = str(body, "name").trim();
    const projectDir = str(body, "project_dir").trim();
    if (!name) throw new ApiError("name is required");
    const fs = await import("node:fs");
    if (!fs.existsSync(projectDir) || !fs.statSync(projectDir).isDirectory()) {
      throw new ApiError(`Project directory "${projectDir}" does not exist`);
    }
    return await createSessionRecord(ctx.broker, name, projectDir, ctx.brokerPort);
  },

  async "session/control"(ctx, body) {
    const session = await requireSession(ctx, body);
    const action = str(body, "action");
    if (action !== "pause" && action !== "resume") throw new ApiError(`Unknown action "${action}"`);
    const result = await controlSession(session.id, action === "pause" ? "pause_all" : "resume_all", ctx.broker);
    if (result.status === "error") throw new ApiError(result.message, 422);
    return { message: result.message, affected: result.affected };
  },

  /** Respawn the session's disconnected, unreleased agents under this host. */
  async "session/relaunch"(ctx, body) {
    const session = await requireSession(ctx, body);
    return await exclusive(`launch:${session.id}`, () => tool("resume_session", { session_id: session.id }));
  },

  /** Archive the record only (`multiagents session archive`); running agents are untouched. */
  async "session/archive"(ctx, body) {
    const session = await requireSession(ctx, body);
    await ctx.broker.updateSession({ id: session.id, status: "archived" });
    return { message: `Session "${session.id}" archived.` };
  },

  /** Stop the agents this host runs, disconnect every slot and archive (end_session). */
  async "session/end"(ctx, body) {
    const session = await requireSession(ctx, body);
    return await tool("end_session", { session_id: session.id });
  },

  async "session/delete"(ctx, body) {
    const session = await requireSession(ctx, body);
    if (body.confirm !== session.id) throw new ApiError("Type the session id to confirm deletion");
    return await tool("delete_session", { session_id: session.id });
  },

  /**
   * Q&A mode: hold the team's work so the person can ask agents questions one
   * at a time. Running turns stop, agents only hear the person (and the
   * orchestrator) and may only read; teammates' messages wait until it ends.
   */
  async "session/qa"(ctx, body) {
    const session = await requireSession(ctx, body);
    const enabled = body.enabled === true;
    const wasOn = !!safeJsonParse<Record<string, unknown>>(session.config, {}).qa_mode;
    if (enabled === wasOn) return { message: enabled ? "Q&A mode is already on" : "Q&A mode is already off" };
    await ctx.broker.updateSession({ id: session.id, config_patch: { qa_mode: enabled ? { since: Date.now() } : null } });
    const slots = (await ctx.broker.listSlots(session.id)).filter((s) => s.task_state !== "released");
    for (const slot of slots) {
      await ctx.broker.sendMessage({ from_id: "orchestrator", to_slot_id: slot.id, text: enabled ? QA_HOLD_TEXT : QA_RESUME_TEXT, msg_type: "system", session_id: session.id });
    }
    return { message: enabled ? "Q&A mode on: the team's work is on hold" : "Q&A mode off: the team resumes its work" };
  },

  async "session/human-gate"(ctx, body) {
    const session = await requireSession(ctx, body);
    const enabled = body.enabled === true;
    await ctx.broker.updateSession({ id: session.id, config_patch: { human_gate: enabled } });
    return { message: enabled ? "Human gate on: approved work waits for your release." : "Human gate off: the session ends itself once everything is approved." };
  },

  // ---- Teams & agents ----

  async "team/create"(ctx, body) {
    const projectDir = str(body, "project_dir").trim();
    const sessionName = str(body, "session_name").trim();
    if (!projectDir.startsWith("/")) throw new ApiError("project_dir must be an absolute path");
    if (!sessionName) throw new ApiError("session_name is required");
    if (!Array.isArray(body.agents) || body.agents.length === 0) throw new ApiError("Add at least one agent");
    const workflow = (body.workflow ?? {}) as WorkflowOptions;
    const preamble = workflowInstructions(str(body, "goal", { optional: true }), workflow);
    const agents = body.agents.map((a, i) => {
      const cfg = parseAgentConfig(a, i);
      const task = [preamble, cfg.initial_task ? `YOUR TASK:\n${cfg.initial_task}` : ""].filter(Boolean).join("\n\n");
      if (!task) throw new ApiError(`Agent ${i + 1}: give the team a goal or the agent a task`);
      return { ...cfg, initial_task: task };
    });
    const names = new Set<string>();
    for (const a of agents) {
      if (names.has(a.name.toLowerCase())) throw new ApiError(`Two agents are named "${a.name}"`);
      names.add(a.name.toLowerCase());
    }
    const plan = Array.isArray(body.plan)
      ? (body.plan as Body[]).filter((p) => typeof p?.label === "string" && (p.label as string).trim())
          .map((p) => ({ label: (p.label as string).trim(), ...(typeof p.agent_name === "string" && p.agent_name ? { agent_name: p.agent_name } : {}) }))
      : [];
    return await exclusive(`team:${projectDir}`, () => tool("create_team", {
      project_dir: projectDir,
      session_name: sessionName,
      agents,
      ...(plan.length ? { plan } : {}),
      human_gate: workflow.human_release === true,
    }));
  },

  async "agents/add"(ctx, body) {
    const session = await requireSession(ctx, body);
    if (session.status === "archived") throw new ApiError("The session is archived");
    const cfg = parseAgentConfig(body, 0);
    if (!cfg.initial_task) throw new ApiError("initial_task is required");
    const slots = await ctx.broker.listSlots(session.id);
    if (slots.some((s) => s.task_state !== "released" && s.display_name?.toLowerCase() === cfg.name.toLowerCase())) {
      throw new ApiError(`An agent named "${cfg.name}" is already in the session`);
    }
    return await exclusive(`launch:${session.id}`, () => tool("add_agent", { session_id: session.id, ...cfg }));
  },

  async "agents/control"(ctx, body) {
    const session = await requireSession(ctx, body);
    const slot = await requireSlot(ctx, session, body);
    const action = str(body, "action");
    if (action !== "pause" && action !== "resume") throw new ApiError(`Unknown action "${action}"`);
    const result = await controlSession(session.id, action === "pause" ? "pause_agent" : "resume_agent", ctx.broker, String(slot.id));
    if (result.status === "error") throw new ApiError(result.message, 422);
    return { message: result.message };
  },

  async "agents/release"(ctx, body) {
    const session = await requireSession(ctx, body);
    const slot = await requireSlot(ctx, session, body);
    if (slot.task_state === "released") throw new ApiError(`${slot.display_name ?? `Slot ${slot.id}`} is already released`);
    return await tool("release_agent", { session_id: session.id, target: String(slot.id), message: str(body, "message", { optional: true }) || undefined });
  },

  async "agents/release-all"(ctx, body) {
    const session = await requireSession(ctx, body);
    return await tool("release_all", { session_id: session.id, approved_only: body.approved_only === true, message: str(body, "message", { optional: true }) || undefined });
  },

  async "agents/remove"(ctx, body) {
    const session = await requireSession(ctx, body);
    const slot = await requireSlot(ctx, session, body);
    return await tool("remove_agent", { session_id: session.id, target: String(slot.id) });
  },

  async "agents/rename"(ctx, body) {
    const session = await requireSession(ctx, body);
    const slot = await requireSlot(ctx, session, body);
    const displayName = str(body, "display_name").trim();
    if (!displayName) throw new ApiError("display_name is required");
    await ctx.broker.renamePeer({ peer_id: slotAddress(slot), assigner_id: HUMAN_ID, slot_id: slot.id, display_name: displayName });
    return { message: `Renamed to ${displayName}` };
  },

  async "agents/role"(ctx, body) {
    const session = await requireSession(ctx, body);
    const slot = await requireSlot(ctx, session, body);
    const role = str(body, "role").trim();
    if (!role) throw new ApiError("role is required");
    const roleDescription = str(body, "role_description", { optional: true }).trim() || slot.role_description || role;
    await ctx.broker.setRole({ peer_id: slotAddress(slot), assigner_id: HUMAN_ID, slot_id: slot.id, role, role_description: roleDescription });
    return { message: `${slot.display_name ?? `Slot ${slot.id}`} is now ${role}` };
  },

  /** Human review verdict "send back": actionable feedback moves the agent to addressing_feedback. */
  async "agents/feedback"(ctx, body) {
    const session = await requireSession(ctx, body);
    const slot = await requireSlot(ctx, session, body);
    if (slot.task_state === "released") throw new ApiError("A released agent cannot take feedback");
    const feedback = str(body, "feedback").trim();
    const result = await ctx.broker.submitFeedback({
      peer_id: HUMAN_ID,
      session_id: session.id,
      target_slot_id: slot.id,
      feedback: `[Human review] ${feedback}`,
      actionable: true,
    });
    return { message: `Sent back to ${slot.display_name ?? `slot ${slot.id}`} (${result.task_state})` };
  },

  /** Model, effort, approval mode and token limit; a running agent picks them up within seconds. */
  async "agents/settings"(ctx, body) {
    const session = await requireSession(ctx, body);
    const slot = await requireSlot(ctx, session, body);
    const patch: Record<string, unknown> = parseSettings(body, slot.agent_type);
    if (slot.agent_type === "api" && patch.model === null) {
      // Without a model a restarted agent could not launch: fall back to the provider's default, or refuse
      const providerId = safeJsonParse<Record<string, unknown>>(slot.context_snapshot, {}).provider_id;
      const p = getProvider(typeof providerId === "string" ? providerId : null);
      if (!p?.default_model) throw new ApiError(`${p?.name ?? "This provider"} has no default model; keep a model set`);
    }
    const limit = positiveOrNull(body, "token_limit");
    if (limit !== undefined) patch.token_limit = limit === null ? null : Math.round(limit);
    if (!Object.keys(patch).length) throw new ApiError("Nothing to change");
    await ctx.broker.updateSlot({ id: slot.id, context_patch: patch });
    const live = slot.agent_type === "gemini" && (patch.model !== undefined)
      ? " The model applies when the agent next starts."
      : slot.agent_type === "claude" && patch.effort !== undefined ? " Effort applies when the agent next starts." : "";
    return { message: `Updated ${slot.display_name ?? `slot ${slot.id}`}.${live}` };
  },

  /** Usage limits: an agent over its limit, or every agent of a session over the session limit, is paused. */
  async "session/limits"(ctx, body) {
    const session = await requireSession(ctx, body);
    const raw = (body.limits ?? {}) as Body;
    const limits: Record<string, number> = {};
    for (const key of ["agent_tokens", "agent_cost_usd", "session_tokens", "session_cost_usd"]) {
      const v = positiveOrNull(raw, key);
      if (v) limits[key] = key.endsWith("tokens") ? Math.round(v) : v;
    }
    await ctx.broker.updateSession({ id: session.id, config_patch: { limits } });
    return { message: Object.keys(limits).length ? "Usage limits saved" : "Usage limits removed", limits };
  },

  /** Answer an agent's tool call that waits for a person. */
  async "approvals/decide"(ctx, body) {
    const session = await requireSession(ctx, body);
    const decision = str(body, "decision");
    if (decision !== "allow" && decision !== "deny") throw new ApiError(`decision must be allow or deny`);
    const row = await ctx.broker.decideApproval({
      id: int(body, "approval_id"),
      session_id: session.id,
      decision,
      always: body.always === true,
      note: str(body, "note", { optional: true }).trim() || undefined,
      decided_by: HUMAN_ID,
    });
    return { message: `${decision === "allow" ? (row.always ? "Always allowed" : "Approved") : "Denied"}: ${row.title}`, approval: row };
  },

  // ---- Messages ----

  async "messages/send"(ctx, body) {
    const session = await requireSession(ctx, body);
    const text = str(body, "text").trim();
    if (!text) throw new ApiError("Message is empty");
    if (body.slot_id === "all") {
      const { delivered_to } = await broadcastToTeam(session.id, text, ctx.broker, undefined, HUMAN_ID);
      if (delivered_to === 0) throw new ApiError("No connected, unpaused agent to broadcast to", 422);
      return { message: `Broadcast to ${delivered_to} agent(s)` };
    }
    const slot = await requireSlot(ctx, session, body);
    const result = await ctx.broker.sendMessage({ from_id: HUMAN_ID, to_slot_id: slot.id, text, msg_type: "chat", session_id: session.id });
    if (!result.ok) throw new ApiError(result.error ?? "Broker refused the message", 422);
    // "Interrupt and ask": the host running the agent stops its current turn, so the question is answered next
    if (body.interrupt === true) {
      await ctx.broker.updateSlot({ id: slot.id, context_patch: { interrupt_at: Date.now() } });
      return { message: `Interrupted ${slot.display_name ?? `slot ${slot.id}`} and asked`, warning: result.warning };
    }
    return { message: result.warning ?? `Sent to ${slot.display_name ?? `slot ${slot.id}`}`, warning: result.warning };
  },

  // ---- Plan ----

  async "plan/add"(ctx, body) {
    const session = await requireSession(ctx, body);
    const assigned = body.slot_id === undefined || body.slot_id === null || body.slot_id === "" ? null : (await requireSlot(ctx, session, body)).id;
    return await ctx.broker.addPlanItem({ session_id: session.id, label: str(body, "label"), assigned_to_slot: assigned });
  },

  async "plan/edit"(ctx, body) {
    const session = await requireSession(ctx, body);
    const edit: Parameters<BrokerClient["editPlanItem"]>[0] = { session_id: session.id, item_id: int(body, "item_id") };
    if (body.label !== undefined) edit.label = str(body, "label");
    if (body.status !== undefined) {
      const status = str(body, "status");
      if (!(PLAN_STATUSES as readonly string[]).includes(status)) throw new ApiError(`Invalid status "${status}"`);
      edit.status = status as typeof PLAN_STATUSES[number];
    }
    if (body.slot_id !== undefined) {
      edit.assigned_to_slot = body.slot_id === null || body.slot_id === "" ? null : (await requireSlot(ctx, session, body)).id;
    }
    return await ctx.broker.editPlanItem(edit);
  },

  async "plan/delete"(ctx, body) {
    const session = await requireSession(ctx, body);
    return await ctx.broker.deletePlanItem(session.id, int(body, "item_id"));
  },

  // ---- Knowledge ----

  async "knowledge/put"(ctx, body) {
    const session = await requireSession(ctx, body);
    const category = (str(body, "category", { optional: true }) || "context") as KnowledgeCategory;
    if (!KNOWLEDGE_CATEGORIES.includes(category)) throw new ApiError(`Invalid category "${category}"`);
    return await ctx.broker.putKnowledge({
      session_id: session.id,
      key: str(body, "key").trim(),
      value: str(body, "value"),
      category,
      slot_name: "Human",
    });
  },

  async "knowledge/delete"(ctx, body) {
    const session = await requireSession(ctx, body);
    return await ctx.broker.deleteKnowledge(session.id, str(body, "key"));
  },

  // ---- Files ----

  /** Take a lock on an agent's behalf (e.g. to reserve a file for it). */
  async "files/acquire"(ctx, body) {
    const session = await requireSession(ctx, body);
    const slot = await requireSlot(ctx, session, body);
    const minutes = body.minutes === undefined ? 10 : Number(body.minutes);
    if (!Number.isFinite(minutes) || minutes <= 0) throw new ApiError("minutes must be positive");
    const result = await ctx.broker.acquireFile({
      session_id: session.id,
      peer_id: slotAddress(slot),
      slot_id: slot.id,
      file_path: str(body, "file_path").trim(),
      purpose: str(body, "purpose", { optional: true }) || "Reserved via web dashboard",
      timeout_ms: Math.round(minutes * 60_000),
    });
    if (result.status !== "acquired" && result.status !== "extended") throw new ApiError(result.message, 409);
    return result;
  },

  /** Force-unlock: drop a lock whoever holds it. */
  async "files/release"(ctx, body) {
    const session = await requireSession(ctx, body);
    const lockId = int(body, "lock_id");
    const lock = (await ctx.broker.listFileLocks(session.id)).find((l) => l.id === lockId);
    if (!lock) throw new ApiError("Lock not found (it may have expired)", 404);
    await ctx.broker.releaseFile({ session_id: session.id, peer_id: lock.held_by_peer, file_path: lock.file_path });
    return { message: `Unlocked ${lock.file_path}` };
  },

  async "files/ownership"(ctx, body) {
    const session = await requireSession(ctx, body);
    const slot = await requireSlot(ctx, session, body);
    const patterns = Array.isArray(body.patterns)
      ? body.patterns.filter((p): p is string => typeof p === "string" && p.trim() !== "").map((p) => p.trim())
      : [];
    if (!patterns.length) throw new ApiError("Give at least one path pattern");
    const result = await ctx.broker.assignOwnership({ session_id: session.id, slot_id: slot.id, path_patterns: patterns, assigned_by: HUMAN_ID }) as { ok: boolean; message?: string };
    if (!result.ok) throw new ApiError(result.message ?? "Ownership conflict", 409);
    return { message: `Assigned ${patterns.join(", ")}` };
  },

  // ---- Guardrails ----

  async "guardrail"(ctx, body) {
    const session = await requireSession(ctx, body);
    const value = Number(body.value);
    if (!Number.isFinite(value) || value < 0) throw new ApiError("value must be a non-negative number");
    const result = await controlSession(session.id, "set_budget", ctx.broker, str(body, "guardrail_id"), value, {
      changedBy: "web-dashboard",
      reason: str(body, "reason", { optional: true }) || "Adjusted via web dashboard",
    });
    if (result.status === "error") throw new ApiError(result.message, 422);
    return result.guardrail;
  },
};

/** Dispatch POST /api/<action>. */
export async function handleControl(ctx: ControlContext, action: string, body: Body): Promise<unknown> {
  const handler = handlers[action];
  if (!handler) throw new ApiError(`Unknown API action "${action}"`, 404);
  return await handler(ctx, body);
}

export const CONTROL_ACTIONS = Object.keys(handlers);

/** GET /api/activity?session_id=&slot_id=&after_id=&limit= — the agents' steps, oldest first. */
export async function listActivity(ctx: ControlContext, url: URL): Promise<unknown> {
  const sessionId = url.searchParams.get("session_id");
  if (!sessionId) throw new ApiError("session_id is required");
  const num = (k: string) => (url.searchParams.get(k) ? Number(url.searchParams.get(k)) : undefined);
  return await ctx.broker.listActivity({ session_id: sessionId, slot_id: num("slot_id"), after_id: num("after_id"), limit: num("limit") });
}

/** GET /api/session/export — the full session as JSON. */
export async function exportSession(ctx: ControlContext, sessionId: string): Promise<unknown> {
  const session = await ctx.broker.getSession(sessionId).catch(() => null);
  if (!session) throw new ApiError(`Session "${sessionId}" not found`, 404);
  return await exportSessionData(ctx.broker, sessionId);
}

/** Whether a session waits on a person: human gate on and every live agent approved. */
export function awaitingHuman(session: Session | null, slots: Slot[]): boolean {
  if (!session || session.status === "archived") return false;
  if (safeJsonParse<Record<string, unknown>>(session.config, {}).human_gate !== true) return false;
  const live = slots.filter((s) => s.task_state !== "released");
  return live.length > 0 && live.every((s) => s.task_state === "approved");
}
