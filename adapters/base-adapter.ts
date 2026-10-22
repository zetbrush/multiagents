#!/usr/bin/env bun
/**
 * BaseAdapter — Abstract base class for all agent MCP adapters.
 *
 * Extracts ALL shared logic from the original server.ts into a reusable
 * base that Claude, Codex, Gemini, and custom adapters extend.
 *
 * Subclasses override:
 *   - deliverMessage(msg)  — how inbound messages reach the agent
 *   - getSystemPrompt()    — agent-specific MCP instructions
 *   - getCapabilities()    — MCP capability declaration
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { BrokerClient } from "../shared/broker-client.ts";
import type {
  AgentType,
  PeerId,
  Peer,
  Slot,
  BufferedMessage,
  RegisterResponse,
  PollMessagesResponse,
  Message,
  SessionFile,
  SendMessageResult,
  AcquireFileResult,
  FileLock,
  FileOwnership,
  KnowledgeCategory,
} from "../shared/types.ts";
import {
  POLL_INTERVALS,
  HEARTBEAT_INTERVAL,
  BROKER_STARTUP_POLL_MS,
  BROKER_STARTUP_MAX_ATTEMPTS,
  SESSION_FILE,
  HUMAN_SENDER,
  HUMAN_SENDER_LABEL,
} from "../shared/constants.ts";
import { resolveBrokerPort, brokerUrl } from "../shared/broker-url.ts";
import {
  log as sharedLog,
  getGitRoot,
  getTty,
  safeJsonParse,
  formatTime,
  timeSince,
} from "../shared/utils.ts";
import {
  generateSummary,
  getGitBranch,
  getRecentFiles,
} from "../shared/summarize.ts";

// ---------------------------------------------------------------------------
// Tool definitions shared by all adapters
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: "list_peers",
    description:
      "List other agent instances. Returns ID, Name, Type, Role, CWD, Summary, Last seen.",
    inputSchema: {
      type: "object" as const,
      properties: {
        scope: {
          type: "string" as const,
          enum: ["machine", "directory", "repo"],
          description:
            '"machine" = all instances. "directory" = same CWD. "repo" = same git repo.',
        },
        agent_type: {
          type: "string" as const,
          enum: ["claude", "codex", "gemini", "api", "custom", "all"],
          description: "Optional filter by agent type. Defaults to all.",
        },
      },
      required: ["scope"],
    },
  },
  {
    name: "send_message",
    description: "Send a message to another agent instance by peer ID.",
    inputSchema: {
      type: "object" as const,
      properties: {
        to_id: {
          type: "string" as const,
          description: "Target peer ID (from list_peers).",
        },
        message: {
          type: "string" as const,
          description: "The message text to send.",
        },
      },
      required: ["to_id", "message"],
    },
  },
  {
    name: "set_summary",
    description:
      "Set a 1-2 sentence summary of your current work (visible to peers).",
    inputSchema: {
      type: "object" as const,
      properties: {
        summary: {
          type: "string" as const,
          description: "A brief summary of your current work.",
        },
      },
      required: ["summary"],
    },
  },
  {
    name: "check_messages",
    description:
      "Return teammate messages you have not seen yet. New messages are also prepended to every tool result under [PENDING MESSAGES].",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "assign_role",
    description: "Assign a role and description to a peer.",
    inputSchema: {
      type: "object" as const,
      properties: {
        peer_id: { type: "string" as const, description: "Target peer ID." },
        role: { type: "string" as const, description: "Short role label." },
        role_description: {
          type: "string" as const,
          description: "Detailed role description.",
        },
      },
      required: ["peer_id", "role", "role_description"],
    },
  },
  {
    name: "rename_peer",
    description: "Set or change a peer's display name.",
    inputSchema: {
      type: "object" as const,
      properties: {
        peer_id: { type: "string" as const, description: "Target peer ID." },
        display_name: {
          type: "string" as const,
          description: "New display name.",
        },
      },
      required: ["peer_id", "display_name"],
    },
  },
  {
    name: "acquire_file",
    description: "Acquire an exclusive lock on a file for editing.",
    inputSchema: {
      type: "object" as const,
      properties: {
        file_path: {
          type: "string" as const,
          description: "Path to the file to lock.",
        },
        purpose: {
          type: "string" as const,
          description: "Why you need this file.",
        },
      },
      required: ["file_path"],
    },
  },
  {
    name: "release_file",
    description: "Release a file lock you hold.",
    inputSchema: {
      type: "object" as const,
      properties: {
        file_path: {
          type: "string" as const,
          description: "Path to the file to release.",
        },
      },
      required: ["file_path"],
    },
  },
  {
    name: "view_file_locks",
    description: "View all active file locks and ownership assignments.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "get_history",
    description: "Retrieve message history from the session log.",
    inputSchema: {
      type: "object" as const,
      properties: {
        limit: {
          type: "number" as const,
          description: "Max messages to return (default 50).",
        },
        with_peer: {
          type: "string" as const,
          description: "Filter to messages involving this peer ID.",
        },
        since: {
          type: "number" as const,
          description: "Only messages after this epoch ms timestamp.",
        },
      },
    },
  },
  {
    name: "signal_done",
    description:
      "Signal that your current task is complete and ready for review. Do NOT call this prematurely — only when your implementation is truly done. After calling this, stay active and wait for feedback.",
    inputSchema: {
      type: "object" as const,
      properties: {
        summary: {
          type: "string" as const,
          description: "Brief summary of what you accomplished",
        },
      },
      required: ["summary"],
    },
  },
  {
    name: "submit_feedback",
    description:
      "Send review feedback to another agent. Set actionable=true if changes are needed (sends agent back to work), false for informational comments.",
    inputSchema: {
      type: "object" as const,
      properties: {
        target: {
          type: "string" as const,
          description:
            "Name, role, or slot ID of the agent to review",
        },
        feedback: {
          type: "string" as const,
          description:
            "Your feedback — be specific and actionable",
        },
        actionable: {
          type: "boolean" as const,
          description:
            "true if changes are required, false if just informational",
        },
      },
      required: ["target", "feedback", "actionable"],
    },
  },
  {
    name: "approve",
    description:
      "Approve another agent's work. This signals that their implementation meets quality standards. Only call when you are satisfied with the work.",
    inputSchema: {
      type: "object" as const,
      properties: {
        target: {
          type: "string" as const,
          description:
            "Name, role, or slot ID of the agent to approve",
        },
        message: {
          type: "string" as const,
          description: "Optional approval message",
        },
      },
      required: ["target"],
    },
  },
  {
    name: "check_team_status",
    description:
      "See the full team status: every agent's role, connection state, task state, and what they are working on. Use this proactively to know who needs help, who is waiting for review, and who is blocked. Call this regularly.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "get_plan",
    description:
      "Get the session plan with all items, their IDs, statuses, and assignments. Call this to learn which plan items are assigned to you and what their IDs are, so you can update them with update_plan.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "update_plan",
    description:
      "Update a plan item's status (pending, in_progress, done, blocked). Use this to mark your assigned plan items as you complete them. Call with the item ID and new status. Call get_plan first to learn your item IDs.",
    inputSchema: {
      type: "object" as const,
      properties: {
        item_id: {
          type: "number" as const,
          description: "Plan item ID to update",
        },
        status: {
          type: "string" as const,
          enum: ["pending", "in_progress", "done", "blocked"],
          description: "New status for the plan item",
        },
      },
      required: ["item_id", "status"],
    },
  },
  // --- Knowledge Store ---
  {
    name: "store_knowledge",
    description:
      "Store shared knowledge visible to all teammates. Use for architectural decisions, discovered patterns, coding conventions, and project context. Knowledge persists across agent restarts. Query with query_knowledge.",
    inputSchema: {
      type: "object" as const,
      properties: {
        key: {
          type: "string" as const,
          description:
            "Unique key (e.g., 'auth-pattern', 'api-style'). Use lowercase-kebab-case.",
        },
        value: {
          type: "string" as const,
          description:
            "The knowledge content. Be concise — teammates will read this.",
        },
        category: {
          type: "string" as const,
          enum: ["decision", "convention", "discovery", "blocker", "context"],
          description: "Category of knowledge. Default: 'context'.",
        },
      },
      required: ["key", "value"],
    },
  },
  {
    name: "query_knowledge",
    description:
      "Query shared knowledge stored by any teammate. Call on startup to understand decisions already made. Call during work to check if a pattern was already discovered.",
    inputSchema: {
      type: "object" as const,
      properties: {
        category: {
          type: "string" as const,
          enum: ["decision", "convention", "discovery", "blocker", "context"],
          description: "Filter by category. Omit to get all.",
        },
        key: {
          type: "string" as const,
          description: "Get a specific entry by key. Omit to list all.",
        },
      },
    },
  },
  {
    name: "remove_knowledge",
    description:
      "Remove a knowledge entry that is no longer accurate. Only remove entries you created or that are clearly outdated.",
    inputSchema: {
      type: "object" as const,
      properties: {
        key: {
          type: "string" as const,
          description: "Key of the entry to remove.",
        },
      },
      required: ["key"],
    },
  },
];

// ---------------------------------------------------------------------------
// Role-specific best practices injection (from role-practices.ts module)
// ---------------------------------------------------------------------------

import { getStructuredRolePractices } from "./role-practices.ts";
import { SHORT_PROTOCOL } from "./protocol-text.ts";

type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };
type EnrichCache = { peers: Peer[]; slots: Slot[] };

/** How many acked message ids to remember so a stale poll cannot re-deliver them. */
const ACKED_MEMORY = 500;

