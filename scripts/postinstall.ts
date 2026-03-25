#!/usr/bin/env bun
/**
 * Post-install script: auto-configures MCP servers for Claude Code.
 * Delegates to the same logic as `multiagents install-mcp`.
 * If it fails, prints fallback instructions — never breaks the install.
 */

try {
  const { installMcpSilent } = await import("../cli/install-mcp.ts");
  await installMcpSilent();
  console.log("[multiagents] Restart Claude Code to pick up the new tools.");
  console.log("[multiagents] If tools don't appear, run: multiagents install-mcp");
} catch (e) {
  console.error(`[multiagents] postinstall warning: ${e instanceof Error ? e.message : String(e)}`);
  console.error("[multiagents] Run 'multiagents install-mcp' to configure manually.");
}
