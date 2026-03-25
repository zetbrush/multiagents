// ============================================================================
// multiagents — Session Management Commands
// ============================================================================

import { DEFAULT_BROKER_PORT, BROKER_HOSTNAME, SESSION_DIR, SESSION_FILE } from "../shared/constants.ts";
import { BrokerClient } from "../shared/broker-client.ts";
import { getGitRoot, formatTime, timeSince, slugify } from "../shared/utils.ts";
import type { SessionFile } from "../shared/types.ts";
import * as readline from "node:readline";
import * as path from "node:path";
import * as fs from "node:fs";

const BROKER_PORT = parseInt(process.env.MULTIAGENTS_PORT ?? String(DEFAULT_BROKER_PORT), 10);
const BROKER_URL = `http://${BROKER_HOSTNAME}:${BROKER_PORT}`;

function prompt(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`${question}: `, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function readLocalSession(): SessionFile | null {
  try {
    const text = fs.readFileSync(path.resolve(process.cwd(), SESSION_FILE), "utf-8");
    return JSON.parse(text) as SessionFile;
  } catch {
    return null;
  }
}

export async function sessionCommand(args: string[]): Promise<void> {
  const sub = args[0];
  const client = new BrokerClient(BROKER_URL);

  switch (sub) {
    case "create":
      await create(client, args.slice(1).join(" ") || undefined);
      break;
    case "list":
      await list(client);
      break;
    case "resume":
      await resume(client, args[1]);
      break;
    case "pause":
      await pause(client, args[1]);
      break;
    case "archive":
      await archive(client, args[1]);
      break;
    case "delete":
      await deleteSession(client, args[1]);
      break;
    case "export":
      await exportSession(client, args[1]);
      break;
    default:
      console.log(`Usage: multiagents session <create|list|resume|pause|archive|delete|export> [args]`);
      process.exit(1);
  }
}

async function create(client: BrokerClient, name?: string): Promise<void> {
  if (!name) {
    console.error("Usage: multiagents session create <name>");
    process.exit(1);
  }

  const projectDir = process.cwd();
  const gitRoot = await getGitRoot(projectDir);
  const sessionId = slugify(name);

  const session = await client.createSession({
    id: sessionId,
    name,
    project_dir: projectDir,
    git_root: gitRoot,
  });

  // Write local session file
  const sessionDir = path.join(projectDir, SESSION_DIR);
  if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });
  const sessionFile: SessionFile = {
    session_id: session.id,
    created_at: new Date().toISOString(),
    broker_port: BROKER_PORT,
  };
  await Bun.write(path.join(projectDir, SESSION_FILE), JSON.stringify(sessionFile, null, 2));

  console.log(`Session created: ${session.name} (${session.id})`);
  console.log(`Wrote ${SESSION_FILE}`);
}

async function list(client: BrokerClient): Promise<void> {
  const sessions = await client.listSessions();

  if (sessions.length === 0) {
    console.log("No sessions found.");
    return;
  }

  const local = readLocalSession();
  console.log("\n  Sessions:\n");

  for (const s of sessions) {
    const active = local?.session_id === s.id ? " \x1b[36m(current)\x1b[0m" : "";
    const statusColor = s.status === "active" ? "\x1b[32m" : s.status === "paused" ? "\x1b[33m" : "\x1b[90m";
    console.log(`  ${s.id}${active}`);
    console.log(`    Name:    ${s.name}`);
    console.log(`    Status:  ${statusColor}${s.status}\x1b[0m`);
    console.log(`    Dir:     ${s.project_dir}`);
    console.log(`    Active:  ${timeSince(s.last_active_at)}`);
    console.log(`    Created: ${formatTime(s.created_at)}`);

    try {
      const slots = await client.listSlots(s.id);
      const connected = slots.filter((sl) => sl.status === "connected").length;
      console.log(`    Agents:  ${connected}/${slots.length} connected`);
    } catch { /* broker may not support slots yet */ }

    console.log();
  }
}

async function resume(client: BrokerClient, sessionId?: string): Promise<void> {
  const id = sessionId ?? readLocalSession()?.session_id;
  if (!id) {
    console.error("No session specified and no local session found.");
    process.exit(1);
  }

  await client.updateSession({ id, status: "active", pause_reason: null, paused_at: null });
  console.log(`Session "${id}" resumed.`);

  // Check for disconnected slots and offer to relaunch
  try {
    const slots = await client.listSlots(id);
    const disconnected = slots.filter((s) => s.status === "disconnected");
    if (disconnected.length > 0) {
      console.log(`\n${disconnected.length} agent(s) disconnected:`);
      for (const s of disconnected) {
        console.log(`  Slot ${s.id}: ${s.display_name ?? s.agent_type} (${s.agent_type}) - ${s.role ?? "no role"}`);
      }
      const answer = await prompt("\nRelaunch disconnected agents? (y/n)");
      if (answer.toLowerCase() === "y") {
        await relaunchAgents(disconnected, id);
      }
    }
  } catch { /* ok */ }
}

