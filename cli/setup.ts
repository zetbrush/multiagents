// ============================================================================
// multiagents — Setup: detect agents + install MCP globally
// ============================================================================

import { DEFAULT_BROKER_PORT, BROKER_HOSTNAME } from "../shared/constants.ts";
import { BrokerClient } from "../shared/broker-client.ts";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";

const BROKER_PORT = parseInt(process.env.MULTIAGENTS_PORT ?? String(DEFAULT_BROKER_PORT), 10);
const BROKER_URL = `http://${BROKER_HOSTNAME}:${BROKER_PORT}`;

/** Known install locations per agent type. */
const KNOWN_PATHS: Record<string, string[]> = {
  claude: [
    path.join(os.homedir(), ".local", "bin", "claude"),
    path.join(os.homedir(), ".claude", "bin", "claude"),
    "/usr/local/bin/claude",
    "/opt/homebrew/bin/claude",
  ],
  codex: [
    "/usr/local/bin/codex",
    path.join(os.homedir(), ".local", "bin", "codex"),
    path.join(os.homedir(), ".npm-global", "bin", "codex"),
    "/opt/homebrew/bin/codex",
  ],
  gemini: [
    path.join(os.homedir(), ".local", "bin", "gemini"),
    "/usr/local/bin/gemini",
    "/opt/homebrew/bin/gemini",
    path.join(os.homedir(), ".npm-global", "bin", "gemini"),
  ],
};

function detectAgent(name: string): { available: boolean; version?: string; resolvedPath?: string } {
  let agentPath: string | null = null;
  try {
    const which = Bun.spawnSync(["which", name]);
    if (which.exitCode === 0) {
      agentPath = new TextDecoder().decode(which.stdout).trim();
    }
  } catch { /* which failed */ }

  if (!agentPath) {
    for (const p of (KNOWN_PATHS[name] ?? [])) {
      if (fs.existsSync(p)) { agentPath = p; break; }
    }
  }

  if (!agentPath) return { available: false };

  let version: string | undefined;
  try {
    const ver = Bun.spawnSync([agentPath, "--version"], { timeout: 5000 });
    if (ver.exitCode === 0) {
      version = new TextDecoder().decode(ver.stdout).trim().split("\n")[0] || undefined;
    }
  } catch { version = undefined; }

  return { available: true, version, resolvedPath: agentPath };
}

export async function setup(): Promise<void> {
  console.log(`
\x1b[1m\x1b[36m  multiagents setup\x1b[0m
\x1b[90m  Configure MCP + detect agents\x1b[0m
\x1b[90m  ─────────────────────────────────\x1b[0m
`);

  // 1. Detect agents
  console.log("\x1b[1mDetecting installed agents...\x1b[0m\n");
  const agents = [
    { name: "Claude Code", cmd: "claude", info: detectAgent("claude") },
    { name: "Codex CLI", cmd: "codex", info: detectAgent("codex") },
    { name: "Gemini CLI", cmd: "gemini", info: detectAgent("gemini") },
  ];

  for (const a of agents) {
    const icon = a.info.available ? "\x1b[32m✔\x1b[0m" : "\x1b[31m✗\x1b[0m";
    const ver = a.info.version ? ` \x1b[90m(${a.info.version})\x1b[0m` : "";
    console.log(`  ${icon} ${a.name}${ver}`);
  }

  const available = agents.filter(a => a.info.available);
  if (available.length === 0) {
    console.error("\n\x1b[31mNo supported agents found. Install at least one: claude, codex, or gemini.\x1b[0m");
    process.exit(1);
  }

  // 2. Install global MCP config
  console.log("\n\x1b[1mConfiguring MCP servers...\x1b[0m\n");
  const { installMcpSilent } = await import("./install-mcp.ts");
  await installMcpSilent();

  // 3. Start broker
  console.log("\n\x1b[1mStarting broker...\x1b[0m");
  const client = new BrokerClient(BROKER_URL);
  let brokerAlive = await client.isAlive();
  if (!brokerAlive) {
    const brokerBin = findBrokerBinary();
    const proc = Bun.spawn([brokerBin], { stdio: ["ignore", "ignore", "ignore"] });
    proc.unref();
    for (let i = 0; i < 30; i++) {
      if (await client.isAlive()) { brokerAlive = true; break; }
      await Bun.sleep(200);
    }
  }
  if (brokerAlive) {
    console.log(`  \x1b[32m✔\x1b[0m Broker running on ${BROKER_URL}`);
  } else {
    console.log(`  \x1b[33m!\x1b[0m Broker not started — will auto-start when agents connect`);
  }

  // 4. Done
  console.log(`
\x1b[1m\x1b[32mSetup complete!\x1b[0m

\x1b[1mUsage:\x1b[0m
  1. Restart Claude Code to load the multiagents tools.
  2. In Claude Code, ask it to use the multiagents tools.
  3. Or use the orchestrator to create a team:
     \x1b[90mmultiagents create-team --project /path/to/project\x1b[0m

\x1b[1mAvailable commands:\x1b[0m
  \x1b[90mmultiagents dashboard\x1b[0m     Live monitoring
  \x1b[90mmultiagents status\x1b[0m        Broker health + peers
  \x1b[90mmultiagents peers\x1b[0m         List connected agents
  \x1b[90mmultiagents install-mcp\x1b[0m   Reconfigure MCP if needed
`);
}

function findBrokerBinary(): string {
  try {
    const which = Bun.spawnSync(["which", "multiagents-broker"]);
    const found = new TextDecoder().decode(which.stdout).trim();
    if (found) return found;
  } catch { /* ok */ }
  const bun = path.join(os.homedir(), ".bun", "bin", "multiagents-broker");
  if (fs.existsSync(bun)) return bun;
  return "multiagents-broker";
}
