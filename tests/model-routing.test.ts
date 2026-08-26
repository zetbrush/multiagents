import { describe, expect, test } from "bun:test";
import {
  classifyTask,
  escalateModelPolicy,
  estimateCostUsd,
  recommendedTeamSize,
  resolveModelPolicy,
  rightSizeTeam,
} from "../shared/model-routing.ts";
import { buildOptimizationReport } from "../orchestrator/token-optimizer.ts";
import type { AgentLaunchConfig, Session, Slot } from "../shared/types.ts";

function agent(initial_task: string, overrides: Partial<AgentLaunchConfig> = {}): AgentLaunchConfig {
  return {
    agent_type: "codex",
    name: "Worker",
    role: "Software Engineer",
    role_description: "Implement the assigned task.",
    initial_task,
    ...overrides,
  };
}

describe("local task classifier", () => {
  test("routes a tiny documentation edit to economy", () => {
    expect(classifyTask(agent("Fix a typo in README; one file only.")).tier).toBe("economy");
  });

  test("routes ordinary implementation work to balanced", () => {
    expect(classifyTask(agent("Implement a REST API endpoint with unit tests.")).tier).toBe("balanced");
  });

  test("routes high-risk architecture to expert", () => {
    const result = classifyTask(agent("Design the security architecture for authentication and payment during a production data migration."));
    expect(result.tier).toBe("expert");
    expect(result.recommended_agent_count).toBe(3);
  });

  test("recommends only one agent for a trivial task", () => {
    expect(recommendedTeamSize([agent("Rename a typo in one file; trivial change.")])).toBe(1);
  });

  test("enforced right-sizing keeps an implementer instead of a reviewer", () => {
    const reviewer = agent("Review a trivial rename.", { name: "Reviewer", role: "Code Reviewer" });
    const engineer = agent("Rename a typo in one file; trivial change.", { name: "Engineer" });
    expect(rightSizeTeam([reviewer, engineer], 1).map((item) => item.name)).toEqual(["Engineer"]);
  });
});

describe("model policy resolution", () => {
  test("maps a tier to provider model and effort", () => {
    const policy = resolveModelPolicy(agent("Fix typo in README; one file only."));
    expect(policy.tier).toBe("economy");
    expect(policy.model).toBe("gpt-5.6-luna");
    expect(policy.reasoning_effort).toBe("low");
  });

  test("honors per-agent and per-session overrides", () => {
    const policy = resolveModelPolicy(agent("Implement API tests", {
      model_policy: { tier: "economy", model: "local-small", token_budget: 12_345 },
    }), {
      tiers: { codex: { economy: { reasoning_effort: "medium" } } },
    });
    expect(policy.model).toBe("local-small");
    expect(policy.reasoning_effort).toBe("medium");
    expect(policy.token_budget).toBe(12_345);
  });

  test("escalates one tier at a time and stops at expert", () => {
    const start = resolveModelPolicy(agent("Fix typo in README; one file only."));
    const balanced = escalateModelPolicy(start, "codex");
    const expert = escalateModelPolicy(balanced, "codex");
    expect(balanced.tier).toBe("balanced");
    expect(expert.tier).toBe("expert");
    expect(escalateModelPolicy(expert, "codex").tier).toBe("expert");
    expect(expert.escalation_count).toBe(2);
  });
});

describe("budgets and reporting", () => {
  test("estimates cost only when pricing is configured", () => {
    expect(estimateCostUsd("m", 1_000_000, 500_000, 0)).toBeUndefined();
    expect(estimateCostUsd("m", 1_000_000, 500_000, 0, { m: { input: 1, output: 2 } })).toBe(2);
  });

  test("reports routing decision and budget consumption", () => {
    const policy = resolveModelPolicy(agent("Fix typo in README; one file only."), {}, undefined);
    policy.token_budget = 1_000;
    const session = {
      id: "s", name: "S", project_dir: "/tmp", git_root: null, status: "active",
      pause_reason: null, paused_at: null, config: JSON.stringify({ optimization: { session_token_budget: 5_000 } }),
      created_at: 0, last_active_at: 0,
    } satisfies Session;
    const slot = {
      id: 1, session_id: "s", agent_type: "codex", display_name: "Worker", role: "Engineer",
      role_description: null, role_assigned_by: null, peer_id: null, status: "connected", task_state: "working",
      paused: false, paused_at: null, last_peer_pid: null, last_connected: null, last_disconnected: null,
      context_snapshot: JSON.stringify({ optimization: policy }), input_tokens: 400, output_tokens: 100, cache_read_tokens: 50,
    } satisfies Slot;
    const report = buildOptimizationReport(session, [slot]);
    expect(report.total_tokens).toBe(500);
    expect(report.budget_percent).toBe(10);
    expect(report.agents[0]?.budget_percent).toBe(50);
    expect(report.agents[0]?.tier).toBe("economy");
  });
});