// ---------------------------------------------------------------------------
// BaseAdapter
// ---------------------------------------------------------------------------

export abstract class BaseAdapter {
  // --- Identity & state ---
  protected myId: PeerId | null = null;
  protected myCwd: string = process.cwd();
  protected myGitRoot: string | null = null;
  protected myTty: string | null = null;
  protected mySlot: Slot | null = null;
  protected sessionId: string | null = null;
  protected sessionFile: SessionFile | null = null;
  protected roleContext: string = "";

  // --- Infrastructure ---
  protected broker: BrokerClient;
  protected mcp!: Server;
  protected pollInterval: number;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  protected readonly agentType: AgentType;
  private readonly brokerPort: number;
  private readonly brokerUrl: string;
  private readonly brokerScript: string;

  // --- Inbound delivery ---
  /** Messages handed to this adapter but not yet surfaced to the model. */
  private pending = new Map<number, BufferedMessage>();
  /** Ids the model has seen — a poll issued before the ack landed must not re-deliver them. */
  private acked = new Set<number>();
  /** Seen ids whose broker ack has not succeeded yet; retried before every poll. */
  private pendingAck = new Set<number>();
  /** The poll in flight; the loop and check_messages share it so one message is never staged twice. */
  private inflightPoll: Promise<BufferedMessage[]> | null = null;
  /** check_messages calls currently waiting on a poll; the loop leaves their messages to them. */
  private checkMessagesWaiting = 0;
  /** Set when an orchestrator driver owns delivery for this agent (no polling, no piggyback). */
  protected driverMode = false;
  /** Subclasses whose host rarely reads instructions inject team context into the first tool result. */
  protected autoStartupOnFirstCall = false;
  private hasRunStartup = false;

  constructor(agentType: AgentType) {
    this.agentType = agentType;
    this.brokerPort = resolveBrokerPort();
    this.brokerUrl = brokerUrl();
    this.brokerScript = new URL("../broker.ts", import.meta.url).pathname;
    this.broker = new BrokerClient(this.brokerUrl);
    this.pollInterval = POLL_INTERVALS[agentType] ?? POLL_INTERVALS.custom;

    // Read session file if present
    this.readSessionFile();
  }

  // --- Abstract methods (subclasses MUST implement) ---

  /** Best-effort out-of-band notification (channel push, inbox file). Delivery is confirmed only by ack. */
  abstract deliverMessage(msg: BufferedMessage): Promise<void>;
  abstract getSystemPrompt(): string;
  abstract getCapabilities(): Record<string, unknown>;

  /** MCP `instructions`. Claude Code truncates at 4096 chars and Codex reads 512, so this stays short. */
  getInstructions(): string {
    return `${this.getSystemPrompt()}\n${SHORT_PROTOCOL}`;
  }

  // --- Main entry point ---

  async start(): Promise<void> {
    // === ARCHITECTURE ===
    // Two things must happen:
    //   A) MCP handshake over stdio (so the parent CLI can call our tools)
    //   B) Broker registration (so teammates can see us and send messages)
    //
    // CRITICAL: These MUST run in parallel. The MCP `connect()` blocks until
    // the parent CLI sends an `initialize` message — which may be delayed
    // while Claude/Codex loads other servers, prepares context, or optimizes
    // startup. If we sequence broker registration AFTER `connect()`, agents
    // that delay `initialize` will never register with the broker, staying
    // "disconnected" permanently in the dashboard.
    //
    // Solution: Start broker registration immediately in the background.
    // Tool handlers already check `this.myId` and defer if not yet registered.

    this.myCwd = process.cwd();

    // Skip broker registration when running inside CodexDriver's `codex app-server`.
    // The driver handles all communication — the internal multiagents-peer adapter
    // would create ghost slots if it registered independently.
    // CRITICAL: Only Codex adapters check the .driver-mode file. The file is
    // shared across the workspace — if Claude's adapter also reads it, Claude
    // agents skip registration and become invisible to the broker.
    const driverModeEnv = process.env.MULTIAGENTS_DRIVER_MODE === "1";
    const driverModeFile = this.agentType === "codex" && (() => {
      try {
        const p = require("node:path").join(process.cwd(), ".multiagents", ".driver-mode");
        return require("node:fs").existsSync(p);
      } catch { return false; }
    })();
    const driverMode = driverModeEnv || driverModeFile;
    this.driverMode = driverMode;

    // 1. Resolve session/slot info eagerly (before any async work)
    const envSession = process.env.MULTIAGENTS_SESSION;
    if (envSession && !this.sessionId) {
      this.sessionId = envSession;
      this.log(`Session from env MULTIAGENTS_SESSION: ${envSession}`);
    }

    // 2. Create MCP Server
    // Merge resources capability — base-adapter registers a ListResources
    // handler (empty list) for all adapters, so the capability MUST be
    // declared or the MCP SDK rejects resources/list requests. Codex and
    // Gemini CLIs send resources/list during init even if not advertised.
    const subclassCapabilities = this.getCapabilities();
    const mergedCapabilities = { resources: {}, ...subclassCapabilities };
    this.mcp = new Server(
      { name: "multiagents-peer", version: "0.2.0" },
      {
        capabilities: mergedCapabilities,
        instructions: this.getInstructions(),
      },
    );

    // 3. Register tool handlers (they check this.myId and defer if not registered yet)
    this.registerTools();

    // 4. Start broker registration in the BACKGROUND — don't block on MCP handshake
    //    In driver mode, still register with broker but as a lightweight peer
    //    so MCP tools (set_summary, check_messages, signal_done) work correctly.
    //    Without registration, this.myId stays null and ALL tool handlers return
    //    "Not registered with broker yet" — making every MCP call a silent no-op.
    const brokerPromise = driverMode ? this.registerDriverModePeer() : this.registerWithBroker();

    // 5. Connect MCP over stdio — blocks until parent sends `initialize`
    //    Broker registration runs concurrently with this wait.
    await this.mcp.connect(new StdioServerTransport());
    this.log("MCP connected (handshake complete)");

    // 6. Ensure broker registration completed (it likely already did, but wait to be sure)
    await brokerPromise;

    if (driverMode) {
      this.log("Driver mode — tools enabled, skipping poll loop and heartbeat (CodexDriver manages communication)");
      return; // Tools are available, poll loop managed by driver
    }

    // === PHASE 3: START BACKGROUND LOOPS ===

    // 7. Start poll loop
    this.startPollLoop();

    // 8. Start heartbeat
    this.startHeartbeat();

    // 10. Cleanup on exit
    const cleanup = async () => {
      if (this.pollTimer) clearInterval(this.pollTimer);
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
      if (this.myId) {
        try {
          const result = await this.broker.unregister(this.myId);
          if (result.denied) {
            // Cannot disconnect yet — task not released
            this.log(`Disconnect denied: ${result.reason}`);
            this.log(`Task state: ${result.task_state}. Staying connected and polling for messages.`);
            // Restart poll loop to keep receiving messages
            this.startPollLoop();
            this.startHeartbeat();
            return; // Do NOT exit
          }
          this.log("Unregistered from broker");
        } catch { /* best effort */ }
      }
      process.exit(0);
    };

    process.on("SIGINT", cleanup);
    process.on("SIGTERM", cleanup);
  }

