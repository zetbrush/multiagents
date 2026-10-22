#!/usr/bin/env bun
// ============================================================================
// multiagents — Orchestrator MCP Server
// ============================================================================
// MCP server for Claude Desktop that provides tools to manage a team of
// headless AI agents. Exposes create_team, status, broadcast, control, etc.
// The tools themselves live in runtime.ts, shared with the web dashboard.
// ============================================================================

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { BrokerClient } from "../shared/broker-client.ts";
import { log } from "../shared/utils.ts";
import { brokerUrl } from "../shared/broker-url.ts";
import { ORCHESTRATOR_TOOLS, callOrchestratorTool, ensureBroker, startBackgroundLoops, shutdownRuntime } from "./runtime.ts";

const LOG_PREFIX = "orchestrator";

// --- MCP Server Setup ---

const server = new Server(
  { name: "multiagents-orch", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: ORCHESTRATOR_TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const { content, isError } = await callOrchestratorTool(name, args ?? {});
  return isError ? { content, isError } : { content };
});

// --- Main ---

async function main(): Promise<void> {
  const brokerClient = new BrokerClient(brokerUrl());

  // Ensure broker is running
  await ensureBroker(brokerClient);

  // Start background loops
  startBackgroundLoops(brokerClient);

  // Connect MCP over stdio
  const transport = new StdioServerTransport();
  await server.connect(transport);

  log(LOG_PREFIX, "Orchestrator MCP server running on stdio");
}

main().catch((err) => {
  console.error(`[orchestrator] Fatal: ${err}`);
  process.exit(1);
});

// --- Graceful shutdown: kill all managed agent processes ---
function shutdownOrchestrator() {
  shutdownRuntime();
  process.exit(0);
}

process.on("SIGINT", shutdownOrchestrator);
process.on("SIGTERM", shutdownOrchestrator);
