#!/usr/bin/env bun
// ============================================================================
// multiagents — CLI Command Router
// ============================================================================

import { DEFAULT_BROKER_PORT, BROKER_HOSTNAME } from "../shared/constants.ts";
import { BrokerClient } from "../shared/broker-client.ts";

const BROKER_PORT = parseInt(process.env.MULTIAGENTS_PORT ?? String(DEFAULT_BROKER_PORT), 10);
const BROKER_URL = `http://${BROKER_HOSTNAME}:${BROKER_PORT}`;

const COMMAND_HELP: Record<string, string> = {
  "setup": `multiagents setup

  Interactive setup wizard. Detects installed agent CLIs (Claude Code, Codex, Gemini),
  configures MCP servers, and starts the broker daemon.

  Run this once after installing multiagents.

  Example:
    multiagents setup`,

  "dashboard": `multiagents dashboard [session-id]

  Open the TUI dashboard for monitoring a multi-agent session.
  Shows: agents, messages, guardrails, file locks, plan progress.

  If no session-id is given, auto-detects the most recent active session.

  Keys: 1-5 switch tabs, j/k scroll, q quit, +/- adjust guardrails.

  Examples:
    multiagents dashboard
    multiagents dashboard my-session-abc123`,

  "session": `multiagents session <subcommand>

  Manage multi-agent sessions.

  Subcommands:
    create <name>           Create a new session in the current directory
    list                    List all sessions (active, paused, archived)
    resume [session-id]     Resume a paused session (respawns disconnected agents)
    pause [session-id]      Pause a session (holds messages, agents wait)
    archive <session-id>    Archive a completed session
    delete <session-id>     Permanently delete a session and all data
    export <session-id>     Export session transcript as JSON

  Examples:
    multiagents session create auth-feature
    multiagents session list
    multiagents session resume
    multiagents session pause
    multiagents session export abc123 > transcript.json`,

  "send": `multiagents send <target> <message>

  Send a message to a connected agent by peer ID or slot ID.

  Examples:
    multiagents send cl-a1b2c3d4 "Please check the auth module"
    multiagents send 3 "Your tests are failing on line 42"`,

  "peers": `multiagents peers

  List all currently connected agent instances on this machine.
  Shows: peer ID, PID, agent type, working directory, summary.

  Example:
    multiagents peers`,

  "status": `multiagents status

  Show broker health and connected peers summary.
  Shows: broker URL, session count, peer count, agent details.

  Example:
    multiagents status`,

  "broker": `multiagents broker <start|stop|status>

  Manage the broker daemon (HTTP + SQLite on localhost:7899).

  Subcommands:
    start     Start the broker in the background
    stop      Stop the running broker
    status    Check if broker is running

  The broker auto-starts when needed, so manual management is rarely required.

  Examples:
    multiagents broker start
    multiagents broker status
    multiagents broker stop`,

  "install-mcp": `multiagents install-mcp

  Configure MCP servers for all detected agent CLIs.
  Writes to ~/.claude/.mcp.json (Claude), ~/.codex/config.toml (Codex),
  and ~/.gemini/settings.json (Gemini).

  Example:
    multiagents install-mcp`,
};

function printUsage(topic?: string): void {
  if (topic && COMMAND_HELP[topic]) {
    console.log(COMMAND_HELP[topic]);
    return;
  }

  console.log(`multiagents — Multi-agent orchestration platform

Usage: multiagents <command> [options]

Commands:
  setup                           Interactive setup wizard (run first!)
  dashboard [session-id]          TUI dashboard for monitoring
  session <subcommand>            Manage sessions (create/list/resume/pause/archive/delete/export)
  send <target> <message>         Send message to an agent
  peers                           List connected agents
  status                          Broker health + peers summary
  broker start|stop|status        Manage broker daemon
  install-mcp                     Configure MCP servers
  mcp-server [--agent-type <t>]   Run agent MCP server (internal)
  orchestrator                    Run orchestrator MCP server (internal)
  help [command]                  Show help (optionally for a specific command)

Getting Started:
  1. multiagents setup                    # Configure MCP + detect agents
  2. Restart Claude Code                  # Load multiagents tools
  3. Ask Claude to create a team          # Or use the orchestrator MCP

Quick Examples:
  multiagents setup                       # First-time setup
  multiagents dashboard                   # Monitor active session
  multiagents session list                # See all sessions
  multiagents session resume              # Resume a paused session
  multiagents status                      # Check broker + peers

For detailed help on a command:
  multiagents help <command>              # e.g., multiagents help session`);
}