  // --- Broker registration (runs in parallel with MCP handshake) ---

  /**
   * Register a peer in driver mode (CodexDriver-managed agents).
   * The broker's signal_done, set_summary, etc. require a real peer row
   * in the DB (looked up by peer_id → slot_id). We register normally but
   * pass the existing slot_id so the broker matches the launcher's slot
   * instead of creating a ghost one.
   *
   * Slot discovery priority:
   *   1. MULTIAGENTS_SLOT env var (may be stripped by Codex sandbox)
   *   2. .multiagents/.driver-mode file (JSON with slot_id, session_id)
   *   3. .multiagents/slots/<ppid>.json (per-PID slot file)
   */
  private async registerDriverModePeer(): Promise<void> {
    try {
      await this.ensureBroker();
      this.myGitRoot = await getGitRoot(this.myCwd);

      let slotId: number | undefined;
      let sessionId = this.sessionId;

      // 1. Try env var
      const envSlot = process.env.MULTIAGENTS_SLOT;
      if (envSlot) slotId = parseInt(envSlot, 10);

      // 2. Try driver-mode file (written by launcher with slot/session info)
      if (!slotId) {
        try {
          const driverModePath = require("node:path").join(this.myCwd, ".multiagents", ".driver-mode");
          const raw = require("node:fs").readFileSync(driverModePath, "utf-8");
          const data = JSON.parse(raw);
          if (data.slot_id) slotId = data.slot_id;
          if (data.session_id && !sessionId) {
            sessionId = data.session_id;
            this.sessionId = sessionId;
          }
        } catch { /* file might be plain "1" (old format) or missing */ }
      }

      // 3. Try per-PID slot file
      if (!slotId) {
        try {
          const ppid = process.ppid ?? process.pid;
          const slotFilePath = require("node:path").join(this.myCwd, ".multiagents", "slots", `${ppid}.json`);
          const slotData = JSON.parse(require("node:fs").readFileSync(slotFilePath, "utf-8"));
          if (slotData.slot_id) slotId = slotData.slot_id;
          if (slotData.session_id && !sessionId) {
            sessionId = slotData.session_id;
            this.sessionId = sessionId;
          }
        } catch { /* no per-PID file */ }
      }

      this.log(`Driver mode slot discovery: slot_id=${slotId}, session_id=${sessionId}`);

      const reg = await this.broker.register({
        agent_type: this.agentType,
        pid: process.pid,
        cwd: this.myCwd,
        git_root: this.myGitRoot ?? undefined,
        summary: "(driver-mode MCP adapter)",
        session_id: sessionId ?? undefined,
        slot_id: slotId,
      } as any);

      this.myId = reg.id;
      if (reg.slot) {
        this.mySlot = reg.slot;
        this.log(`Driver mode peer registered: ${this.myId}, slot=${reg.slot.id} (${reg.slot.display_name})`);
      } else if (slotId) {
        // Registration didn't auto-match — fetch and link manually
        const slot = await this.broker.getSlot(slotId);
        if (slot) {
          this.mySlot = slot;
          await this.broker.updateSlot({ id: slotId, peer_id: this.myId });
          this.log(`Driver mode peer registered: ${this.myId}, manually linked to slot=${slot.id}`);
        }
      } else {
        this.log(`Driver mode peer registered: ${this.myId} (no slot match)`);
      }
    } catch (err) {
      this.log(`Driver mode registration failed (tools will have limited function): ${err}`);
    }
  }

