import type { Session, Slot, TokenOptimizationConfig, ResolvedModelPolicy } from "../shared/types.ts";
import { DEFAULT_OPTIMIZATION, estimateCostUsd } from "../shared/model-routing.ts";
import { safeJsonParse } from "../shared/utils.ts";

export interface AgentOptimizationReport {
  slot_id: number;
  name: string;
  tier: string;
  model: string;
  reasoning_effort: string;
  reason: string;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  total_tokens: number;
  token_budget: number;
  budget_percent: number;
  escalation_count: number;
  successful: boolean;
  estimated_cost_usd?: number;
}

export interface OptimizationReport {
  enabled: boolean;
  session_token_budget: number;
  total_tokens: number;
  budget_percent: number;
  estimated_cost_usd?: number;
  agents: AgentOptimizationReport[];
  successful_agents: number;
  tokens_per_successful_agent?: number;
}

export function getOptimizationConfig(session: Session): TokenOptimizationConfig {
  return safeJsonParse<{ optimization?: TokenOptimizationConfig }>(session.config, {}).optimization ?? {};
}

export function buildOptimizationReport(session: Session, slots: Slot[]): OptimizationReport {
  const config = getOptimizationConfig(session);
  const sessionBudget = config.session_token_budget ?? DEFAULT_OPTIMIZATION.session_token_budget;
  let estimatedCost = 0;
  let hasPricing = false;
  const agents = slots.map((slot): AgentOptimizationReport => {
    const snapshot = safeJsonParse<{ optimization?: ResolvedModelPolicy }>(slot.context_snapshot, {});
    const policy = snapshot.optimization;
    const input = slot.input_tokens ?? 0;
    const output = slot.output_tokens ?? 0;
    const cached = slot.cache_read_tokens ?? 0;
    const total = input + output;
    const budget = policy?.token_budget ?? config.default_agent_token_budget ?? DEFAULT_OPTIMIZATION.default_agent_token_budget;
    const cost = estimateCostUsd(policy?.model, input, output, cached, config.pricing);
    if (cost !== undefined) { hasPricing = true; estimatedCost += cost; }
    return {
      slot_id: slot.id,
      name: slot.display_name ?? slot.role ?? `slot-${slot.id}`,
      tier: policy?.tier ?? "unclassified",
      model: policy?.model ?? "provider-default",
      reasoning_effort: policy?.reasoning_effort ?? "provider-default",
      reason: policy?.classification?.reasons?.join(", ") ?? "legacy slot",
      input_tokens: input,
      output_tokens: output,
      cached_tokens: cached,
      total_tokens: total,
      token_budget: budget,
      budget_percent: budget > 0 ? Math.round((total / budget) * 10_000) / 100 : 0,
      escalation_count: policy?.escalation_count ?? 0,
      successful: slot.task_state === "approved" || slot.task_state === "released",
      ...(cost !== undefined ? { estimated_cost_usd: Math.round(cost * 1_000_000) / 1_000_000 } : {}),
    };
  });
  const totalTokens = agents.reduce((sum, agent) => sum + agent.total_tokens, 0);
  const successfulAgents = agents.filter((agent) => agent.successful).length;
  return {
    enabled: config.enabled ?? DEFAULT_OPTIMIZATION.enabled,
    session_token_budget: sessionBudget,
    total_tokens: totalTokens,
    budget_percent: sessionBudget > 0 ? Math.round((totalTokens / sessionBudget) * 10_000) / 100 : 0,
    ...(hasPricing ? { estimated_cost_usd: Math.round(estimatedCost * 1_000_000) / 1_000_000 } : {}),
    agents,
    successful_agents: successfulAgents,
    ...(successfulAgents > 0 ? { tokens_per_successful_agent: Math.round(totalTokens / successfulAgents) } : {}),
  };
}

export function formatOptimizationReport(report: OptimizationReport): string {
  const lines = [
    "=== Token optimization ===",
    `Session: ${report.total_tokens}/${report.session_token_budget} tokens (${report.budget_percent}%)` +
      (report.estimated_cost_usd !== undefined ? ` | Estimated cost: $${report.estimated_cost_usd.toFixed(4)}` : ""),
    `Successful agents: ${report.successful_agents}/${report.agents.length}` +
      (report.tokens_per_successful_agent !== undefined ? ` | Tokens/success: ${report.tokens_per_successful_agent}` : ""),
    "",
  ];
  for (const agent of report.agents) {
    lines.push(`${agent.name}: ${agent.tier} / ${agent.model} / effort=${agent.reasoning_effort}`);
    lines.push(`  Tokens: ${agent.total_tokens}/${agent.token_budget} (${agent.budget_percent}%), cache=${agent.cached_tokens}, escalations=${agent.escalation_count}`);
    lines.push(`  Decision: ${agent.reason}` + (agent.estimated_cost_usd !== undefined ? ` | Cost: $${agent.estimated_cost_usd.toFixed(4)}` : ""));
  }
  if (!report.agents.length) lines.push("No agents in this session.");
  if (report.estimated_cost_usd === undefined) lines.push("", "Cost unavailable: configure per-model pricing to enable estimates.");
  return lines.join("\n");
}
