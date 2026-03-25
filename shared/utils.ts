// ============================================================================
// multiagents — Shared Utilities
// ============================================================================

import type { AgentType } from "./types.ts";
import { AGENT_ID_PREFIXES } from "./constants.ts";

/** Generate a prefixed peer ID (e.g., "cl-a1b2c3") */
export function generatePeerId(agentType: AgentType): string {
  const prefix = AGENT_ID_PREFIXES[agentType] ?? "cu";
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let suffix = "";
  for (let i = 0; i < 6; i++) {
    suffix += chars[Math.floor(Math.random() * chars.length)];
  }
  return `${prefix}-${suffix}`;
}

/** Format milliseconds into human-readable duration */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

/** Format "time since" a timestamp */
export function timeSince(isoOrEpoch: string | number): string {
  const then =
    typeof isoOrEpoch === "string"
      ? new Date(isoOrEpoch).getTime()
      : isoOrEpoch;
  const diff = Date.now() - then;
  if (diff < 0) return "just now";
  return `${formatDuration(diff)} ago`;
}

/** Format epoch ms to HH:MM time string */
export function formatTime(epochOrIso: number | string): string {
  const date =
    typeof epochOrIso === "string"
      ? new Date(epochOrIso)
      : new Date(epochOrIso);
  return date.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/** Log to stderr (stdout is reserved for MCP protocol in stdio servers) */
export function log(prefix: string, msg: string): void {
  console.error(`[${prefix}] ${msg}`);
}

/** Safely parse JSON with a fallback */
export function safeJsonParse<T>(str: string | null, fallback: T): T {
  if (!str) return fallback;
  try {
    return JSON.parse(str) as T;
  } catch {
    return fallback;
  }
}

/** Resolve home directory in a path */
export function expandHome(path: string): string {
  if (path.startsWith("~/")) {
    return `${process.env.HOME}${path.slice(1)}`;
  }
  return path;
}

/** Truncate text to max length with ellipsis */
export function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 1) + "…";
}

/** Get git root for a directory */
export async function getGitRoot(cwd: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(["git", "rev-parse", "--show-toplevel"], {
      cwd,
      stdout: "pipe",
      stderr: "ignore",
    });
    const text = await new Response(proc.stdout).text();
    const code = await proc.exited;
    return code === 0 ? text.trim() : null;
  } catch {
    return null;
  }
}

/** Get parent process TTY */
export function getTty(): string | null {
  try {
    const ppid = process.ppid;
    if (!ppid) return null;
    const proc = Bun.spawnSync(["ps", "-o", "tty=", "-p", String(ppid)]);
    const tty = new TextDecoder().decode(proc.stdout).trim();
    return tty && tty !== "?" && tty !== "??" ? tty : null;
  } catch {
    return null;
  }
}

/** Convert a string to a URL-friendly slug */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

// Re-export AGENT_ID_PREFIXES for convenience
export { AGENT_ID_PREFIXES };
