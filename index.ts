/**
 * multiagents
 *
 * Multi-agent orchestration platform for Claude Code, Codex CLI, and Antigravity CLI.
 *
 * Entry points:
 *   - server.ts                         — MCP server (one per agent instance)
 *   - broker.ts                         — Shared broker daemon (one per machine)
 *   - orchestrator/orchestrator-server.ts — Switchable orchestrator MCP
 *   - cli.ts                            — CLI tool (setup, dashboard, session mgmt)
 *
 * See README.md for setup and usage.
 */

export type {
  PeerId,
  AgentType,
  MessageType,
  SessionStatus,
  Peer,
  Message,
  Session,
  Slot,
  FileLock,
  FileOwnership,
  Guardrail,
  GuardrailState,
  BufferedMessage,
  SessionFile,
  AgentLaunchConfig,
  TeamConfig,
} from "./shared/types.ts";

export { BrokerClient } from "./shared/broker-client.ts";
export type { OrchestratorHost } from "./shared/orchestrator-host.ts";
export { readOrchestratorHost, writeOrchestratorHost } from "./shared/orchestrator-host.ts";

export {
  DEFAULT_BROKER_PORT,
  DEFAULT_GUARDRAILS,
  POLL_INTERVALS,
  SESSION_FILE,
} from "./shared/constants.ts";