async function relaunchAgents(slots: Array<{ id: number; agent_type: string; display_name: string | null; role: string | null }>, sessionId: string): Promise<void> {
  const platform = process.platform;

  for (const slot of slots) {
    const cmd = slot.agent_type; // claude, codex, gemini
    const envVars = `MULTIAGENTS_SESSION=${sessionId} MULTIAGENTS_ROLE=${slot.role ?? ""} MULTIAGENTS_NAME=${slot.display_name ?? ""}`;
    try {
      if (platform === "darwin") {
        // macOS: open a new Terminal tab with session env vars
        Bun.spawnSync([
          "osascript", "-e",
          `tell application "Terminal" to do script "${envVars} ${cmd}"`,
        ]);
      } else {
        // Linux: try gnome-terminal with session env vars
        Bun.spawn(["gnome-terminal", "--", "env", `MULTIAGENTS_SESSION=${sessionId}`, `MULTIAGENTS_ROLE=${slot.role ?? ""}`, `MULTIAGENTS_NAME=${slot.display_name ?? ""}`, cmd], { stdio: ["ignore", "ignore", "ignore"] });
      }
      console.log(`  Launched ${slot.display_name ?? slot.agent_type} in new terminal`);
    } catch (e) {
      console.error(`  Failed to launch ${slot.agent_type}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

async function pause(client: BrokerClient, sessionId?: string): Promise<void> {
  const id = sessionId ?? readLocalSession()?.session_id;
  if (!id) {
    console.error("No session specified and no local session found.");
    process.exit(1);
  }

  await client.updateSession({
    id,
    status: "paused",
    pause_reason: "Paused via CLI",
    paused_at: Date.now(),
  });

  // Pause all slots
  try {
    const slots = await client.listSlots(id);
    for (const s of slots) {
      await client.updateSlot({ id: s.id, paused: true, paused_at: Date.now() });
    }
  } catch { /* ok */ }

  console.log(`Session "${id}" paused.`);
}

async function archive(client: BrokerClient, sessionId?: string): Promise<void> {
  if (!sessionId) {
    console.error("Usage: multiagents session archive <session-id>");
    process.exit(1);
  }
  await client.updateSession({ id: sessionId, status: "archived" });
  console.log(`Session "${sessionId}" archived.`);
}

async function deleteSession(client: BrokerClient, sessionId?: string): Promise<void> {
  if (!sessionId) {
    console.error("Usage: multiagents session delete <session-id>");
    process.exit(1);
  }

  const answer = await prompt(`Delete session "${sessionId}" and all data? This cannot be undone. (yes/no)`);
  if (answer !== "yes") {
    console.log("Cancelled.");
    return;
  }

  // Archive first (soft delete via broker — actual delete if broker supports it)
  try {
    await client.updateSession({ id: sessionId, status: "archived" });
  } catch { /* ok */ }

  // Clean local session file if it matches
  const local = readLocalSession();
  if (local?.session_id === sessionId) {
    const sessionFilePath = path.resolve(process.cwd(), SESSION_FILE);
    if (fs.existsSync(sessionFilePath)) fs.unlinkSync(sessionFilePath);
  }

  console.log(`Session "${sessionId}" deleted.`);
}

async function exportSession(client: BrokerClient, sessionId?: string): Promise<void> {
  const id = sessionId ?? readLocalSession()?.session_id;
  if (!id) {
    console.error("Usage: multiagents session export <session-id>");
    process.exit(1);
  }

  const session = await client.getSession(id);
  const messages = await client.getMessageLog(id, { limit: 10000 });
  const slots = await client.listSlots(id);

  // Build slot lookup
  const slotMap = new Map(slots.map((s) => [s.id, s]));

  // Format as markdown
  let md = `# Session: ${session.name}\n\n`;
  md += `- **ID:** ${session.id}\n`;
  md += `- **Status:** ${session.status}\n`;
  md += `- **Directory:** ${session.project_dir}\n`;
  md += `- **Created:** ${new Date(session.created_at).toISOString()}\n\n`;

  md += `## Agents\n\n`;
  for (const s of slots) {
    md += `- **Slot ${s.id}:** ${s.display_name ?? "unnamed"} (${s.agent_type}) — ${s.role ?? "no role"}\n`;
  }

  md += `\n## Message Log\n\n`;
  for (const m of messages) {
    const fromSlot = m.from_slot_id !== null ? slotMap.get(m.from_slot_id) : null;
    const fromName = fromSlot?.display_name ?? m.from_id;
    const time = formatTime(m.sent_at);
    md += `**[${time}] ${fromName}** (${m.msg_type}):\n${m.text}\n\n---\n\n`;
  }

  const filename = `session-${id}-export.md`;
  await Bun.write(filename, md);
  console.log(`Exported ${messages.length} messages to ${filename}`);
}
