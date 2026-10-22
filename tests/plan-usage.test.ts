/**
 * Subscription plan limits: parsing each CLI's answer, and the probes against
 * the fake Claude / Codex CLIs.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { claudeWindows, codexWindows, geminiWindows, getPlanUsage, clearPlanUsageCache } from "../orchestrator/plan-usage.ts";

const FAKE_CLAUDE = new URL("./fakes/fake-claude.ts", import.meta.url).pathname;
const FAKE_CODEX = new URL("./fakes/fake-codex-app-server.ts", import.meta.url).pathname;

describe("plan usage parsing", () => {
  test("Claude: 5-hour, weekly and per-model windows; null windows are skipped", () => {
    const w = claudeWindows({
      rate_limits: {
        five_hour: { utilization: 42.25, resets_at: "2030-01-01T05:00:00Z" },
        seven_day: { utilization: 18, resets_at: "2030-01-06T00:00:00Z" },
        seven_day_sonnet: null,
        model_scoped: [{ display_name: "Fable", utilization: 3, resets_at: null }],
        extra_usage: { is_enabled: true, monthly_limit: 50, used_credits: 12.4, utilization: 24.8, currency: "USD" },
      },
    });
    expect(w.map((x) => x.id)).toEqual(["five_hour", "seven_day", "model:Fable", "extra_usage"]);
    expect(w[0]).toMatchObject({ label: "5-hour window", usedPercent: 42.3, resetsAt: Date.parse("2030-01-01T05:00:00Z") });
    expect(w[3]!.detail).toBe("$12.40 / $50.00");
    expect(claudeWindows({ rate_limits: null })).toEqual([]);
  });

  test("Codex: primary is the 5-hour window, secondary the weekly one", () => {
    const w = codexWindows({ rateLimits: {
      primary: { usedPercent: 63, windowDurationMins: 300, resetsAt: 1893474000 },
      secondary: { usedPercent: 21, windowDurationMins: 10080, resetsAt: null },
    } });
    expect(w.map((x) => [x.label, x.usedPercent])).toEqual([["5-hour window", 63], ["Weekly", 21]]);
    expect(w[0]!.resetsAt).toBe(1893474000 * 1000);
  });

  test("Gemini: daily buckets per model, used = 1 − remaining fraction", () => {
    const w = geminiWindows({ buckets: [
      { modelId: "gemini-2.5-pro", remainingFraction: 0.75, remainingAmount: "75", resetTime: "2030-01-02T00:00:00Z" },
      { modelId: "gemini-2.5-flash", remainingFraction: 1 },
      { remainingFraction: 0.5 },
    ] });
    expect(w).toHaveLength(2);
    expect(w[0]).toMatchObject({ label: "Daily · gemini-2.5-pro", usedPercent: 25, detail: "75 / 100 left" });
    expect(w[1]!.usedPercent).toBe(0);
  });
});

describe("plan usage probes", () => {
  const saved = { ...process.env };
  let home: string;
  beforeEach(() => {
    clearPlanUsageCache();
    home = fs.mkdtempSync(path.join(os.tmpdir(), "ma-plan-"));
    process.env.MULTIAGENTS_CLAUDE_COMMAND = `bun ${FAKE_CLAUDE}`;
    process.env.MULTIAGENTS_CODEX_COMMAND = `bun ${FAKE_CODEX}`;
    process.env.GEMINI_CLI_HOME = home;
    delete process.env.GEMINI_API_KEY;
  });
  afterEach(() => {
    process.env = { ...saved };
    fs.rmSync(home, { recursive: true, force: true });
  });

  test("reads Claude's and Codex's windows from the CLIs", async () => {
    const [claude, codex] = await getPlanUsage({ providers: ["claude", "codex"] });
    expect(claude).toMatchObject({ provider: "claude", ok: true, plan: "max" });
    expect(claude!.windows.map((w) => w.id)).toEqual(["five_hour", "seven_day", "seven_day_opus"]);
    expect(codex).toMatchObject({ provider: "codex", ok: true, plan: "plus" });
    expect(codex!.windows.map((w) => w.usedPercent)).toEqual([63, 21]);
  }, 30_000);

  test("explains a login without plan limits", async () => {
    process.env.FAKE_CLAUDE_USAGE = "none";
    process.env.FAKE_CODEX_LOGGED_OUT = "1";
    const [claude, codex, gemini] = await getPlanUsage();
    expect(claude).toMatchObject({ ok: false, windows: [] });
    expect(claude!.note).toContain("API key");
    expect(codex!.note).toContain("Sign in to Codex");
    expect(gemini!.note).toContain("Sign in to Gemini");
  }, 30_000);

  test("answers from cache until refreshed", async () => {
    const [first] = await getPlanUsage({ providers: ["claude"] });
    const [second] = await getPlanUsage({ providers: ["claude"] });
    expect(second!.fetchedAt).toBe(first!.fetchedAt);
  }, 30_000);

  test("a missing CLI is reported, not thrown", async () => {
    process.env.MULTIAGENTS_CLAUDE_COMMAND = "definitely-not-a-claude-binary";
    const [claude] = await getPlanUsage({ providers: ["claude"] });
    expect(claude).toMatchObject({ ok: false, note: "Claude Code is not installed." });
  });
});
