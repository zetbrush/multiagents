import type {
  AgentLaunchConfig,
  AgentType,
  ModelPolicy,
  ModelTier,
  ResolvedModelPolicy,
  TaskClassification,
  TierModelConfig,
  TokenOptimizationConfig,
} from "./types.ts";

const TIER_ORDER: ModelTier[] = ["economy", "balanced", "expert"];

/**
 * Defaults deliberately use stable CLI aliases where providers expose them.
 * Every value can be replaced per session or with MULTIAGENTS_* environment
 * variables, so adding a new model never requires a release.
 */
export const DEFAULT_TIER_MODELS: Record<AgentType, Record<ModelTier, TierModelConfig>> = {
  claude: {
    economy: { model: process.env.MULTIAGENTS_CLAUDE_ECONOMY_MODEL ?? "haiku", reasoning_effort: "low", max_output_tokens: 2_000 },
    balanced: { model: process.env.MULTIAGENTS_CLAUDE_BALANCED_MODEL ?? "sonnet", reasoning_effort: "medium", max_output_tokens: 6_000 },
    expert: { model: process.env.MULTIAGENTS_CLAUDE_EXPERT_MODEL ?? "opus", reasoning_effort: "high", max_output_tokens: 12_000 },
  },
  codex: {
    economy: { model: process.env.MULTIAGENTS_CODEX_ECONOMY_MODEL ?? "gpt-5.6-luna", reasoning_effort: "low", max_output_tokens: 2_000 },
    balanced: { model: process.env.MULTIAGENTS_CODEX_BALANCED_MODEL ?? "gpt-5.6-terra", reasoning_effort: "medium", max_output_tokens: 6_000 },
    expert: { model: process.env.MULTIAGENTS_CODEX_EXPERT_MODEL ?? "gpt-5.6-sol", reasoning_effort: "high", max_output_tokens: 12_000 },
  },
  agy: {
    economy: { model: process.env.MULTIAGENTS_AGY_ECONOMY_MODEL, reasoning_effort: "low", max_output_tokens: 2_000 },
    balanced: { model: process.env.MULTIAGENTS_AGY_BALANCED_MODEL, reasoning_effort: "medium", max_output_tokens: 6_000 },
    expert: { model: process.env.MULTIAGENTS_AGY_EXPERT_MODEL, reasoning_effort: "high", max_output_tokens: 12_000 },
  },
  custom: {
    economy: { reasoning_effort: "low", max_output_tokens: 2_000 },
    balanced: { reasoning_effort: "medium", max_output_tokens: 6_000 },
    expert: { reasoning_effort: "high", max_output_tokens: 12_000 },
  },
};

export const DEFAULT_OPTIMIZATION: Required<Pick<TokenOptimizationConfig,
  "enabled" | "session_token_budget" | "default_agent_token_budget" | "auto_escalate" | "right_size"
  | "decay_after_stable_turns" | "proactive_escalation_percent"
>> = {
  enabled: true,
  session_token_budget: 250_000,
  default_agent_token_budget: 60_000,
  auto_escalate: true,
  right_size: "recommend",
  decay_after_stable_turns: 3,
  proactive_escalation_percent: 70,
};

/**
 * Scoring bands. The economy band is deliberately wide: a short brief carrying a
 * single mild engineering signal ("implement an endpoint") is cheap to retry, and
 * auto-escalation (on budget pressure or a failed run) promotes it when the task
 * turns out to be harder than it read. Starting one tier too low costs a retry;
 * starting one tier too high costs every turn.
 */
const ECONOMY_MAX_SCORE = 2;
const EXPERT_MIN_SCORE = 5;

const expertPatterns = [
  /\b(architect|architecture|security|sécurit|migration|distributed|concurren|race condition)\b/i,
  /\b(cryptograph|authentication|authorization|payment|production incident|data loss)\b/i,
  /\b(refactor.*(?:system|entire|large)|cross[- ]cutting|multi[- ]service)\b/i,
];
const simplePatterns = [
  /\b(typo|rename|format|lint|comment|documentation|readme|copy|texte|couleur)\b/i,
  /\b(single file|one file|un fichier|petite modification|simple|trivial)\b/i,
  /\b(explain|résume|summari[sz]e|lookup|recherche)\b/i,
];
const complexityPatterns = [
  /\b(debug|bug|implement|feature|api|database|test|review|integration)\b/i,
  /\b(android|ios|web|backend|frontend|typescript|rust|python|java)\b/i,
];

