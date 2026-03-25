#!/usr/bin/env bun
/**
 * No-op MCP server — responds to the JSON-RPC initialize handshake instantly,
 * reports zero tools, then stays alive reading stdin until the client disconnects.
 *
 * Used to neutralize unwanted global MCP server entries in Codex config without
 * causing 10s handshake timeouts (like /usr/bin/true does) or deserialization
 * errors (like `echo disabled` does).
 */

const decoder = new TextDecoder();
let buffer = "";

process.stdin.on("data", (chunk: Buffer) => {
  buffer += decoder.decode(chunk, { stream: true });

  // Process complete lines (JSON-RPC uses newline-delimited JSON)
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    try {
      const msg = JSON.parse(trimmed);

      if (msg.method === "initialize") {
        const response = JSON.stringify({
          jsonrpc: "2.0",
          id: msg.id,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            serverInfo: { name: "noop", version: "0.0.0" },
          },
        });
        process.stdout.write(response + "\n");
      } else if (msg.method === "notifications/initialized") {
        // Client acknowledged — nothing to do
      } else if (msg.method === "tools/list") {
        const response = JSON.stringify({
          jsonrpc: "2.0",
          id: msg.id,
          result: { tools: [] },
        });
        process.stdout.write(response + "\n");
      } else if (msg.id !== undefined) {
        // Unknown request — respond with empty result
        const response = JSON.stringify({
          jsonrpc: "2.0",
          id: msg.id,
          result: {},
        });
        process.stdout.write(response + "\n");
      }
    } catch {
      // Not JSON — ignore
    }
  }
});

process.stdin.on("end", () => process.exit(0));