export async function runCli(args: string[]): Promise<void> {
  const command = args[0];

  switch (command) {
    case "install-mcp": {
      const { installMcp } = await import("./install-mcp.ts");
      await installMcp();
      break;
    }

    case "setup": {
      const { setup } = await import("./setup.ts");
      await setup();
      break;
    }

    case "dashboard": {
      const { dashboard } = await import("./dashboard.ts");
      await dashboard(args[1]);
      break;
    }

    case "session": {
      const { sessionCommand } = await import("./session.ts");
      await sessionCommand(args.slice(1));
      break;
    }

    case "send": {
      const target = args[1];
      const msg = args.slice(2).join(" ");
      if (!target || !msg) {
        console.error("Usage: multiagents send <peer-id|slot-id> <message>");
        process.exit(1);
      }
      const client = new BrokerClient(BROKER_URL);
      const isSlot = /^\d+$/.test(target);
      const result = await client.sendMessage({
        from_id: "cli",
        ...(isSlot ? { to_slot_id: parseInt(target, 10) } : { to_id: target }),
        text: msg,
      });
      if (result.ok) {
        console.log(`Message sent to ${target}`);
      } else {
        console.error(`Failed: ${result.error}`);
        process.exit(1);
      }
      break;
    }

    case "peers": {
      const client = new BrokerClient(BROKER_URL);
      try {
        const peers = await client.listPeers({ scope: "machine", cwd: "/", git_root: null });
        if (peers.length === 0) {
          console.log("No peers registered.");
        } else {
          for (const p of peers) {
            console.log(`  ${p.id}  PID:${p.pid}  [${p.agent_type}]  ${p.cwd}`);
            if (p.summary) console.log(`         ${p.summary}`);
            if (p.tty) console.log(`         TTY: ${p.tty}`);
            console.log(`         Last seen: ${p.last_seen}`);
          }
        }
      } catch {
        console.log("Broker is not running.");
      }
      break;
    }

    case "status": {
      const client = new BrokerClient(BROKER_URL);
      try {
        const alive = await client.isAlive();
        if (!alive) {
          console.log("Broker is not running.");
          break;
        }
        const peers = await client.listPeers({ scope: "machine", cwd: "/", git_root: null });
        const sessions = await client.listSessions();
        console.log(`Broker: running on ${BROKER_URL}`);
        console.log(`Sessions: ${sessions.length} (${sessions.filter(s => s.status === "active").length} active)`);
        console.log(`Peers: ${peers.length} registered`);
        if (peers.length > 0) {
          console.log("\nConnected agents:");
          for (const p of peers) {
            console.log(`  ${p.id}  PID:${p.pid}  [${p.agent_type}]  ${p.cwd}`);
          }
        }
      } catch {
        console.log("Broker is not running.");
      }
      break;
    }

    case "broker": {
      const sub = args[1];
      if (sub === "start") {
        const proc = Bun.spawn(["bun", `${import.meta.dir}/../broker.ts`], {
          stdio: ["ignore", "ignore", "ignore"],
        });
        proc.unref();
        // Wait for broker to come up
        const client = new BrokerClient(BROKER_URL);
        for (let i = 0; i < 30; i++) {
          if (await client.isAlive()) {
            console.log(`Broker started on ${BROKER_URL} (PID ${proc.pid})`);
            return;
          }
          await Bun.sleep(200);
        }
        console.error("Broker failed to start within 6s.");
        process.exit(1);
      } else if (sub === "stop") {
        const proc = Bun.spawnSync(["lsof", "-ti", `:${BROKER_PORT}`]);
        const pids = new TextDecoder().decode(proc.stdout).trim().split("\n").filter(Boolean);
        if (pids.length === 0) {
          console.log("Broker is not running.");
        } else {
          for (const pid of pids) process.kill(parseInt(pid), "SIGTERM");
          console.log("Broker stopped.");
        }
      } else if (sub === "status") {
        const client = new BrokerClient(BROKER_URL);
        const alive = await client.isAlive();
        console.log(alive ? `Broker is running on ${BROKER_URL}` : "Broker is not running.");
      } else {
        console.error("Usage: multiagents broker start|stop|status");
        process.exit(1);
      }
      break;
    }

    case "mcp-server": {
      const typeIdx = args.indexOf("--agent-type");
      const agentType = typeIdx !== -1 ? args[typeIdx + 1] : undefined;
      if (agentType) process.env.AGENT_TYPE = agentType;
      // Forward orchestrator-assigned slot/session info to env vars.
      // These are passed as CLI args because Claude Code doesn't reliably
      // forward parent env vars to MCP server subprocesses.
      const sessionIdx = args.indexOf("--session");
      if (sessionIdx !== -1 && args[sessionIdx + 1]) process.env.MULTIAGENTS_SESSION = args[sessionIdx + 1];
      const slotIdx = args.indexOf("--slot");
      if (slotIdx !== -1 && args[slotIdx + 1]) process.env.MULTIAGENTS_SLOT = args[slotIdx + 1];
      const roleIdx = args.indexOf("--role");
      if (roleIdx !== -1 && args[roleIdx + 1]) process.env.MULTIAGENTS_ROLE = args[roleIdx + 1];
      const nameIdx = args.indexOf("--name");
      if (nameIdx !== -1 && args[nameIdx + 1]) process.env.MULTIAGENTS_NAME = args[nameIdx + 1];
      await import("../server.ts");
      break;
    }

    case "orchestrator": {
      await import("../orchestrator/orchestrator-server.ts");
      break;
    }

    // Legacy aliases from old cli.ts
    case "kill-broker": {
      await runCli(["broker", "stop"]);
      break;
    }

    case "version":
    case "--version":
    case "-v": {
      const pkg = await import("../package.json");
      console.log(pkg.version);
      break;
    }

    case "help":
    case "--help":
    case "-h":
    case undefined: {
      printUsage(args[1]);
      break;
    }

    default:
      console.error(`Unknown command: ${command}`);
      printUsage();
      process.exit(1);
  }
}
