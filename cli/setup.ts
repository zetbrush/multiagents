// ============================================================================
// multiagents — Interactive Setup Wizard
// ============================================================================

import { DEFAULT_BROKER_PORT, BROKER_HOSTNAME, SESSION_DIR, SESSION_FILE } from "../shared/constants.ts";
import { BrokerClient } from "../shared/broker-client.ts";
import { expandHome, getGitRoot, slugify } from "../shared/utils.ts";
import type { AgentType, SessionFile } from "../shared/types.ts";
import * as readline from "node:readline";
import * as path from "node:path";
import * as fs from "node:fs";

const BROKER_PORT = parseInt(process.env.MULTIAGENTS_PORT ?? String(DEFAULT_BROKER_PORT), 10);
const BROKER_URL = `http://${BROKER_HOSTNAME}:${BROKER_PORT}`;

// --- Helpers ---

function prompt(question: string, defaultValue?: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const suffix = defaultValue ? ` [${defaultValue}]` : "";
    rl.question(`${question}${suffix}: `, (answer) => {
      rl.close();
      resolve(answer.trim() || defaultValue || "");
    });
  });
}

function detectAgent(name: string): { available: boolean; version?: string } {
  try {
    const which = Bun.spawnSync(["which", name]);
    if (which.exitCode !== 0) return { available: false };

    const ver = Bun.spawnSync([name, "--version"]);
    const version = new TextDecoder().decode(ver.stdout).trim().split("\n")[0];
    return { available: true, version: version || undefined };
  } catch {
    return { available: false };
  }
}

