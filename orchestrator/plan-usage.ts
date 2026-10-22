// ============================================================================
// multiagents — Subscription plan limits (5-hour / weekly / daily windows)
// ============================================================================
// Reads how much of each CLI's subscription quota is used, the way the CLIs'
// own /usage screens do, without starting a model turn:
//   Claude  `get_usage` control request (claude.ai plan windows: 5-hour, weekly,
//           weekly per model), asked of a short-lived `claude -p` process.
//   Codex   `account/rateLimits/read` on a short-lived `codex app-server`
//           (primary = 5-hour window, secondary = weekly).
//   Gemini  Code Assist `retrieveUserQuota` with the Google login Gemini CLI
//           stored (per-model daily buckets). The token is only used while it
//           is valid; Gemini CLI refreshes it whenever it runs.
// Answers are cached; the dashboard asks while its Usage page is open.
// ============================================================================

import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { CodexDriver } from "./codex-driver.ts";
import { log } from "../shared/utils.ts";

const LOG_PREFIX = "plan-usage";

export type PlanProvider = "claude" | "codex" | "gemini";

export interface PlanWindow {
  /** Stable key: five_hour, seven_day, seven_day_opus, daily:<model>… */
  id: string;
  /** English label; the dashboard translates it */
  label: string;
  /** 0–100, null when the CLI did not say */
  usedPercent: number | null;
  /** Epoch ms, null when unknown */
  resetsAt: number | null;
  /** Window length, when known */
  windowMins?: number | null;
  /** Extra text such as "$12.40 of $50" */
  detail?: string;
}

export interface PlanUsage {
  provider: PlanProvider;
  /** True when windows were read */
  ok: boolean;
  plan: string | null;
  windows: PlanWindow[];
  /** Why there is nothing to show (no subscription login, CLI not installed…) */
  note?: string;
  error?: string;
  fetchedAt: number;
}

const CACHE_TTL_MS = 120_000;
const MIN_REFRESH_MS = 15_000;
const cache = new Map<PlanProvider, PlanUsage>();
const inflight = new Map<PlanProvider, Promise<PlanUsage>>();

/** Every provider's plan usage, from cache unless stale (or `refresh`, at most every 15s). */
export async function getPlanUsage(opts: { refresh?: boolean; providers?: PlanProvider[] } = {}): Promise<PlanUsage[]> {
  const providers = opts.providers ?? ["claude", "codex", "gemini"];
  return Promise.all(providers.map((p) => cached(p, opts.refresh === true)));
}

function cached(provider: PlanProvider, refresh: boolean): Promise<PlanUsage> {
  const hit = cache.get(provider);
  const age = hit ? Date.now() - hit.fetchedAt : Infinity;
  if (hit && age < (refresh ? MIN_REFRESH_MS : CACHE_TTL_MS)) return Promise.resolve(hit);
  const running = inflight.get(provider);
  if (running) return running;
  const probe = PROBES[provider]()
    .catch((err): PlanUsage => result(provider, { error: err instanceof Error ? err.message : String(err) }))
    .then((r) => { cache.set(provider, r); return r; })
    .finally(() => inflight.delete(provider));
  inflight.set(provider, probe);
  return probe;
}

/** Forget cached answers (tests). */
export function clearPlanUsageCache(): void { cache.clear(); }

function result(provider: PlanProvider, fields: Partial<PlanUsage>): PlanUsage {
  const windows = fields.windows ?? [];
  return { provider, ok: windows.length > 0, plan: null, windows, fetchedAt: Date.now(), ...fields };
}

function commandOf(envVar: string, fallback: string[]): string[] {
  const override = process.env[envVar]?.trim();
  return override ? override.split(/\s+/) : fallback;
}