/** Free, deterministic task classification: no model call and no tokens. */
export function classifyTask(config: Pick<AgentLaunchConfig, "initial_task" | "role" | "role_description" | "file_ownership">): TaskClassification {
  const text = `${config.initial_task} ${config.role} ${config.role_description}`;
  let score = 2;
  const reasons: string[] = [];
  let complexityMatches = 0;

  for (const pattern of expertPatterns) {
    if (pattern.test(text)) { score += 2; reasons.push(`high-risk signal: ${pattern.source.slice(0, 28)}`); }
  }
  for (const pattern of complexityPatterns) {
    if (pattern.test(text)) {
      score += 1;
      complexityMatches += 1;
      reasons.push(`engineering signal: ${pattern.source.slice(0, 28)}`);
    }
  }
  for (const pattern of simplePatterns) {
    if (pattern.test(text)) { score -= 1; reasons.push(`bounded/simple signal: ${pattern.source.slice(0, 28)}`); }
  }
  if (text.length > 1_500) { score += 2; reasons.push("large task brief"); }
  // A concise brief is not necessarily a simple task. Do not cancel a real
  // engineering signal merely because the acceptance criteria are compact.
  else if (text.length < 260 && complexityMatches === 0) { score -= 1; reasons.push("short task brief"); }
  const ownershipCount = config.file_ownership?.length ?? 0;
  if (ownershipCount >= 4) { score += 1; reasons.push("broad file ownership"); }
  if (/review|qa|test/i.test(config.role) && !expertPatterns.some((p) => p.test(text))) {
    score -= 1;
    reasons.push("bounded verification role");
  }

  const tier: ModelTier = score <= ECONOMY_MAX_SCORE ? "economy" : score >= EXPERT_MIN_SCORE ? "expert" : "balanced";
  const recommended_agent_count = score <= ECONOMY_MAX_SCORE ? 1 : score >= 6 ? 3 : 2;
  const distance = tier === "economy"
    ? ECONOMY_MAX_SCORE - score
    : tier === "expert"
      ? score - EXPERT_MIN_SCORE + 1
      : Math.min(score - ECONOMY_MAX_SCORE, EXPERT_MIN_SCORE - score);
  return {
    tier,
    score,
    confidence: Math.max(0.55, Math.min(0.95, 0.62 + Math.max(0, distance) * 0.08)),
    reasons: reasons.slice(0, 5).length ? reasons.slice(0, 5) : ["default task complexity"],
    recommended_agent_count,
  };
}

function configuredTier(agentType: AgentType, tier: ModelTier, optimization?: TokenOptimizationConfig): TierModelConfig {
  return {
    ...DEFAULT_TIER_MODELS[agentType][tier],
    ...(optimization?.tiers?.[agentType]?.[tier] ?? {}),
  };
}

export function resolveModelPolicy(
  config: AgentLaunchConfig,
  optimization: TokenOptimizationConfig = {},
  previous?: Partial<ResolvedModelPolicy>,
): ResolvedModelPolicy {
  const classification = classifyTask(config);
  const requested: ModelPolicy = config.model_policy ?? {};
  const tier = requested.tier ?? previous?.tier ?? classification.tier;
  const tierConfig = configuredTier(config.agent_type, tier, optimization);
  return {
    tier,
    model: requested.model ?? tierConfig.model,
    reasoning_effort: requested.reasoning_effort ?? tierConfig.reasoning_effort,
    token_budget: requested.token_budget ?? optimization.default_agent_token_budget ?? DEFAULT_OPTIMIZATION.default_agent_token_budget,
    max_output_tokens: requested.max_output_tokens ?? tierConfig.max_output_tokens,
    auto_escalate: requested.auto_escalate ?? optimization.auto_escalate ?? DEFAULT_OPTIMIZATION.auto_escalate,
    classification,
    escalation_count: previous?.escalation_count ?? 0,
    stable_turns: previous?.stable_turns ?? 0,
  };
}