export async function setup(): Promise<void> {
  // 1. Header banner
  console.log(`
\x1b[1m\x1b[36m  multiagents\x1b[0m
\x1b[90m  Interactive Setup Wizard\x1b[0m
\x1b[90m  ─────────────────────────────────\x1b[0m
`);

  // 2. Detect installed agents
  console.log("\x1b[1mDetecting installed agents...\x1b[0m\n");
  const agents: { type: AgentType; name: string; cmd: string; info: ReturnType<typeof detectAgent> }[] = [
    { type: "claude", name: "Claude Code", cmd: "claude", info: detectAgent("claude") },
    { type: "codex", name: "Codex CLI", cmd: "codex", info: detectAgent("codex") },
    { type: "gemini", name: "Gemini CLI", cmd: "gemini", info: detectAgent("gemini") },
  ];

  for (const a of agents) {
    const icon = a.info.available ? "\x1b[32m✔\x1b[0m" : "\x1b[31m✗\x1b[0m";
    const ver = a.info.version ? ` \x1b[90m(${a.info.version})\x1b[0m` : "";
    console.log(`  ${icon} ${a.name}${ver}`);
  }

  const available = agents.filter((a) => a.info.available);
  if (available.length === 0) {
    console.error("\n\x1b[31mNo supported agents found. Install at least one agent CLI first.\x1b[0m");
    process.exit(1);
  }

  // 3. Prompt user to select agents
  console.log("\n\x1b[1mSelect agents to orchestrate:\x1b[0m\n");
  for (let i = 0; i < available.length; i++) {
    console.log(`  ${i + 1}. ${available[i].name} (${available[i].cmd})`);
  }
  console.log(`  a. All available agents`);

  const selection = await prompt("\nEnter numbers separated by commas, or 'a' for all", "a");
  let selected: typeof available;
  if (selection === "a" || selection === "A") {
    selected = available;
  } else {
    const indices = selection.split(",").map((s) => parseInt(s.trim(), 10) - 1);
    selected = indices
      .filter((i) => i >= 0 && i < available.length)
      .map((i) => available[i]);
  }

  if (selected.length === 0) {
    console.error("\n\x1b[31mNo agents selected.\x1b[0m");
    process.exit(1);
  }
  console.log(`\nSelected: ${selected.map((a) => a.name).join(", ")}`);

  // 4. Prompt for working directory
  const projectDir = await prompt("\nProject directory", process.cwd());
  const resolvedDir = path.resolve(expandHome(projectDir));
  if (!fs.existsSync(resolvedDir)) {
    console.error(`\n\x1b[31mDirectory does not exist: ${resolvedDir}\x1b[0m`);
    process.exit(1);
  }

  // 5. Prompt for session name
  const dirName = path.basename(resolvedDir);
  const sessionName = await prompt("Session name", dirName);
  const sessionId = slugify(sessionName);

  // 6. Configure each selected agent's MCP server
  console.log("\n\x1b[1mConfiguring MCP servers...\x1b[0m\n");

  const cliPath = path.resolve(import.meta.dir, "..");

  for (const agent of selected) {
    try {
      switch (agent.type) {
        case "claude":
          await configureClaudeMcp(resolvedDir, cliPath);
          break;
        case "codex":
          await configureCodexMcp(resolvedDir, cliPath);
          break;
        case "gemini":
          await configureGeminiMcp(cliPath);
          break;
      }
      console.log(`  \x1b[32m✔\x1b[0m ${agent.name} MCP configured`);
    } catch (e) {
      console.error(`  \x1b[31m✗\x1b[0m ${agent.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // 7. Start broker
  console.log("\n\x1b[1mStarting broker...\x1b[0m");
  const client = new BrokerClient(BROKER_URL);
  let brokerAlive = await client.isAlive();
  if (!brokerAlive) {
    const proc = Bun.spawn(["bun", path.resolve(cliPath, "broker.ts")], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    proc.unref();
    for (let i = 0; i < 30; i++) {
      if (await client.isAlive()) { brokerAlive = true; break; }
      await Bun.sleep(200);
    }
  }
  if (!brokerAlive) {
    console.error("  \x1b[31m✗\x1b[0m Broker failed to start");
    process.exit(1);
  }
  console.log(`  \x1b[32m✔\x1b[0m Broker running on ${BROKER_URL}`);

  // 8. Create session
  console.log("\n\x1b[1mCreating session...\x1b[0m");
  const gitRoot = await getGitRoot(resolvedDir);
  try {
    await client.createSession({
      id: sessionId,
      name: sessionName,
      project_dir: resolvedDir,
      git_root: gitRoot,
    });
    console.log(`  \x1b[32m✔\x1b[0m Session "${sessionName}" (${sessionId}) created`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("409") || msg.includes("UNIQUE") || msg.includes("already")) {
      console.log(`  \x1b[33m!\x1b[0m Session "${sessionId}" already exists, reusing`);
    } else {
      throw e;
    }
  }

  // 9. Write session.json
  const sessionDir = path.join(resolvedDir, SESSION_DIR);
  if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

  const sessionFile: SessionFile = {
    session_id: sessionId,
    created_at: new Date().toISOString(),
    broker_port: BROKER_PORT,
  };
  await Bun.write(path.join(resolvedDir, SESSION_FILE), JSON.stringify(sessionFile, null, 2));
  console.log(`  \x1b[32m✔\x1b[0m Wrote ${SESSION_FILE}`);

  // 10. Print next steps
  console.log(`
\x1b[1m\x1b[32mSetup complete!\x1b[0m

\x1b[1mNext steps:\x1b[0m
  1. Open your agents in the project directory:
     \x1b[90mcd ${resolvedDir}\x1b[0m
${selected.map((a) => `     \x1b[90m${a.cmd}\x1b[0m`).join("\n")}

  2. Each agent will auto-connect to the session via MCP.

  3. Monitor with the dashboard:
     \x1b[90mmultiagents dashboard\x1b[0m

  4. Or use the orchestrator for automated coordination:
     \x1b[90mmultiagents orchestrator\x1b[0m
`);
}

// --- Agent MCP configuration ---

async function configureClaudeMcp(projectDir: string, cliPath: string): Promise<void> {
  // Write project-level .mcp.json
  const mcpPath = path.join(projectDir, ".mcp.json");
  let config: Record<string, unknown> = {};
  try {
    const existing = await Bun.file(mcpPath).text();
    config = JSON.parse(existing);
  } catch { /* file doesn't exist */ }

  const mcpServers = (config.mcpServers as Record<string, unknown>) ?? {};
  mcpServers["multiagents"] = {
    command: "bun",
    args: [path.resolve(cliPath, "cli.ts"), "mcp-server", "--agent-type", "claude"],
  };
  config.mcpServers = mcpServers;
  await Bun.write(mcpPath, JSON.stringify(config, null, 2));
}

async function configureCodexMcp(projectDir: string, cliPath: string): Promise<void> {
  // Write .codex/config.toml
  const codexDir = path.join(projectDir, ".codex");
  if (!fs.existsSync(codexDir)) fs.mkdirSync(codexDir, { recursive: true });

  const tomlPath = path.join(codexDir, "config.toml");
  let existing = "";
  try { existing = await Bun.file(tomlPath).text(); } catch { /* ok */ }

  // Remove any existing multiagents section
  existing = existing.replace(/\[mcp_servers\.multiagents\][\s\S]*?(?=\n\[|$)/, "").trim();

  const entry = `\n\n[mcp_servers.multiagents]\ncommand = "bun"\nargs = [${JSON.stringify(path.resolve(cliPath, "cli.ts"))}, "mcp-server", "--agent-type", "codex"]\n`;
  await Bun.write(tomlPath, existing + entry);
}

async function configureGeminiMcp(cliPath: string): Promise<void> {
  // Write ~/.gemini/settings.json
  const geminiDir = expandHome("~/.gemini");
  if (!fs.existsSync(geminiDir)) fs.mkdirSync(geminiDir, { recursive: true });

  const settingsPath = path.join(geminiDir, "settings.json");
  let config: Record<string, unknown> = {};
  try {
    const existing = await Bun.file(settingsPath).text();
    config = JSON.parse(existing);
  } catch { /* ok */ }

  const mcpServers = (config.mcpServers as Record<string, unknown>) ?? {};
  mcpServers["multiagents"] = {
    command: "bun",
    args: [path.resolve(cliPath, "cli.ts"), "mcp-server", "--agent-type", "gemini"],
  };
  config.mcpServers = mcpServers;
  await Bun.write(settingsPath, JSON.stringify(config, null, 2));
}