/** ISO string or epoch seconds/ms → epoch ms. */
function toMs(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v < 1e12 ? v * 1000 : v;
  if (typeof v === "string" && v) {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

function pct(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.round(v * 10) / 10) : null;
}

const PROBES: Record<PlanProvider, () => Promise<PlanUsage>> = { claude: probeClaude, codex: probeCodex, gemini: probeGemini };

// --- Claude ---

const CLAUDE_WINDOWS: Array<[key: string, label: string]> = [
  ["five_hour", "5-hour window"],
  ["seven_day", "Weekly · all models"],
  ["seven_day_opus", "Weekly · Opus"],
  ["seven_day_sonnet", "Weekly · Sonnet"],
  ["seven_day_oauth_apps", "Weekly · other apps"],
];

/** The `get_usage` answer → windows. */
export function claudeWindows(answer: Record<string, any>): PlanWindow[] {
  const limits = answer?.rate_limits;
  if (!limits || typeof limits !== "object") return [];
  const windows: PlanWindow[] = [];
  for (const [key, label] of CLAUDE_WINDOWS) {
    const w = limits[key];
    if (w && typeof w === "object") windows.push({ id: key, label, usedPercent: pct(w.utilization), resetsAt: toMs(w.resets_at) });
  }
  for (const m of Array.isArray(limits.model_scoped) ? limits.model_scoped : []) {
    if (m?.display_name) windows.push({ id: `model:${m.display_name}`, label: `Weekly · ${m.display_name}`, usedPercent: pct(m.utilization), resetsAt: toMs(m.resets_at) });
  }
  const extra = limits.extra_usage;
  if (extra?.is_enabled) {
    const money = (n: unknown) => (typeof n === "number" ? `${extra.currency && extra.currency !== "USD" ? `${extra.currency} ` : "$"}${n.toFixed(2)}` : "?");
    windows.push({
      id: "extra_usage", label: "Extra usage · monthly", usedPercent: pct(extra.utilization), resetsAt: null,
      detail: extra.monthly_limit != null ? `${money(extra.used_credits)} / ${money(extra.monthly_limit)}` : undefined,
    });
  }
  return windows;
}

async function probeClaude(): Promise<PlanUsage> {
  const command = commandOf("MULTIAGENTS_CLAUDE_COMMAND", ["claude"]);
  if (!Bun.which(command[0]!)) return result("claude", { note: "Claude Code is not installed." });
  // No MCP servers, no hooks, outside any project: the process only answers the control request
  const proc = Bun.spawn([
    ...command, "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
    "--strict-mcp-config", "--mcp-config", JSON.stringify({ mcpServers: {} }),
    "--settings", JSON.stringify({ disableAllHooks: true }),
  ], { cwd: tmpdir(), stdin: "pipe", stdout: "pipe", stderr: "pipe", env: process.env });
  try {
    proc.stdin.write(JSON.stringify({ type: "control_request", request_id: "plan_usage", request: { subtype: "get_usage", skip_behaviors: true } }) + "\n");
    proc.stdin.flush();
    const response = await readJsonLines(proc.stdout, (m) => m.type === "control_response" && m.response?.request_id === "plan_usage", 25_000);
    if (!response) return result("claude", { error: "Claude Code did not answer the usage request." });
    if (response.response.subtype === "error") {
      return result("claude", { note: "This Claude Code version does not report plan usage — update it.", error: String(response.response.error ?? "") });
    }
    const answer = response.response.response ?? {};
    const windows = claudeWindows(answer);
    return result("claude", {
      plan: typeof answer.subscription_type === "string" ? answer.subscription_type : null,
      windows,
      note: windows.length ? undefined : "No claude.ai plan limits for this login (an API key has none).",
    });
  } finally {
    try { proc.stdin.end(); } catch { /* closed */ }
    setTimeout(() => { try { proc.kill(); } catch { /* gone */ } }, 2_000);
  }
}

/** Read newline-delimited JSON until `match` or the timeout; null on timeout/EOF. */
async function readJsonLines(stream: ReadableStream<Uint8Array>, match: (m: any) => boolean, timeoutMs: number): Promise<any | null> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      const chunk = await Promise.race([reader.read(), Bun.sleep(deadline - Date.now()).then(() => null)]);
      if (!chunk || chunk.done) return null;
      buffer += decoder.decode(chunk.value, { stream: true });
      let nl;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        try {
          const msg = JSON.parse(line);
          if (match(msg)) return msg;
        } catch { /* not JSON */ }
      }
    }
    return null;
  } finally {
    reader.releaseLock();
  }
}

// --- Codex ---

function windowLabel(mins: number | null | undefined, fallback: string): string {
  if (mins === 300) return "5-hour window";
  if (mins === 10080) return "Weekly";
  if (mins === 1440) return "Daily";
  if (typeof mins === "number" && mins > 0) return mins % 1440 === 0 ? `${mins / 1440}-day window` : mins % 60 === 0 ? `${mins / 60}-hour window` : `${mins}-minute window`;
  return fallback;
}

/** `account/rateLimits/read` → windows (every metered bucket when the server lists several). */
export function codexWindows(answer: Record<string, any>): PlanWindow[] {
  const buckets: Array<[string, Record<string, any>]> = answer?.rateLimitsByLimitId && typeof answer.rateLimitsByLimitId === "object"
    ? Object.entries(answer.rateLimitsByLimitId)
    : answer?.rateLimits ? [[answer.rateLimits.limitId ?? "codex", answer.rateLimits]] : [];
  const windows: PlanWindow[] = [];
  for (const [limitId, snap] of buckets) {
    const name = snap?.limitName && buckets.length > 1 ? `${snap.limitName} · ` : buckets.length > 1 && limitId !== "codex" ? `${limitId} · ` : "";
    for (const [slot, fallback] of [["primary", "Short window"], ["secondary", "Long window"]] as const) {
      const w = snap?.[slot];
      if (!w || typeof w !== "object") continue;
      windows.push({
        id: `${limitId}:${slot}`, label: `${name}${windowLabel(w.windowDurationMins, fallback)}`,
        usedPercent: pct(w.usedPercent), resetsAt: toMs(w.resetsAt), windowMins: w.windowDurationMins ?? null,
      });
    }
  }
  return windows;
}

