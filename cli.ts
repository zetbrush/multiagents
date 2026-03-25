#!/usr/bin/env bun
// ============================================================================
// multiagents — CLI Entry Point
// ============================================================================
// Routes to the new modular CLI. Maintains backward compatibility with
// the original cli.ts commands (status, peers, send, kill-broker).
// ============================================================================

import { runCli } from "./cli/commands.ts";

const args = process.argv.slice(2);

// Backward compatibility: old cli.ts accepted these directly
// The new router handles them natively, so just pass through.
// "kill-broker" is explicitly aliased in commands.ts.

await runCli(args);