  private async registerWithBroker(): Promise<void> {
    // 1. Ensure broker is running
    await this.ensureBroker();

    // 2. Gather context
    this.myGitRoot = await getGitRoot(this.myCwd);
    this.myTty = getTty();

    this.log(`CWD: ${this.myCwd}`);
    this.log(`Git root: ${this.myGitRoot ?? "(none)"}`);
    this.log(`TTY: ${this.myTty ?? "(unknown)"}`);

    // 3. Generate initial summary (non-blocking, 3s timeout)
    let initialSummary = "";
    try {
      const summaryResult = await Promise.race([
        (async () => {
          const branch = await getGitBranch(this.myCwd);
          const recentFiles = await getRecentFiles(this.myCwd);
          return await generateSummary({
            cwd: this.myCwd,
            git_root: this.myGitRoot,
            git_branch: branch,
            recent_files: recentFiles,
          });
        })(),
        new Promise<null>((r) => setTimeout(() => r(null), 3000)),
      ]);
      if (summaryResult) {
        initialSummary = summaryResult;
        this.log(`Auto-summary: ${initialSummary}`);
      }
    } catch (e) {
      this.log(`Auto-summary failed (non-critical): ${e instanceof Error ? e.message : String(e)}`);
    }

    // 4. Build registration body
    const regBody: Record<string, unknown> = {
      pid: process.pid,
      cwd: this.myCwd,
      git_root: this.myGitRoot,
      tty: this.myTty,
      summary: initialSummary,
      agent_type: this.agentType,
    };
    if (this.sessionId) {
      regBody.session_id = this.sessionId;
    }
    if (this.sessionFile) {
      regBody.reconnect = true;
    }
    // Pass orchestrator-assigned slot/role for explicit slot targeting.
    // BOTH slot_id AND session_id are required for the broker to match
    // the pre-created slot (broker.ts handleRegister). The broker also
    // has a fallback to infer session_id from the slot's own record.
    //
    // Sources (in priority order):
    // 1. MULTIAGENTS_SLOT env var (set by orchestrator spawn, may be stripped by sandboxes)
    // 2. Per-slot file: .multiagents/slots/<pid>.json (written by orchestrator for each agent)
    // 3. session.json last_slot_id (fallback, may be overwritten by later agents)
    let envSlot = process.env.MULTIAGENTS_SLOT;
    const envRole = process.env.MULTIAGENTS_ROLE;
    const envName = process.env.MULTIAGENTS_NAME;

    // Fallback: read per-PID slot assignment file. The orchestrator writes
    // .multiagents/slots/<parent-pid>.json with { slot_id, role, name } for
    // each agent. The MCP server's parent PID is the agent CLI (claude/codex).
    if (!envSlot) {
      try {
        const ppid = process.ppid ?? process.pid;
        const slotFilePath = require("node:path").join(process.cwd(), ".multiagents", "slots", `${ppid}.json`);
        const slotData = JSON.parse(require("node:fs").readFileSync(slotFilePath, "utf-8"));
        if (slotData.slot_id) {
          envSlot = String(slotData.slot_id);
          if (slotData.role && !envRole) process.env.MULTIAGENTS_ROLE = slotData.role;
          if (slotData.name && !envName) process.env.MULTIAGENTS_NAME = slotData.name;
          this.log(`Slot info from PID file (ppid=${ppid}): slot=${envSlot}`);
        }
      } catch { /* no per-PID file — ok */ }
    }
    if (envSlot) {
      regBody.slot_id = parseInt(envSlot, 10);
    }
    if (envRole) {
      regBody.role = envRole;
    }
    if (envName) {
      regBody.display_name = envName;
    }

    // 5. Register with broker
    const reg = await this.broker.register(regBody as any);
    this.myId = reg.id;
    this.log(`Registered as peer ${this.myId}`);

    // 6. Handle slot matching
    if (reg.slot) {
      this.mySlot = reg.slot;
      this.log(`Matched to slot ${reg.slot.id} (${reg.slot.display_name ?? "unnamed"})`);
      this.restoreRoleContext(reg.slot);
    } else if ((reg as any).choose_slot) {
      const candidates = (reg as any).choose_slot as { slot_id: number; role: string | null }[];
      const match = envRole
        ? candidates.find((c) => c.role === envRole) ?? candidates[0]
        : candidates[0];
      if (match) {
        this.log(`Auto-selecting slot ${match.slot_id} from ${candidates.length} candidates`);
        try {
          const claimed = await this.broker.updateSlot({
            id: match.slot_id,
            peer_id: reg.id,
            status: "connected",
          });
          if (claimed) {
            this.mySlot = claimed;
            this.restoreRoleContext(claimed);
          }
        } catch (e) {
          this.log(`Failed to claim slot ${match.slot_id}: ${e}`);
        }
      }
    }

    // 7. Deliver recap messages if reconnecting
    if (reg.recap && reg.recap.length > 0) {
      this.log(`Delivering ${reg.recap.length} recap message(s)`);
      for (const msg of reg.recap) {
        const enriched = await this.enrichMessage(msg);
        await this.deliverMessage(enriched);
      }
    }
  }

  // --- Broker lifecycle ---

  private async ensureBroker(): Promise<void> {
    if (await this.broker.isAlive()) {
      this.log("Broker already running");
      return;
    }

    this.log("Starting broker daemon...");
    const proc = Bun.spawn(["bun", this.brokerScript], {
      stdio: ["ignore", "ignore", "inherit"],
    });
    proc.unref();

    for (let i = 0; i < BROKER_STARTUP_MAX_ATTEMPTS; i++) {
      await new Promise((r) => setTimeout(r, BROKER_STARTUP_POLL_MS));
      if (await this.broker.isAlive()) {
        this.log("Broker started");
        return;
      }
    }
    throw new Error("Failed to start broker daemon after 6 seconds");
  }

  // --- Session file ---

  private readSessionFile(): void {
    try {
      // Resolve relative to CWD — the orchestrator writes the file into
      // projectDir/.multiagents/session.json and spawns agents with cwd=projectDir.
      const sessionPath = require("path").resolve(process.cwd(), SESSION_FILE);
      const text = require("fs").readFileSync(sessionPath, "utf-8");
      this.sessionFile = JSON.parse(text) as SessionFile;
      this.sessionId = this.sessionFile.session_id;
      this.log(`Session file found: ${this.sessionId} (from ${sessionPath})`);
    } catch {
      // No session file — standalone mode or env vars will provide session info
    }
  }

  // --- Role context restoration ---

  private restoreRoleContext(slot: Slot): void {
    const parts: string[] = [];
    if (slot.role) {
      parts.push(`Your assigned role: ${slot.role}`);
    }
    if (slot.role_description) {
      parts.push(`Role description: ${slot.role_description}`);
    }
    if (slot.display_name) {
      parts.push(`Your display name: ${slot.display_name}`);
    }
    if (slot.context_snapshot) {
      const ctx = safeJsonParse<Record<string, string>>(
        slot.context_snapshot,
        {},
      );
      if (ctx.last_summary) {
        parts.push(`Previous summary: ${ctx.last_summary}`);
      }
    }

    // Inject structured role-specific practices, tool hints, and completion criteria
    const structured = getStructuredRolePractices(slot.role, slot.role_description);
    if (structured) {
      parts.push("");
      parts.push("--- ROLE-SPECIFIC PRACTICES ---");
      parts.push(structured.practices);
      parts.push("");
      parts.push("--- TOOL DISCOVERY ---");
      parts.push(structured.toolHints);
      parts.push("On startup, examine your available tools and skills. Use the most capable tools for your role.");
      parts.push("If you need a tool that isn't available (emulator, browser, database, etc.), escalate to orchestrator via: send_message(to_id=\"orchestrator\", \"BLOCKED: Need [tool] to [reason]\")");
      parts.push("");
      parts.push("--- YOUR COMPLETION CRITERIA ---");
      parts.push(structured.completionCriteria);
      parts.push("You are NOT done until these criteria are met. Do NOT call signal_done prematurely.");
    }

    if (parts.length > 0) {
      this.roleContext = parts.join("\n");
    }
  }

  // --- Tool registration ---

