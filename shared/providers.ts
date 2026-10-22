// ============================================================================
// multiagents — OpenAI-compatible API providers ("Other" agents)
// ============================================================================
// DeepSeek, Qwen, Kimi, GLM, OpenRouter, a local Ollama… anything that speaks
// the OpenAI chat-completions API can back an agent. Providers live in
// ~/.multiagents/providers.json (mode 0600) on this machine only; slots
// remember the provider's id, never its key. A key written as $NAME is read
// from that environment variable at call time.
// ============================================================================

import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";

export interface ApiProvider {
  id: string;
  /** Display name: "DeepSeek", "Qwen"… */
  name: string;
  /** Base URL up to (not including) /chat/completions, e.g. https://api.deepseek.com/v1 */
  base_url: string;
  /** The key, or $ENV_NAME to read it from the environment; empty for keyless local servers */
  api_key: string;
  default_model?: string;
  /** Models seen on the provider's /models list (filled by "fetch models") */
  models?: string[];
  /** Extra fields merged into every request body, e.g. {"enable_search": true} for Qwen */
  extra_body?: Record<string, unknown>;
  /** USD per million input / output tokens, for cost and cost limits */
  input_price?: number;
  output_price?: number;
  /** Context window in tokens; older turns are trimmed to stay within it (default 64000) */
  context_tokens?: number;
}

/** What the browser gets: the key masked. */
export type ApiProviderView = Omit<ApiProvider, "api_key"> & { api_key_hint: string; key_from_env: string | null };

function providersFile(): string {
  return process.env.MULTIAGENTS_PROVIDERS_FILE ?? path.join(process.env.HOME ?? homedir(), ".multiagents", "providers.json");
}

export function loadProviders(): ApiProvider[] {
  try {
    const raw = JSON.parse(fs.readFileSync(providersFile(), "utf-8"));
    return Array.isArray(raw) ? raw.filter((p) => p && typeof p.id === "string" && typeof p.base_url === "string") : [];
  } catch {
    return [];
  }
}

function writeProviders(list: ApiProvider[]): void {
  const file = providersFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(list, null, 2), { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { /* best effort on platforms without modes */ }
}

export function getProvider(id: string | null | undefined): ApiProvider | null {
  if (!id) return null;
  return loadProviders().find((p) => p.id === id) ?? null;
}

/** The key to send: a $NAME key is read from the environment. */
export function resolveApiKey(p: ApiProvider): string {
  const m = /^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(p.api_key.trim());
  return m ? process.env[m[1]!] ?? "" : p.api_key.trim();
}

export function maskProvider(p: ApiProvider): ApiProviderView {
  const { api_key, ...rest } = p;
  const env = /^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(api_key.trim())?.[1] ?? null;
  const key = api_key.trim();
  // Long keys show their ends to tell them apart; short ones show nothing of themselves
  const hint = env ? `$${env}` : !key ? "" : key.length >= 16 ? `${key.slice(0, 3)}…${key.slice(-4)}` : "••••";
  return { ...rest, key_from_env: env, api_key_hint: hint };
}

function slugId(name: string, taken: Set<string>): string {
  const base = name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "provider";
  let id = base;
  for (let i = 2; taken.has(id); i++) id = `${base}-${i}`;
  return id;
}

/** Normalise a base URL: no trailing slash, no /chat/completions suffix. */
export function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, "").replace(/\/chat\/completions$/, "");
}

/**
 * Add or update a provider. An update that leaves `api_key` empty keeps the
 * stored key (the browser never sees it to send it back).
 */
export function saveProvider(input: Partial<ApiProvider> & { name: string; base_url: string }): ApiProvider {
  const list = loadProviders();
  const existing = input.id ? list.find((p) => p.id === input.id) : undefined;
  let base: URL;
  try { base = new URL(normalizeBaseUrl(input.base_url)); } catch { throw new Error("The base URL is not a valid URL"); }
  if (base.protocol !== "https:" && base.protocol !== "http:") throw new Error("The base URL must start with http:// or https://");
  const provider: ApiProvider = {
    id: existing?.id ?? slugId(input.name, new Set(list.map((p) => p.id))),
    name: input.name.trim() || "API",
    base_url: normalizeBaseUrl(input.base_url),
    api_key: input.api_key?.trim() ? input.api_key.trim() : existing?.api_key ?? "",
    default_model: input.default_model?.trim() || undefined,
    models: input.models ?? existing?.models,
    extra_body: input.extra_body && Object.keys(input.extra_body).length ? input.extra_body : undefined,
    input_price: positive(input.input_price),
    output_price: positive(input.output_price),
    context_tokens: positive(input.context_tokens),
  };
  writeProviders(existing ? list.map((p) => (p.id === provider.id ? provider : p)) : [...list, provider]);
  return provider;
}

function positive(v: unknown): number | undefined {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : undefined;
}

export function deleteProvider(id: string): boolean {
  const list = loadProviders();
  const next = list.filter((p) => p.id !== id);
  if (next.length === list.length) return false;
  writeProviders(next);
  return true;
}

export function authHeaders(p: ApiProvider): Record<string, string> {
  const key = resolveApiKey(p);
  return key ? { Authorization: `Bearer ${key}` } : {};
}

/** The provider's model list (GET /models), also remembered on the provider. */
export async function fetchProviderModels(p: ApiProvider): Promise<string[]> {
  const res = await fetch(`${p.base_url}/models`, { headers: authHeaders(p), signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`${p.name} /models: HTTP ${res.status}${res.status === 401 ? " (check the API key)" : ""}`);
  const body = await res.json() as { data?: Array<{ id?: string }> };
  const models = (body.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === "string").sort();
  const list = loadProviders();
  writeProviders(list.map((x) => (x.id === p.id ? { ...x, models } : x)));
  return models;
}
