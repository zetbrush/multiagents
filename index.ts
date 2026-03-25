/**
 * multiagents
 *
 * Multi-agent orchestration platform for Claude Code, Codex CLI, and Gemini CLI.
 *
 * Entry points:
 *   - server.ts                         — MCP server (one per agent instance)
 *   - broker.ts                         — Shared broker daemon (one per machine)
 *   - orchestrator/orchestrator-server.ts — Orchestrator MCP (for Claude Desktop)
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

export {
  DEFAULT_BROKER_PORT,
  DEFAULT_GUARDRAILS,
  POLL_INTERVALS,
  SESSION_FILE,
} from "./shared/constants.ts";