  protected registerTools(): void {
    this.mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: TOOLS,
    }));

    // Return empty resources list — prevents Codex -32601 errors on startup
    this.mcp.setRequestHandler(ListResourcesRequestSchema, async () => ({
      resources: [],
    }));

    this.mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
      const { name, arguments: args } = req.params;
      const result = await this.dispatchTool(name, args as Record<string, unknown>);
      return this.decorateResult(result);
    });
  }

  private async dispatchTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
      switch (name) {
        case "list_peers":
          return this.handleListPeers(args as any);
        case "send_message":
          return this.handleSendMessage(args as any);
        case "set_summary":
          return this.handleSetSummary(args as any);
        case "check_messages":
          return this.handleCheckMessages();
        case "assign_role":
          return this.handleAssignRole(args as any);
        case "rename_peer":
          return this.handleRenamePeer(args as any);
        case "acquire_file":
          return this.handleAcquireFile(args as any);
        case "release_file":
          return this.handleReleaseFile(args as any);
        case "view_file_locks":
          return this.handleViewFileLocks();
        case "get_history":
          return this.handleGetHistory(args as any);
        case "signal_done":
          return this.handleSignalDone(args as any);
        case "submit_feedback":
          return this.handleSubmitFeedback(args as any);
        case "approve":
          return this.handleApprove(args as any);
        case "check_team_status":
          return this.handleCheckTeamStatus();
        case "get_plan":
          return this.handleGetPlan();
        case "update_plan":
          return this.handleUpdatePlan(args as { item_id: number; status: string });
        case "store_knowledge":
          return this.handleStoreKnowledge(args as { key: string; value: string; category?: string });
        case "query_knowledge":
          return this.handleQueryKnowledge(args as { category?: string; key?: string });
        case "remove_knowledge":
          return this.handleRemoveKnowledge(args as { key: string });
        default:
          throw new Error(`Unknown tool: ${name}`);
      }
  }

  // --- Inbound delivery pipeline ---

  /** Prepend first-call team context and any pending teammate messages, acking what was surfaced. */
  private async decorateResult(result: ToolResult): Promise<ToolResult> {
    const startup = this.autoStartupOnFirstCall ? await this.runAutoStartup() : "";
    const pendingBlock = this.driverMode ? "" : await this.flushPendingBlock();
    if (!startup && !pendingBlock) return result;
    const text = result.content.map((c) => c.text).join("\n");
    return { ...result, content: [{ type: "text", text: startup + pendingBlock + text }] };
  }

  private async flushPendingBlock(): Promise<string> {
    if (this.pending.size === 0) return "";
    const msgs = this.takePending();
    await this.ack(msgs.map((m) => m.id));
    const lines = msgs.map((m) => this.formatMessage(m)).join("\n");
    return `[PENDING MESSAGES]\n${lines}\n[END PENDING MESSAGES]\n\n`;
  }

  private takePending(): BufferedMessage[] {
    const msgs = [...this.pending.values()];
    this.pending.clear();
    return msgs;
  }

  private markSeen(ids: number[]): void {
    for (const id of ids) this.acked.add(id);
    if (this.acked.size > ACKED_MEMORY) {
      for (const id of [...this.acked].slice(0, this.acked.size - ACKED_MEMORY)) this.acked.delete(id);
    }
  }

  /** The model saw these messages: never show them again, and tell the broker (retried until it succeeds). */
  private async ack(ids: number[]): Promise<void> {
    this.markSeen(ids);
    for (const id of ids) this.pendingAck.add(id);
    await this.flushAcks();
  }

  private async flushAcks(): Promise<void> {
    if (this.pendingAck.size === 0) return;
    const ids = [...this.pendingAck];
    try {
      await this.broker.ackMessages(ids);
      for (const id of ids) this.pendingAck.delete(id);
    } catch (e) {
      this.log(`Ack failed for ${ids.length} message(s), will retry: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** Poll once and stage what is new as pending; callers that overlap share the one poll. */
  private stagePending(): Promise<BufferedMessage[]> {
    if (!this.inflightPoll) {
      this.inflightPoll = this.pollAndStage().finally(() => { this.inflightPoll = null; });
    }
    return this.inflightPoll;
  }

  private async pollAndStage(): Promise<BufferedMessage[]> {
    await this.flushAcks();
    // Under a driver the orchestrator injects messages itself; only unclaimed ones
    // may surface here, consumed at poll time so the driver cannot claim them too.
    const result = this.driverMode
      ? await this.broker.pollMessages(this.myId!, { unclaimedOnly: true })
      : await this.broker.pollMessages(this.myId!, { retain: true });
    const fresh = result.messages.filter((m) => !this.pending.has(m.id) && !this.acked.has(m.id));
    if (fresh.length === 0) return [];
    const cache = await this.lookupCache();
    const staged: BufferedMessage[] = [];
    for (const msg of fresh) {
      const enriched = await this.enrichMessage(msg, cache);
      if (this.pending.has(msg.id) || this.acked.has(msg.id)) continue;
      this.pending.set(msg.id, enriched);
      staged.push(enriched);
    }
    return staged;
  }

  /** Team context injected into the first tool result (hosts that do not read MCP instructions). */
  private async runAutoStartup(): Promise<string> {
    if (this.hasRunStartup || this.driverMode) return "";
    this.hasRunStartup = true;

    const parts: string[] = [
      "╔══════════════════════════════════════════════════════════╗",
      "║  AUTO-STARTUP: Team context injected on first tool call ║",
      "╚══════════════════════════════════════════════════════════╝",
      "",
    ];

    try {
      const role = this.mySlot?.role ?? "team member";
      const name = this.mySlot?.display_name ?? "agent";
      await this.broker.setSummary(this.myId!, `${name} (${role}) — starting up, reading team context`);
      parts.push(`✓ set_summary: Registered as ${name} (${role})`);
    } catch (e) {
      parts.push(`✗ set_summary failed: ${e instanceof Error ? e.message : String(e)}`);
    }

    try {
      const teamResult = await this.handleCheckTeamStatus();
      parts.push("", "── TEAM STATUS ──", teamResult.content[0]?.text ?? "");
    } catch { parts.push("✗ check_team_status failed"); }

    try {
      const planResult = await this.handleGetPlan();
      parts.push("", "── YOUR PLAN ──", planResult.content[0]?.text ?? "");
    } catch { parts.push("✗ get_plan failed"); }

    parts.push(
      "",
      "── ACTION REQUIRED ──",
      "Use multiagents-peer MCP tools to communicate:",
      "  → set_summary after every major action",
      "  → check_messages after every shell command",
      "  → send_message to reply to teammates",
      "  → signal_done when finished (with proof)",
      "  → update_plan to mark items in_progress/done",
      "DO NOT go 1+ minute without calling check_messages.",
      "════════════════════════════════════════════════════════════",
      "",
    );

    return parts.join("\n");
  }

  // --- Tool handlers (protected — subclasses can override) ---

  protected async handleListPeers(args: {
    scope: "machine" | "directory" | "repo";
    agent_type?: AgentType | "all";
  }) {
    try {
      const peers = await this.broker.listPeers({
        scope: args.scope,
        cwd: this.myCwd,
        git_root: this.myGitRoot,
        exclude_id: this.myId ?? undefined,
        agent_type: args.agent_type,
        session_id: this.sessionId ?? undefined,
      });

      if (peers.length === 0) {
        return this.textResult(
          `No other agent instances found (scope: ${args.scope}).`,
        );
      }

      const lines = peers.map((p: Peer) => {
        const parts = [`ID: ${p.id}`];
        if ((p as any).display_name) parts.push(`Name: ${(p as any).display_name}`);
        parts.push(`Type: ${p.agent_type}`);
        if ((p as any).role) parts.push(`Role: ${(p as any).role}`);
        parts.push(`CWD: ${p.cwd}`);
        if (p.summary) parts.push(`Summary: ${p.summary}`);
        parts.push(`Last seen: ${timeSince(p.last_seen)}`);
        return parts.join("\n  ");
      });

      return this.textResult(
        `Found ${peers.length} peer(s) (scope: ${args.scope}):\n\n${lines.join("\n\n")}`,
      );
    } catch (e) {
      return this.errorResult(
        `Error listing peers: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  protected async handleSendMessage(args: {
    to_id: string;
    message: string;
  }) {
    if (!this.myId) {
      return this.errorResult("Not registered with broker yet");
    }
    try {
      const result = await this.broker.sendMessage({
        from_id: this.myId,
        to_id: args.to_id,
        text: args.message,
        session_id: this.sessionId ?? undefined,
      });
      if (!result.ok) {
        return this.errorResult(`Failed to send: ${result.error}`);
      }
      let text = `Message sent to peer ${args.to_id}`;
      if (result.warning) text += ` (warning: ${result.warning})`;
      return this.textResult(text);
    } catch (e) {
      return this.errorResult(
        `Error sending message: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  /** Auto-transition slot task_state from "idle" to "working" on first real activity. */
  private async autoTransitionToWorking(): Promise<void> {
    if (!this.mySlot || !this.sessionId) return;
    // Only transition from idle — don't overwrite done_pending_review, addressing_feedback, etc.
    if (this.mySlot.task_state !== "idle") return;
    try {
      this.mySlot = await this.broker.updateSlot({
        id: this.mySlot.id,
        task_state: "working",
      });
    } catch { /* best effort */ }
  }

  protected async handleSetSummary(args: { summary: string }) {
    if (!this.myId) {
      return this.errorResult("Not registered with broker yet");
    }
    try {
      await this.broker.setSummary(this.myId, args.summary);
      // Auto-transition to "working" on first summary update
      await this.autoTransitionToWorking();
      return this.textResult(`Summary updated: "${args.summary}"`);
    } catch (e) {
      return this.errorResult(
        `Error setting summary: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  protected async handleCheckMessages() {
    if (!this.myId) {
      return this.errorResult("Not registered with broker yet");
    }
    this.checkMessagesWaiting++;
    try {
      await this.stagePending();
      if (this.pending.size === 0) {
        return this.textResult("No new messages.");
      }
      const msgs = this.takePending();
      const ids = msgs.map((m) => m.id);
      // Under a driver the poll already consumed them; otherwise they are acked now that this result carries them.
      if (this.driverMode) this.markSeen(ids);
      else await this.ack(ids);
      const formatted = msgs.map((m) => this.formatMessage(m));
      return this.textResult(
        `${msgs.length} new message(s):\n\n${formatted.join("\n\n---\n\n")}`,
      );
    } catch (e) {
      return this.errorResult(
        `Error checking messages: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      this.checkMessagesWaiting--;
    }
  }

  protected async handleAssignRole(args: {
    peer_id: string;
    role: string;
    role_description: string;
  }) {
    if (!this.myId) {
      return this.errorResult("Not registered with broker yet");
    }
    try {
      // Resolve target peer's slot_id so the broker persists the role on the slot,
      // not just as a queued message (review finding #5).
      let slotId: number | undefined;
      if (this.sessionId) {
        const slots = await this.broker.listSlots(this.sessionId);
        const match = slots.find(s => s.peer_id === args.peer_id);
        if (match) slotId = match.id;
      }
      await this.broker.setRole({
        peer_id: args.peer_id,
        assigner_id: this.myId,
        role: args.role,
        role_description: args.role_description,
        slot_id: slotId,
      });
      return this.textResult(
        `Role "${args.role}" assigned to peer ${args.peer_id}.`,
      );
    } catch (e) {
      return this.errorResult(
        `Error assigning role: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  protected async handleRenamePeer(args: {
    peer_id: string;
    display_name: string;
  }) {
    if (!this.myId) {
      return this.errorResult("Not registered with broker yet");
    }
    try {
      // Resolve target peer's slot_id so the broker persists the name on the slot (review finding #5).
      let slotId: number | undefined;
      if (this.sessionId) {
        const slots = await this.broker.listSlots(this.sessionId);
        const match = slots.find(s => s.peer_id === args.peer_id);
        if (match) slotId = match.id;
      }
      await this.broker.renamePeer({
        peer_id: args.peer_id,
        assigner_id: this.myId,
        display_name: args.display_name,
        slot_id: slotId,
      });
      return this.textResult(
        `Peer ${args.peer_id} renamed to "${args.display_name}".`,
      );
    } catch (e) {
      return this.errorResult(
        `Error renaming peer: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  protected async handleAcquireFile(args: {
    file_path: string;
    purpose?: string;
  }) {
    if (!this.myId || !this.sessionId) {
      return this.errorResult("Not registered or no session active");
    }
    try {
      const result = await this.broker.acquireFile({
        session_id: this.sessionId,
        peer_id: this.myId,
        slot_id: this.mySlot?.id ?? 0,
        file_path: args.file_path,
        purpose: args.purpose,
      });
      if (result.status === "acquired" || result.status === "extended") {
        return this.textResult(result.message);
      }
      return this.errorResult(result.message);
    } catch (e) {
      return this.errorResult(
        `Error acquiring file: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  protected async handleReleaseFile(args: { file_path: string }) {
    if (!this.myId || !this.sessionId) {
      return this.errorResult("Not registered or no session active");
    }
    try {
      await this.broker.releaseFile({
        session_id: this.sessionId,
        peer_id: this.myId,
        file_path: args.file_path,
      });
      return this.textResult(`Released lock on ${args.file_path}.`);
    } catch (e) {
      return this.errorResult(
        `Error releasing file: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  protected async handleViewFileLocks() {
    if (!this.sessionId) {
      return this.errorResult("No session active");
    }
    try {
      const [locks, ownership] = await Promise.all([
        this.broker.listFileLocks(this.sessionId),
        this.broker.listFileOwnership(this.sessionId),
      ]);

      const parts: string[] = [];

      if (locks.length === 0) {
        parts.push("No active file locks.");
      } else {
        parts.push(`Active locks (${locks.length}):`);
        for (const lock of locks) {
          parts.push(
            `  ${lock.file_path} — held by slot ${lock.held_by_slot} (${lock.lock_type}) — ${lock.purpose ?? "no purpose"}`,
          );
        }
      }

      if (ownership.length > 0) {
        parts.push(`\nFile ownership (${ownership.length}):`);
        for (const own of ownership) {
          parts.push(
            `  ${own.path_pattern} — slot ${own.slot_id} (assigned by ${own.assigned_by})`,
          );
        }
      }

      return this.textResult(parts.join("\n"));
    } catch (e) {
      return this.errorResult(
        `Error viewing file locks: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  protected async handleGetHistory(args: {
    limit?: number;
    with_peer?: string;
    since?: number;
  }) {
    if (!this.sessionId) {
      return this.errorResult("No session active");
    }
    try {
      const messages = await this.broker.getMessageLog(this.sessionId, {
        limit: args.limit ?? 50,
        since: args.since,
      });

      if (messages.length === 0) {
        return this.textResult("No message history found.");
      }

      const lines = messages.map(
        (m) =>
          `[${formatTime(m.sent_at)}] ${m.from_id} -> ${m.to_id}: ${m.text}`,
      );
      return this.textResult(
        `Message history (${messages.length}):\n\n${lines.join("\n")}`,
      );
    } catch (e) {
      return this.errorResult(
        `Error getting history: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  // --- Lifecycle tool handlers ---

  protected async handleSignalDone(args: { summary: string }): Promise<{ content: Array<{ type: string; text: string }> }> {
    if (!this.sessionId) {
      return { content: [{ type: "text", text: "No active session. Cannot signal done outside a session." }] };
    }
    const result = await this.broker.signalDone({
      peer_id: this.myId!,
      session_id: this.sessionId,
      summary: args.summary,
    });

    // Auto-mark all plan items assigned to this slot as done
    if (this.mySlot?.id) {
      try {
        const plan = await this.broker.getPlan(this.sessionId);
        if (plan?.items) {
          for (const item of plan.items) {
            if (item.assigned_to_slot === this.mySlot.id && item.status !== "done") {
              await this.broker.updatePlanItem({ item_id: item.id, status: "done" });
            }
          }
        }
      } catch {
        // Non-critical — plan tracking is best-effort
      }
    }

    // Immediate self-poll: pick up any instant responses (acks, auto-feedback)
    this.pollLoop().catch(() => {});

    const notified = (result as any).notified_count ?? 0;
    return {
      content: [{
        type: "text",
        text: `Task state: ${result.task_state}. ${notified} teammate(s) notified. Stay active — you may receive feedback that requires changes. Do NOT disconnect.`,
      }],
    };
  }

  protected async handleSubmitFeedback(args: { target: string; feedback: string; actionable: boolean }): Promise<{ content: Array<{ type: string; text: string }> }> {
    if (!this.sessionId) {
      return { content: [{ type: "text", text: "No active session." }] };
    }
    const targetSlot = await this.resolveTargetSlot(args.target);
    if (!targetSlot) {
      return { content: [{ type: "text", text: `Could not find agent "${args.target}". Use list_peers to see available agents.` }] };
    }
    const result = await this.broker.submitFeedback({
      peer_id: this.myId!,
      session_id: this.sessionId,
      target_slot_id: targetSlot.id,
      feedback: args.feedback,
      actionable: args.actionable,
    });
    const action = args.actionable ? "Agent sent back to address feedback." : "Informational feedback sent.";
    // Immediate self-poll to pick up any responses
    this.pollLoop().catch(() => {});
    return {
      content: [{ type: "text", text: `Feedback sent to ${targetSlot.display_name || targetSlot.role || targetSlot.id}. ${action} Task state: ${result.task_state}` }],
    };
  }

  protected async handleApprove(args: { target: string; message?: string }): Promise<{ content: Array<{ type: string; text: string }> }> {
    if (!this.sessionId) {
      return { content: [{ type: "text", text: "No active session." }] };
    }
    const targetSlot = await this.resolveTargetSlot(args.target);
    if (!targetSlot) {
      return { content: [{ type: "text", text: `Could not find agent "${args.target}".` }] };
    }
    const result = await this.broker.approve({
      peer_id: this.myId!,
      session_id: this.sessionId,
      target_slot_id: targetSlot.id,
      message: args.message,
    });
    // Immediate self-poll to pick up any responses
    this.pollLoop().catch(() => {});
    return {
      content: [{ type: "text", text: `Approved ${targetSlot.display_name || targetSlot.role}. Task state: ${result.task_state}` }],
    };
  }

  protected async handleCheckTeamStatus(): Promise<{ content: Array<{ type: string; text: string }> }> {
    if (!this.sessionId) {
      // Fallback: show all peers
      const peers = await this.broker.listPeers({ scope: "machine", cwd: this.myCwd, git_root: this.myGitRoot });
      if (peers.length === 0) return { content: [{ type: "text", text: "No teammates found." }] };
      const lines = peers.map(p =>
        `${p.id} (${p.agent_type}) — ${p.summary || "no summary"}`
      );
      return { content: [{ type: "text", text: `Peers on this machine:\n${lines.join("\n")}` }] };
    }

    const slots = await this.broker.listSlots(this.sessionId);
    if (slots.length === 0) return { content: [{ type: "text", text: "No team members in session." }] };

    const lines = slots.map(s => {
      const name = s.display_name || s.id;
      const role = s.role || "no role";
      const conn = s.status === "connected" ? "ONLINE" : "OFFLINE";
      const task = s.task_state || "idle";
      const paused = (s.paused === true || (s.paused as unknown as number) === 1) ? " [PAUSED]" : "";
      const isMe = s.peer_id === this.myId ? " (you)" : "";
      const id = s.peer_id ? ` | id: ${s.peer_id}` : "";
      return `  ${name} | ${s.agent_type} | ${role} | ${conn}${paused} | task: ${task}${id}${isMe}`;
    });

    const header = `Team Status (${slots.filter(s => s.status === "connected").length}/${slots.length} online) — message a teammate with send_message(to_id=<id>):`;
    const needsReview = slots.filter(s => s.task_state === "done_pending_review");
    const addressingFb = slots.filter(s => s.task_state === "addressing_feedback");
    const approved = slots.filter(s => s.task_state === "approved");
    const idle = slots.filter(s => !s.task_state || s.task_state === "idle");

    let actionItems = "";
    if (needsReview.length > 0) {
      actionItems += `\n\nAWAITING REVIEW: ${needsReview.map(s => s.display_name || s.role || s.id).join(", ")} — if you are a reviewer/QA, start reviewing NOW!`;
    }
    if (addressingFb.length > 0) {
      actionItems += `\nADDRESSING FEEDBACK: ${addressingFb.map(s => s.display_name || s.role || s.id).join(", ")} — be ready to re-review when they signal_done again.`;
    }
    if (approved.length > 0) {
      actionItems += `\nAPPROVED: ${approved.map(s => s.display_name || s.role || s.id).join(", ")} — work accepted, awaiting release.`;
    }
    if (idle.length > 0) {
      const idleOthers = idle.filter(s => s.peer_id !== this.myId);
      if (idleOthers.length > 0) {
        actionItems += `\nIDLE: ${idleOthers.map(s => s.display_name || s.role || s.id).join(", ")} — may need a task or may be waiting for dependencies.`;
      }
    }

    // Check if all OTHER agents are approved (session nearing completion)
    const others = slots.filter(s => s.peer_id !== this.myId);
    const allOthersApproved = others.length > 0 && others.every(s => s.task_state === "approved" || s.task_state === "released");
    if (allOthersApproved) {
      actionItems += `\n\nALL OTHER AGENTS APPROVED. If your work is also complete and approved, the session is ready to finish.`;
    }

    return {
      content: [{ type: "text", text: `${header}\n${lines.join("\n")}${actionItems}` }],
    };
  }

  protected async handleGetPlan() {
    if (!this.sessionId) {
      return { content: [{ type: "text", text: "No active session — no plan available." }] };
    }
    try {
      const result = await this.broker.getPlan(this.sessionId);
      if (!result.plan || result.items.length === 0) {
        return { content: [{ type: "text", text: "No plan defined for this session." }] };
      }

      const mySlotId = this.mySlot?.id;
      const lines = [`Plan: ${result.plan.title} (${result.completion}% complete)\n`];
      for (const item of result.items) {
        const marker = item.status === "done" ? "[x]" : item.status === "in_progress" ? "[~]" : "[ ]";
        const assignee = item.assigned_name ?? "unassigned";
        const isMe = item.assigned_to_slot === mySlotId;
        const youTag = isMe ? " ← YOU" : "";
        lines.push(`  ${marker} #${item.id}: ${item.label} (${assignee})${youTag}`);
      }
      lines.push(`\nTo update: call update_plan with item_id and status ("in_progress" or "done")`);

      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Failed to get plan: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
    }
  }

  protected async handleUpdatePlan(args: { item_id: number; status: string }) {
    if (!this.sessionId) {
      return { content: [{ type: "text", text: "No active session — cannot update plan." }] };
    }
    try {
      const result = await this.broker.updatePlanItem({
        item_id: args.item_id,
        status: args.status,
        session_id: this.sessionId,
      }) as any;

      if (result.plan) {
        return {
          content: [{ type: "text", text: `Plan item #${args.item_id} → ${args.status}. Plan completion: ${result.completion}%` }],
        };
      }
      return { content: [{ type: "text", text: `Plan item #${args.item_id} updated to ${args.status}.` }] };
    } catch (e) {
      return {
        content: [{ type: "text", text: `Failed to update plan: ${e instanceof Error ? e.message : String(e)}` }],
        isError: true,
      };
    }
  }

  // --- Knowledge Store handlers ---

  protected async handleStoreKnowledge(args: { key: string; value: string; category?: string }) {
    if (!this.sessionId) {
      return { content: [{ type: "text" as const, text: "Not in a session — knowledge requires a session." }], isError: true };
    }
    try {
      const validCategories = ["decision", "convention", "discovery", "blocker", "context"];
      const category = validCategories.includes(args.category ?? "") ? args.category as KnowledgeCategory : "context";
      const result = await this.broker.putKnowledge({
        session_id: this.sessionId,
        key: args.key,
        value: args.value,
        category,
        slot_id: this.mySlot?.id ?? undefined,
        slot_name: this.mySlot?.display_name ?? undefined,
      });
      const verb = result.action === "created" ? "Stored" : "Updated";
      return { content: [{ type: "text" as const, text: `${verb} knowledge: "${args.key}" [${result.entry.category}]` }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: `Failed to store knowledge: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
    }
  }

  protected async handleQueryKnowledge(args: { category?: string; key?: string }) {
    if (!this.sessionId) {
      return { content: [{ type: "text" as const, text: "Not in a session — knowledge requires a session." }], isError: true };
    }
    try {
      if (args.key) {
        const entry = await this.broker.getKnowledge(this.sessionId, args.key);
        if (!entry || "error" in entry) {
          return { content: [{ type: "text" as const, text: `No knowledge entry found for key "${args.key}".` }] };
        }
        const by = entry.created_by_name ? ` (by ${entry.created_by_name})` : "";
        return { content: [{ type: "text" as const, text: `[${entry.category}] ${entry.key}${by}:\n${entry.value}` }] };
      }

      const entries = await this.broker.listKnowledge(this.sessionId, args.category as KnowledgeCategory | undefined);
      if (!entries.length) {
        return { content: [{ type: "text" as const, text: "No knowledge entries found. You can add entries with store_knowledge." }] };
      }

      const lines = entries.map((e) => {
        const by = e.created_by_name ? ` (by ${e.created_by_name})` : "";
        return `[${e.category}] ${e.key}${by}: ${e.value}`;
      });
      return { content: [{ type: "text" as const, text: `Shared knowledge (${entries.length} entries):\n\n${lines.join("\n\n")}` }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: `Failed to query knowledge: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
    }
  }

  protected async handleRemoveKnowledge(args: { key: string }) {
    if (!this.sessionId) {
      return { content: [{ type: "text" as const, text: "Not in a session — knowledge requires a session." }], isError: true };
    }
    try {
      await this.broker.deleteKnowledge(this.sessionId, args.key);
      return { content: [{ type: "text" as const, text: `Removed knowledge entry "${args.key}".` }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: `Failed to remove knowledge: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
    }
  }

  private async resolveTargetSlot(target: string): Promise<Slot | null> {
    if (!this.sessionId) return null;
    const slots = await this.broker.listSlots(this.sessionId);
    // Try exact name match
    let match = slots.find(s => s.display_name?.toLowerCase() === target.toLowerCase());
    if (match) return match;
    // Try role match
    match = slots.find(s => s.role?.toLowerCase() === target.toLowerCase());
    if (match) return match;
    // Try slot ID
    match = slots.find(s => String(s.id) === target);
    if (match) return match;
    // Try fuzzy
    match = slots.find(s =>
      s.display_name?.toLowerCase().includes(target.toLowerCase()) ||
      s.role?.toLowerCase().includes(target.toLowerCase())
    );
    return match ?? null;
  }

  // --- Poll / heartbeat lifecycle ---

  private startPollLoop(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = setInterval(() => this.pollLoop(), this.pollInterval);
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(async () => {
      if (this.myId) {
        try {
          await this.broker.heartbeat(this.myId);
        } catch {
          // Non-critical
        }
      }
    }, HEARTBEAT_INTERVAL);
  }

  // --- Poll loop ---

  /**
   * Pick up new messages, remember them as pending (they are surfaced in the
   * next tool result) and notify the host out-of-band once per message.
   */
  protected async pollLoop(): Promise<void> {
    if (!this.myId || this.driverMode) return;

    try {
      const staged = await this.stagePending();
      // A check_messages call waiting on the same poll returns them itself.
      if (this.checkMessagesWaiting > 0) return;
      for (const msg of staged) {
        if (!this.pending.has(msg.id)) continue;
        try {
          await this.deliverMessage(msg);
        } catch (e) {
          this.log(`Out-of-band delivery failed (message stays pending): ${e instanceof Error ? e.message : String(e)}`);
        }
        this.log(
          `Received message from ${msg.from_display_name ?? msg.from_id}: ${msg.text.slice(0, 80)}`,
        );
      }
    } catch (e) {
      this.log(
        `Poll error: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  // --- Message enrichment ---

  private async lookupCache(): Promise<EnrichCache> {
    const [peers, slots] = await Promise.all([
      this.broker.listPeers({ scope: "machine", cwd: this.myCwd, git_root: this.myGitRoot }).catch(() => [] as Peer[]),
      this.sessionId ? this.broker.listSlots(this.sessionId).catch(() => [] as Slot[]) : Promise.resolve([] as Slot[]),
    ]);
    return { peers, slots };
  }

  /** Names and roles live on slots; peers only carry agent type, summary and cwd. */
  protected async enrichMessage(msg: Message, cache?: EnrichCache): Promise<BufferedMessage> {
    const enriched: BufferedMessage = { ...msg };
    try {
      const c = cache ?? await this.lookupCache();
      const slot = msg.from_slot_id !== null ? c.slots.find((s) => s.id === msg.from_slot_id) : undefined;
      if (slot) {
        enriched.from_display_name = slot.display_name;
        enriched.from_role = slot.role;
        enriched.from_agent_type = slot.agent_type;
      }
      const sender = c.peers.find((p) => p.id === msg.from_id);
      if (sender) {
        enriched.from_agent_type = enriched.from_agent_type ?? sender.agent_type;
        enriched.from_summary = sender.summary || null;
        enriched.from_cwd = sender.cwd;
      }
    } catch {
      // Non-critical — proceed without sender info
    }
    return enriched;
  }

  // --- Message formatting ---

  /** Sender name, role and (when known by name) the peer id to reply to. */
  formatMessage(msg: BufferedMessage): string {
    const name =
      msg.from_display_name ?? msg.from_id;
    const role = msg.from_role ? ` (${msg.from_role})` : "";
    const isOrchestrator = msg.from_id === "orchestrator" || msg.from_id === "__orchestrator__";
    const idTag = msg.from_display_name && !isOrchestrator ? ` [id ${msg.from_id}]` : "";
    const sender = msg.from_id === HUMAN_SENDER ? HUMAN_SENDER_LABEL : `${name}${role}${idTag}`;

    switch (msg.msg_type) {
      case "chat":
        return `${sender}: ${msg.text}`;
      case "role_assignment":
        return `ROLE ASSIGNED: ${msg.text}`;
      case "rename":
        return `You have been named: ${msg.text}`;
      case "broadcast":
        return `BROADCAST: ${msg.text}`;
      case "team_change":
        return `TEAM CHANGE: ${msg.text}`;
      case "control":
        return msg.text;
      case "system":
        return msg.text;
      default:
        return `[${msg.msg_type}] ${sender}: ${msg.text}`;
    }
  }

  // --- Helpers ---

  protected log(msg: string): void {
    sharedLog(`multiagents`, msg);
  }

  protected textResult(text: string) {
    return {
      content: [{ type: "text" as const, text }],
    };
  }

  protected errorResult(text: string) {
    return {
      content: [{ type: "text" as const, text }],
      isError: true,
    };
  }
}
