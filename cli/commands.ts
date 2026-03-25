#!/usr/bin/env bun
// ============================================================================
// multiagents — CLI Command Router
// ============================================================================

import { DEFAULT_BROKER_PORT, BROKER_HOSTNAME } from "../shared/constants.ts";
import { BrokerClient } from "../shared/broker-client.ts";

const BROKER_PORT = parseInt(process.env.MULTIAGENTS_PORT ?? String(DEFAULT_BROKER_PORT), 10);
const BROKER_URL = `http://${BROKER_HOSTNAME}:${BROKER_PORT}`;

function printUsage(): void {
  console.log(`multiagents CLI

Usage:
  multiagents install-mcp                     Configure MCP servers for Claude Code
  multiagents setup                           Interactive setup wizard
  multiagents dashboard [session-id]          TUI dashboard
  multiagents session create <name>           Create a new session
  multiagents session list                    List all sessions
  multiagents session resume [session-id]     Resume a paused session
  multiagents session pause [session-id]      Pause a session
  multiagents session archive <session-id>    Archive a session
  multiagents session delete <session-id>     Delete a session
  multiagents session export <session-id>     Export session transcript
  multiagents send <target> <message>         Send message to peer/slot
  multiagents peers                           List connected peers
  multiagents status                          Broker health + peers summary
  multiagents broker start|stop|status        Manage broker daemon
  multiagents mcp-server [--agent-type <t>]   Run MCP server
  multiagents orchestrator                    Run orchestrator server
  multiagents help                            Show this help`);
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

    case "help":
    case "--help":
    case "-h":
    case undefined: {
      printUsage();
      break;
    }

    default:
      console.error(`Unknown command: ${command}`);
      printUsage();
      process.exit(1);
  }
}