async function probeCodex(): Promise<PlanUsage> {
  const command = commandOf("MULTIAGENTS_CODEX_COMMAND", ["codex", "app-server"]);
  if (!Bun.which(command[0]!)) return result("codex", { note: "Codex CLI is not installed." });
  let driver: CodexDriver | null = null;
  try {
    driver = await CodexDriver.spawn(tmpdir(), process.env, { command, timeoutMs: 15_000 });
    const account = await driver.request("account/read", { refreshToken: false }, 15_000)
      .catch(() => driver!.request("account/read", null, 15_000))
      .catch(() => null) as { account?: { planType?: string; type?: string } | null } | null;
    let answer: Record<string, any>;
    try {
      // Older app-servers take no params here ("invalid type: map, expected unit"); null suits every version
      answer = await driver.request("account/rateLimits/read", null, 20_000) as Record<string, any>;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/auth/i.test(msg)) return result("codex", { note: "Sign in to Codex with ChatGPT to see its limits (an API key has none)." });
      throw err;
    }
    const windows = codexWindows(answer);
    return result("codex", {
      plan: account?.account?.planType ?? answer?.rateLimits?.planType ?? null,
      windows,
      note: windows.length ? undefined : "Codex reported no usage windows for this account.",
    });
  } finally {
    await driver?.kill().catch(() => {});
  }
}

// --- Gemini ---

const CODE_ASSIST = "https://cloudcode-pa.googleapis.com/v1internal";

/** `retrieveUserQuota` buckets → windows (Gemini counts requests per model per day). */
export function geminiWindows(answer: Record<string, any>): PlanWindow[] {
  const windows: PlanWindow[] = [];
  for (const b of Array.isArray(answer?.buckets) ? answer.buckets : []) {
    if (!b?.modelId || typeof b.remainingFraction !== "number") continue;
    const remaining = b.remainingAmount !== undefined ? Number.parseInt(String(b.remainingAmount), 10) : NaN;
    const limit = Number.isFinite(remaining) && b.remainingFraction > 0 ? Math.round(remaining / b.remainingFraction) : null;
    windows.push({
      id: `daily:${b.modelId}${b.tokenType ? `:${b.tokenType}` : ""}`,
      label: `Daily · ${b.modelId}`,
      usedPercent: pct((1 - b.remainingFraction) * 100),
      resetsAt: toMs(b.resetTime),
      detail: Number.isFinite(remaining) && limit ? `${remaining} / ${limit} left` : undefined,
    });
  }
  return windows;
}

async function probeGemini(): Promise<PlanUsage> {
  const file = Bun.file(join(process.env.GEMINI_CLI_HOME ?? homedir(), ".gemini", "oauth_creds.json"));
  if (!(await file.exists())) {
    return result("gemini", {
      note: process.env.GEMINI_API_KEY ? "Gemini runs on an API key; Google does not report its quota." : "Sign in to Gemini CLI with Google to see its quota (an Antigravity login is separate): run `npx @google/gemini-cli` once and choose Login with Google.",
    });
  }
  const creds = await file.json().catch(() => null) as { access_token?: string; expiry_date?: number } | null;
  if (!creds?.access_token) return result("gemini", { note: "Sign in to Gemini CLI with Google to see its quota (an Antigravity login is separate): run `npx @google/gemini-cli` once and choose Login with Google." });
  if (typeof creds.expiry_date === "number" && creds.expiry_date < Date.now() + 30_000) {
    return result("gemini", { note: "The Gemini login has expired; it refreshes the next time Gemini CLI runs." });
  }
  const post = async (method: string, body: unknown) => {
    const res = await fetch(`${CODE_ASSIST}:${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${creds.access_token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Gemini ${method}: HTTP ${res.status}`);
    return await res.json() as Record<string, any>;
  };
  const load = await post("loadCodeAssist", {
    cloudaicompanionProject: process.env.GOOGLE_CLOUD_PROJECT || undefined,
    metadata: { ideType: "IDE_UNSPECIFIED", platform: "PLATFORM_UNSPECIFIED", pluginType: "GEMINI" },
  });
  const project = load.cloudaicompanionProject ?? process.env.GOOGLE_CLOUD_PROJECT;
  if (!project) {
    const isAntigravity = Array.isArray(load.ineligibleTiers) && load.ineligibleTiers.some((t: any) => /antigravity/i.test(t.reasonMessage ?? ""));
    const tierName = isAntigravity ? "Antigravity" : (load.currentTier?.name ?? load.allowedTiers?.[0]?.name ?? null);
    return result("gemini", {
      plan: tierName,
      windows: [],
      note: isAntigravity ? "Antigravity subscription: workspace internal auth, no window limits." : "Gemini did not report a Code Assist project for this login.",
    });
  }
  const quota = await post("retrieveUserQuota", { project });
  const windows = geminiWindows(quota);
  log(LOG_PREFIX, `Gemini quota: ${windows.length} bucket(s)`);
  return result("gemini", {
    plan: load.currentTier?.name ?? load.currentTier?.id ?? null,
    windows,
    note: windows.length ? undefined : "Gemini reported no quota buckets for this login.",
  });
}
