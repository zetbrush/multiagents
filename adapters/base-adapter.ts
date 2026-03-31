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
} from "../shared/types.ts";
import {
  POLL_INTERVALS,
  HEARTBEAT_INTERVAL,
  BROKER_HOSTNAME,
  DEFAULT_BROKER_PORT,
  BROKER_STARTUP_POLL_MS,
  BROKER_STARTUP_MAX_ATTEMPTS,
  SESSION_FILE,
} from "../shared/constants.ts";
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
          enum: ["claude", "codex", "gemini", "custom", "all"],
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
    description: "Manually poll for new messages from other agents.",
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
];

// ---------------------------------------------------------------------------
// Role-specific best practices injection (from role-practices.ts module)
// ---------------------------------------------------------------------------

import { getRolePractices, getStructuredRolePractices } from "./role-practices.ts";

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

  constructor(agentType: AgentType) {
    this.agentType = agentType;
    this.brokerPort = parseInt(
      process.env.MULTIAGENTS_PORT ?? String(DEFAULT_BROKER_PORT),
      10,
    );
    this.brokerUrl = `http://${BROKER_HOSTNAME}:${this.brokerPort}`;
    this.brokerScript = new URL("../broker.ts", import.meta.url).pathname;
    this.broker = new BrokerClient(this.brokerUrl);
    this.pollInterval = POLL_INTERVALS[agentType] ?? POLL_INTERVALS.custom;

    // Read session file if present
    this.readSessionFile();
  }

  // --- Abstract methods (subclasses MUST implement) ---

  abstract deliverMessage(msg: BufferedMessage): Promise<void>;
  abstract getSystemPrompt(): string;
  abstract getCapabilities(): Record<string, unknown>;

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
        instructions: this.getSystemPrompt() + this.getLifecyclePromptSection(),
      },
    );

    // 3. Register tool handlers (they check this.myId and defer if not registered yet)
    this.registerTools();

    // 4. Start broker registration in the BACKGROUND — don't block on MCP handshake
    const brokerPromise = this.registerWithBroker();

    // 5. Connect MCP over stdio — blocks until parent sends `initialize`
    //    Broker registration runs concurrently with this wait.
    await this.mcp.connect(new StdioServerTransport());
    this.log("MCP connected (handshake complete)");

    // 6. Ensure broker registration completed (it likely already did, but wait to be sure)
    await brokerPromise;

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
    const envSlot = process.env.MULTIAGENTS_SLOT;
    const envRole = process.env.MULTIAGENTS_ROLE;
    const envName = process.env.MULTIAGENTS_NAME;
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
        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    });
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
        from_slot_id: this.mySlot?.id ?? undefined,
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
    try {
      const result = await this.broker.pollMessages(this.myId);
      if (result.messages.length === 0) {
        return this.textResult("No new messages.");
      }
      const formatted: string[] = [];
      for (const msg of result.messages) {
        const enriched = await this.enrichMessage(msg);
        formatted.push(this.formatMessage(enriched));
      }
      return this.textResult(
        `${result.messages.length} new message(s):\n\n${formatted.join("\n\n---\n\n")}`,
      );
    } catch (e) {
      return this.errorResult(
        `Error checking messages: ${e instanceof Error ? e.message : String(e)}`,
      );
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

    return {
      content: [{
        type: "text",
        text: `Task state: ${result.task_state}. Your team has been notified. Stay active — you may receive feedback that requires changes. Do NOT disconnect.`,
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
      return `  ${name} | ${s.agent_type} | ${role} | ${conn}${paused} | task: ${task}${isMe}`;
    });

    const header = `Team Status (${slots.filter(s => s.status === "connected").length}/${slots.length} online):`;
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

  protected async pollLoop(): Promise<void> {
    if (!this.myId) return;

    try {
      const result = await this.broker.pollMessages(this.myId);

      // Fetch peer list once per poll iteration instead of per-message
      let peers: Peer[] | undefined;
      if (result.messages.length > 0) {
        try {
          peers = await this.broker.listPeers({
            scope: "machine",
            cwd: this.myCwd,
            git_root: this.myGitRoot,
          });
        } catch {
          // Non-critical — proceed without peer info
        }
      }

      for (const msg of result.messages) {
        const enriched = await this.enrichMessage(msg, peers);
        await this.deliverMessage(enriched);
        this.log(
          `Delivered message from ${enriched.from_display_name ?? enriched.from_id}: ${msg.text.slice(0, 80)}`,
        );
      }
    } catch (e) {
      this.log(
        `Poll error: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  // --- Message enrichment ---

  protected async enrichMessage(msg: Message, cachedPeers?: Peer[]): Promise<BufferedMessage> {
    const enriched: BufferedMessage = { ...msg };
    try {
      const peers = cachedPeers ?? await this.broker.listPeers({
        scope: "machine",
        cwd: this.myCwd,
        git_root: this.myGitRoot,
      });
      const sender = peers.find((p: Peer) => p.id === msg.from_id);
      if (sender) {
        enriched.from_display_name = (sender as any).display_name ?? null;
        enriched.from_agent_type = sender.agent_type;
        enriched.from_summary = sender.summary || null;
        enriched.from_cwd = sender.cwd;
        enriched.from_role = (sender as any).role ?? null;
      }
    } catch {
      // Non-critical — proceed without sender info
    }
    return enriched;
  }

  // --- Message formatting ---

  formatMessage(msg: BufferedMessage): string {
    const name =
      msg.from_display_name ?? msg.from_id;
    const role = msg.from_role ? ` (${msg.from_role})` : "";

    switch (msg.msg_type) {
      case "chat":
        return `${name}${role}: ${msg.text}`;
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
        return `[${msg.msg_type}] ${name}: ${msg.text}`;
    }
  }

  // --- Lifecycle prompt ---

  protected getLifecyclePromptSection(): string {
    return `

=== AGENT OPERATING SYSTEM ===

You are a team member in a multi-agent session. The system enforces that you CANNOT disconnect until explicitly released. This is non-negotiable and enforced server-side.

--- 1. PLANNING ---

Before writing any code, PLAN:
- For tasks with 3+ steps: outline your approach in a message to the team before starting.
- Write detailed specs for non-trivial work. Ambiguity causes rework.
- If something breaks or your approach fails: STOP. Re-plan. Do not brute-force.
- Update the plan as you learn: call update_plan when items change status.

--- 2. DEPENDENCY RESOLUTION & CLARIFICATION PROTOCOL ---

BEFORE you begin implementation, verify you have everything you need:
- Read the specs/requirements from your teammates carefully. Identify ANY unknowns, ambiguities, missing details, or assumptions.
- For EACH unknown: send a specific question to the relevant teammate via send_message. Do NOT guess or assume.
- WAIT for their response. Check check_messages repeatedly until you get answers.
- If the answer raises new questions, ask follow-up questions. Continue this loop until EVERY unknown is resolved.
- Only begin implementation once you have zero open questions.

This applies in BOTH directions:
- If YOU receive questions from a teammate: respond IMMEDIATELY with clear, specific answers. If you need to research or think, say so and give a timeline.
- If a teammate's answer is unclear: say so and ask them to clarify. Do NOT proceed with ambiguous information.

The pattern is: ASK → RECEIVE → VERIFY → (if unclear) ASK AGAIN → RECEIVE → VERIFY → ... → ALL CLEAR → PROCEED.

--- 3. EXECUTION ---

Work autonomously and decisively:
- Break your task into steps. Complete each fully before moving on.
- Use acquire_file BEFORE editing any shared file. Release when done.
- Prefer simple, clean solutions. Ask yourself: "Is there a simpler way?"
- No TODO comments, no placeholder logic, no "fix later" patterns.
- Match complexity to the task — don't overengineer small changes, don't underengineer critical ones.

--- 4. VERIFICATION BEFORE DONE ---

NEVER call signal_done without proof your work is correct:
- Run the code. Check the output. Test edge cases.
- Compare expected vs actual behavior.
- Check for: missing error handling, untested paths, hardcoded values, security issues.
- Ask yourself: "Would a senior engineer approve this as production-ready?"
- If you cannot verify (no test runner, no simulator), explain what you verified manually.

signal_done summary MUST include: what changed, what was tested, what the results were.

--- 5. FEEDBACK & REVIEW LOOPS ---

When you receive feedback:
- Address EVERY item. Do not skip or defer.
- Trace the root cause — don't patch symptoms.
- Before re-submitting, review ALL prior feedback to ensure you haven't reintroduced old issues.
- Internalize patterns: if you made a mistake, don't repeat it in this session.
- Then call signal_done again with a clear diff of what you fixed.

When you give feedback (reviewers/QA):
- Be specific: file paths, line numbers, reproduction steps, severity.
- Distinguish blocking issues (actionable=true) from suggestions (actionable=false).
- "Looks good" is not feedback. Cite specific files, line numbers, test results, and what you verified.

The review loop is: signal_done → review → feedback (actionable) → fix → signal_done → re-review → ... → approve.
This loop MUST continue until the reviewer/QA explicitly calls approve(). Do NOT assume approval.

--- 6. TEAM AWARENESS (MANDATORY COMMUNICATION CADENCE) ---

You MUST maintain continuous communication. Your teammates are BLOCKED if you go silent.

MANDATORY CADENCE — follow this rhythm without exception:
- AFTER EVERY shell command: call check_messages + set_summary
- AFTER EVERY file write: call check_messages + set_summary
- AFTER EVERY build/test: call check_messages + set_summary with results
- EVERY 2-3 MINUTES minimum: call check_messages even if doing nothing
- When waiting for others: call check_messages + check_team_status every 10 seconds

PROACTIVE BEHAVIOR — do these without being asked:
- If a teammate signals done and your role involves review/QA: START IMMEDIATELY. Do not wait.
- If you see a teammate stuck: message them with specific help via send_message.
- If you finish a plan item: call update_plan to mark it done, then set_summary.
- If your work changes: call set_summary so teammates see the update in real-time.

YOUR TEAMMATES CAN ONLY SEE:
- Your set_summary text (visible in check_team_status)
- Messages you send via send_message
- Your signal_done / submit_feedback / approve calls
They CANNOT see your file writes, shell output, or internal reasoning.
If you don't call these tools, you are INVISIBLE to the team.

--- 7. BUG FIXING ---

When bugs are reported to you:
- Investigate autonomously. Trace logs, read error output, find the root cause.
- Do NOT ask "what should I do?" — you are the expert on your code.
- Fix the root cause, not the symptom.
- Verify the fix resolves the issue AND doesn't break other things.
- Then signal_done with the fix summary.

--- 8. HANDOFF PROTOCOL (role-specific workflows) ---

Software Engineers:
  1. Receive specs/task → read carefully → identify ALL unknowns
  2. Ask Designer/spec-writer via send_message → wait for answer → verify clarity → repeat until ZERO unknowns
  3. Implement with TDD: write failing test → implement → verify → refactor
  4. Run linters, type checkers, full test suite. Fix ALL issues.
  5. signal_done with proof: test output, build log, manual verification results
  6. Receive Code Reviewer feedback → fix ALL [BLOCKING] items → signal_done again
  7. Receive QA bugs → fix → signal_done → QA re-tests
  8. Loop steps 6-7 until BOTH Reviewer AND QA call approve() on you

UI/UX Designers:
  1. Analyze requirements → produce detailed spec with ALL component states
  2. signal_done with the spec deliverable
  3. Answer ALL engineer questions IMMEDIATELY via send_message — they are blocked on you
  4. Review engineer implementation against your spec → provide visual feedback
  5. Done when: engineer matches spec AND QA approves accessibility

Code Reviewers:
  1. Monitor check_team_status — when any engineer reaches "done_pending_review", START IMMEDIATELY
  2. Read ALL changed files + trace cross-file dependencies
  3. Check: security (OWASP Top 10), performance, architecture, code smells, test coverage
  4. submit_feedback with prefixes: [BLOCKING] for must-fix, [SUGGESTION] for nice-to-have
  5. After engineer fixes → RE-REVIEW every prior [BLOCKING] issue + inspect new changes
  6. approve() ONLY when zero [BLOCKING] issues remain
  7. Continue monitoring — QA may find issues requiring engineer re-work and another review round

QA Engineers:
  1. Monitor check_team_status — when any engineer reaches "done_pending_review", START IMMEDIATELY
  2. Design a platform-appropriate test plan (see your ROLE-SPECIFIC PRACTICES for platform details)
  3. Execute ALL tests: happy path + edge cases + error states + platform lifecycle
  4. Use ALL available tools: browser automation for web, emulator for mobile, CLI for commands
  5. submit_feedback(actionable=true) with [P0-P3] severity + file:line + repro steps for each bug
  6. After engineer fixes → RE-TEST every bug + run regression on related features
  7. approve() ONLY when ALL P0/P1 bugs fixed and app works end-to-end on target platform
  8. If you need infrastructure: send_message(to_id="orchestrator", "BLOCKED: Need [what] for [why]")

CRITICAL FOR ALL ROLES:
- Do NOT call signal_done or approve() prematurely.
- The session continues until EVERY team member's work is approved by ALL relevant parties.
- If you are waiting: call check_team_status and check_messages every few seconds. Pick up new work.
- If a teammate is unresponsive after 3+ messages: escalate to orchestrator.

--- 9. ESCALATION TO ORCHESTRATOR ---

When you are BLOCKED by something outside your control:
- Missing infrastructure (emulator, simulator, test database, etc.)
- Need a dependency installed or configured
- Need access/credentials to a service
- A teammate is unresponsive after multiple attempts (3+ messages with no reply)
- Unclear requirements that no teammate can answer

Send a message to the orchestrator: send_message(to_id="orchestrator", message="BLOCKED: [specific description of what you need and why]")
The orchestrator will either resolve it directly or communicate with the user.

--- 10. COMMUNICATION STANDARDS ---

EVERY message and status update must be via MCP tools. Your team sees NOTHING else.

- When starting work: set_summary("Starting: <what>")
- After each step: set_summary("<what you did> → <result>")
- When blocked: send_message to the right person + set_summary("BLOCKED: <what I need>")
- When asked a question: send_message reply within 1 minute
- When done: signal_done with proof (test output, build results, verification)
- When receiving feedback: send_message("Acknowledged, fixing now") → fix → signal_done

NEVER let 1 minute pass without a set_summary or check_messages call.

--- 11. STAYING ACTIVE ---

The system DENIES disconnect attempts until you are released. While waiting:
- Call check_messages every 10 seconds
- Call check_team_status every 30 seconds
- If a teammate needs review: start immediately (submit_feedback or approve)
- If a teammate is blocked on you: respond via send_message immediately
- If truly idle: set_summary("Idle — waiting for <what>. Ready to help with <skills>")
- NEVER go silent. The orchestrator monitors your activity. Silent agents get nudged and may be restarted.

--- 12. COMPLETION CRITERIA (cross-role dependency matrix) ---

The SESSION is NOT complete until ALL of these conditions are met:
- Every Engineer: approved by BOTH Code Reviewer AND QA Engineer
- Every Designer: specs confirmed implementable by Engineer, accessibility verified by QA
- Every Reviewer: has reviewed and approved ALL Engineers
- Every QA: has tested and approved ALL Engineers
- Plan: 100% of items marked "done"

YOUR individual work is not done until:
- Your deliverable is complete and verified (see YOUR COMPLETION CRITERIA in role context)
- You have called signal_done with specific proof of correctness
- ALL relevant teammates have called approve() on you (or you have called approve() on all of them if you are a reviewer/QA)
- You have addressed ALL feedback — zero unresolved items
- Your plan items are marked "done"

If ANY condition is unmet, continue the feedback loop. Do NOT go silent.
When ALL conditions are met, set your summary to "All work approved, ready for release."
`;
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