export function escalateModelPolicy(policy: ResolvedModelPolicy, agentType: AgentType, optimization: TokenOptimizationConfig = {}): ResolvedModelPolicy {
  if (!policy.auto_escalate) return policy;
  const currentIndex = TIER_ORDER.indexOf(policy.tier);
  if (currentIndex >= TIER_ORDER.length - 1) return policy;
  const tier = TIER_ORDER[currentIndex + 1]!;
  const next = configuredTier(agentType, tier, optimization);
  return {
    ...policy,
    tier,
    model: next.model,
    reasoning_effort: next.reasoning_effort,
    max_output_tokens: next.max_output_tokens,
    escalation_count: policy.escalation_count + 1,
    stable_turns: 0,
  };
}

/**
 * Record a completed turn that needed no escalation. Tier stickiness is the
 * expensive failure mode: one hard task used to pin an agent on `expert` for the
 * rest of the session, including trivial follow-ups. After
 * `decay_after_stable_turns` clean turns the tier steps back down one level
 * (expert -> balanced -> economy) and one escalation is forgiven, so an agent
 * that has settled drifts back toward its cheapest workable tier.
 *
 * Returns a new policy on every call (`stable_turns` always advances), so callers
 * should persist the result. Compare `tier` to detect an actual decay.
 */
export function decayModelPolicy(
  policy: ResolvedModelPolicy,
  agentType: AgentType,
  optimization: TokenOptimizationConfig = {},
): ResolvedModelPolicy {
  const threshold = optimization.decay_after_stable_turns ?? DEFAULT_OPTIMIZATION.decay_after_stable_turns;
  const stableTurns = (policy.stable_turns ?? 0) + 1;
  const currentIndex = TIER_ORDER.indexOf(policy.tier);

  // Decay follows the same opt-in flag as escalation: an agent pinned to a tier
  // by the caller keeps that tier in both directions.
  if (!policy.auto_escalate || threshold <= 0 || stableTurns < threshold || currentIndex <= 0) {
    return { ...policy, stable_turns: stableTurns };
  }

  const tier = TIER_ORDER[currentIndex - 1]!;
  const next = configuredTier(agentType, tier, optimization);
  return {
    ...policy,
    tier,
    model: next.model,
    reasoning_effort: next.reasoning_effort,
    max_output_tokens: next.max_output_tokens,
    escalation_count: Math.max(0, policy.escalation_count - 1),
    stable_turns: 0,
  };
}

export function recommendedTeamSize(agents: AgentLaunchConfig[]): number {
  if (agents.length === 0) return 0;
  return Math.max(...agents.map((agent) => classifyTask(agent).recommended_agent_count));
}

/** Select useful roles when the caller explicitly enables enforced right-sizing. */
export function rightSizeTeam(agents: AgentLaunchConfig[], count = recommendedTeamSize(agents)): AgentLaunchConfig[] {
  if (agents.length <= count) return [...agents];
  const ranked = agents.map((agent, index) => {
    const role = `${agent.role} ${agent.initial_task}`;
    const primary = /engineer|developer|implement|architect|designer|ui\/ux/i.test(role) ? 0
      : /review|qa|test|audit/i.test(role) ? 1 : 2;
    return { agent, index, primary, score: classifyTask(agent).score };
  });
  ranked.sort((a, b) => a.primary - b.primary || b.score - a.score || a.index - b.index);
  const selected = new Set(ranked.slice(0, count).map((item) => item.index));
  return agents.filter((_, index) => selected.has(index));
}

export function estimateCostUsd(
  model: string | undefined,
  inputTokens: number,
  outputTokens: number,
  cachedTokens: number,
  pricing?: TokenOptimizationConfig["pricing"],
): number | undefined {
  if (!model || !pricing?.[model]) return undefined;
  const rate = pricing[model]!;
  const uncachedInput = Math.max(0, inputTokens - cachedTokens);
  return ((uncachedInput * rate.input) + (outputTokens * rate.output) + (cachedTokens * (rate.cached_input ?? rate.input))) / 1_000_000;
}
