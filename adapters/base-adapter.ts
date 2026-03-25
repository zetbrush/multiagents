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
// Role-specific best practices injection
// ---------------------------------------------------------------------------

interface RolePattern {
  /** Keywords that match this role (checked against role name + description, case-insensitive) */
  keywords: string[];
  /** Best practices injected when role matches */
  practices: string;
}

const ROLE_PRACTICES: RolePattern[] = [
  {
    keywords: ["android", "kotlin", "jetpack", "compose"],
    practices: `ANDROID ENGINEERING:
- Use Kotlin with Jetpack Compose for UI. Follow MVVM architecture.
- Structure: feature-first modules. Each feature has ui/, data/, domain/ layers.
- Use StateFlow for state management. Avoid LiveData in new code.
- Build with Gradle. Ensure build.gradle.kts has correct compileSdk, minSdk, targetSdk.
- Test on Android Emulator: use "emulator" or "adb" commands to verify the app runs.
- Check logcat for crashes: "adb logcat *:E" to filter errors.
- Before signaling done: build succeeds (./gradlew assembleDebug), no lint errors, app launches on emulator.`,
  },
  {
    keywords: ["ios", "swift", "swiftui", "xcode", "uikit"],
    practices: `iOS ENGINEERING:
- Use Swift with SwiftUI for new UI. Follow MVVM or TCA architecture.
- Project structure: feature folders, each with Views/, ViewModels/, Models/.
- Use async/await for concurrency. Avoid callback-based patterns in new code.
- Build with xcodebuild or swift build. Ensure .xcodeproj or Package.swift is valid.
- Test on iOS Simulator: use "xcrun simctl" to boot simulator, install, and launch.
- Check for crashes: "xcrun simctl spawn booted log stream --level error".
- Before signaling done: build succeeds, no warnings treated as errors, app launches on simulator.`,
  },
  {
    keywords: ["react", "frontend", "web", "nextjs", "next.js", "typescript", "javascript", "vue", "angular", "svelte"],
    practices: `WEB/FRONTEND ENGINEERING:
- Use TypeScript strictly. No "any" types unless absolutely necessary.
- Follow the framework's conventions: file-based routing, server/client component boundaries.
- CSS: use the project's existing approach (Tailwind, CSS modules, styled-components).
- Accessibility: semantic HTML, ARIA labels, keyboard navigation, proper heading hierarchy.
- Performance: lazy load heavy components, optimize images, minimize client-side JS.
- Test in browser: start dev server, verify all routes render, check console for errors.
- Before signaling done: dev server runs without errors, no console warnings, responsive on mobile viewports.`,
  },
  {
    keywords: ["backend", "api", "server", "microservice", "database", "python", "go", "rust", "java", "node"],
    practices: `BACKEND ENGINEERING:
- Follow RESTful conventions or the project's existing API pattern (GraphQL, gRPC, etc.).
- Validate all inputs at system boundaries. Never trust client data.
- Error handling: return proper HTTP status codes, structured error responses.
- Database: use migrations, parameterized queries (never string concatenation), proper indexing.
- Security: no secrets in code, use environment variables, sanitize user input.
- Before signaling done: server starts, all endpoints respond correctly, no unhandled exceptions in logs.`,
  },
  {
    keywords: ["qa", "tester", "test", "quality", "testing"],
    practices: `QA / TESTING:
- Your job is to FIND BUGS, not confirm things work. Be adversarial.
- Test categories: functional correctness, edge cases, error handling, UI/UX, performance, security.
- For mobile apps: test on actual emulators/simulators, not just code review.
  - Android: use "adb" to install APK, run the app, test user flows.
  - iOS: use "xcrun simctl" to install and run on simulator.
  - Web: open in browser, test responsive layouts, check console for errors.
- Bug reports must include: file:line (if code-level), reproduction steps, expected vs actual, severity.
- Severity levels: P0 (crash/data loss), P1 (major feature broken), P2 (minor issue), P3 (cosmetic).
- Re-test EVERY fix. Don't assume fixes are correct — verify them.
- Before approving: all P0/P1 issues resolved, app runs end-to-end on target platform without crashes.`,
  },
  {
    keywords: ["reviewer", "review", "code review"],
    practices: `CODE REVIEW:
- Review for: correctness, security, performance, readability, maintainability, test coverage.
- Check architecture: does this follow the project's patterns? Is it consistent with existing code?
- Security checklist: input validation, SQL injection, XSS, auth/authz, secrets exposure, dependency vulnerabilities.
- Performance: unnecessary re-renders, N+1 queries, missing indexes, large bundle imports.
- Provide actionable feedback with file paths and line numbers. Not "this could be better" but "this should use X because Y".
- Distinguish blocking issues (must fix) from suggestions (nice to have).
- Before approving: no security issues, no architectural violations, code is production-ready.`,
  },
  {
    keywords: ["designer", "design", "ui/ux", "ux", "figma", "spec"],
    practices: `DESIGN / UI SPECIFICATION:
- Produce a clear, implementable design specification — not vague descriptions.
- Spec must include: component hierarchy, layout (dimensions, spacing), colors (hex/tokens), typography (font, size, weight), states (default, hover, active, disabled, error, loading, empty).
- For each screen/component: describe the visual layout, user interactions, transitions/animations.
- Platform-specific considerations:
  - Android: Material Design 3 guidelines, system back gesture, dynamic color.
  - iOS: Human Interface Guidelines, safe areas, Dynamic Type, SF Symbols.
  - Web: responsive breakpoints (mobile/tablet/desktop), accessibility, keyboard navigation.
- Deliver the spec as a structured document (Markdown) that engineers can implement from directly.
- Before signaling done: every screen has a spec, every interaction is described, edge cases covered (empty state, error state, loading state).`,
  },
  {
    keywords: ["architect", "lead", "team lead", "tech lead", "principal"],
    practices: `ARCHITECTURE / TEAM LEAD:
- Your primary job is COORDINATION and QUALITY, not implementation.
- Define the plan: break the project into tasks, assign to team members, set dependencies.
- Resolve conflicts: if two agents disagree or block each other, make the decision.
- Quality gate: review the overall integration — do all parts work together?
- Communication: keep the team aligned. Broadcast requirement changes immediately.
- When releasing agents: verify ALL work is integrated, tested, and production-grade.
- You decide when the team is done. Don't release prematurely.`,
  },
  {
    keywords: ["devops", "infrastructure", "ci/cd", "deploy", "cloud"],
    practices: `DEVOPS / INFRASTRUCTURE:
- Infrastructure as code: use declarative configs (Terraform, CloudFormation, Docker Compose).
- CI/CD: ensure builds are reproducible. Pin dependency versions. Cache aggressively.
- Security: no secrets in repos, use secret managers, principle of least privilege.
- Monitoring: set up health checks, log aggregation, alerting.
- Before signaling done: pipeline runs green, deployment succeeds, health checks pass.`,
  },
];

/**
 * Match a role name + description against known patterns and return
 * applicable best practices. Multiple patterns can match (e.g., "Android QA").
 */
function getRolePractices(role?: string | null, roleDescription?: string | null): string | null {
  if (!role && !roleDescription) return null;

  const haystack = `${role ?? ""} ${roleDescription ?? ""}`.toLowerCase();
  const matched: string[] = [];

  for (const pattern of ROLE_PRACTICES) {
    if (pattern.keywords.some(kw => haystack.includes(kw))) {
      matched.push(pattern.practices);
    }
  }

  return matched.length > 0 ? matched.join("\n\n") : null;
}

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
    // === PHASE 1: MCP HANDSHAKE (must complete FAST) ===
    // The MCP client (Claude/Codex/Gemini) connects to us over stdio and
    // sends an initialize request. If we don't respond quickly, the client
    // times out (Codex: 10s). So we create the MCP server, register tools,
    // and connect FIRST — before any network calls to the broker.

    this.myCwd = process.cwd();

    // 1. Create MCP Server immediately
    this.mcp = new Server(
      { name: "multiagents", version: "0.2.0" },
      {
        capabilities: this.getCapabilities(),
        instructions: this.getSystemPrompt() + this.getLifecyclePromptSection(),
      },
    );

    // 2. Register tools (all tool handlers check this.myId and defer if not registered yet)
    this.registerTools();

    // 3. Connect MCP over stdio — this completes the handshake with the client
    await this.mcp.connect(new StdioServerTransport());
    this.log("MCP connected (handshake complete)");

    // === PHASE 2: BROKER REGISTRATION (can take time, client is already connected) ===

    // 4. Ensure broker is running
    await this.ensureBroker();

    // 5. Gather context
    this.myGitRoot = await getGitRoot(this.myCwd);
    this.myTty = getTty();

    this.log(`CWD: ${this.myCwd}`);
    this.log(`Git root: ${this.myGitRoot ?? "(none)"}`);
    this.log(`TTY: ${this.myTty ?? "(unknown)"}`);

    // 6. Generate initial summary (non-blocking, 3s timeout)
    let initialSummary = "";
    const summaryPromise = (async () => {
      try {
        const branch = await getGitBranch(this.myCwd);
        const recentFiles = await getRecentFiles(this.myCwd);
        const summary = await generateSummary({
          cwd: this.myCwd,
          git_root: this.myGitRoot,
          git_branch: branch,
          recent_files: recentFiles,
        });
        if (summary) {
          initialSummary = summary;
          this.log(`Auto-summary: ${summary}`);
        }
      } catch (e) {
        this.log(
          `Auto-summary failed (non-critical): ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    })();

    await Promise.race([
      summaryPromise,
      new Promise((r) => setTimeout(r, 3000)),
    ]);

    // 7. Register with broker
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
    // Pass orchestrator-assigned slot/role for explicit slot targeting
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

    const reg = await this.broker.register(regBody as any);
    this.myId = reg.id;
    this.log(`Registered as peer ${this.myId}`);

    // Handle slot matching
    if (reg.slot) {
      this.mySlot = reg.slot;
      this.log(`Matched to slot ${reg.slot.id} (${reg.slot.display_name ?? "unnamed"})`);
      this.restoreRoleContext(reg.slot);
    } else if ((reg as any).choose_slot) {
      // Multiple slot candidates — pick by role or take first
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

    // Deliver recap messages if reconnecting
    if (reg.recap && reg.recap.length > 0) {
      this.log(`Delivering ${reg.recap.length} recap message(s)`);
      for (const msg of reg.recap) {
        const enriched = await this.enrichMessage(msg);
        await this.deliverMessage(enriched);
      }
    }

    // If summary generation is still running, update when done
    if (!initialSummary) {
      summaryPromise.then(async () => {
        if (initialSummary && this.myId) {
          try {
            await this.broker.setSummary(this.myId, initialSummary);
            this.log(`Late auto-summary applied: ${initialSummary}`);
          } catch {
            // Non-critical
          }
        }
      });
    }

    // === PHASE 3: START BACKGROUND LOOPS ===

    // 8. Start poll loop
    this.startPollLoop();

    // 9. Start heartbeat
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
      const file = Bun.file(SESSION_FILE);
      // Synchronous check — Bun.file doesn't throw if missing, but reading will
      const text = require("fs").readFileSync(SESSION_FILE, "utf-8");
      this.sessionFile = JSON.parse(text) as SessionFile;
      this.sessionId = this.sessionFile.session_id;
      this.log(`Session file found: ${this.sessionId}`);
    } catch {
      // No session file — standalone mode
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

    // Inject role-specific best practices based on role category
    const practices = getRolePractices(slot.role, slot.role_description);
    if (practices) {
      parts.push("");
      parts.push("--- ROLE-SPECIFIC PRACTICES ---");
      parts.push(practices);
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
          return this.handleUpdatePlan(toolArgs as { item_id: number; status: string });
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

  protected async handleSetSummary(args: { summary: string }) {
    if (!this.myId) {
      return this.errorResult("Not registered with broker yet");
    }
    try {
      await this.broker.setSummary(this.myId, args.summary);
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
      await this.broker.setRole({
        peer_id: args.peer_id,
        assigner_id: this.myId,
        role: args.role,
        role_description: args.role_description,
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
      await this.broker.renamePeer({
        peer_id: args.peer_id,
        assigner_id: this.myId,
        display_name: args.display_name,
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

    let actionItems = "";
    if (needsReview.length > 0) {
      actionItems += `\n\nAWAITING REVIEW: ${needsReview.map(s => s.display_name || s.role || s.id).join(", ")} — review their work now!`;
    }
    if (addressingFb.length > 0) {
      actionItems += `\nADDRESSING FEEDBACK: ${addressingFb.map(s => s.display_name || s.role || s.id).join(", ")} — be ready to re-review.`;
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

--- 2. EXECUTION ---

Work autonomously and decisively:
- Break your task into steps. Complete each fully before moving on.
- Use acquire_file BEFORE editing any shared file. Release when done.
- Prefer simple, clean solutions. Ask yourself: "Is there a simpler way?"
- No TODO comments, no placeholder logic, no "fix later" patterns.
- Match complexity to the task — don't overengineer small changes, don't underengineer critical ones.

--- 3. VERIFICATION BEFORE DONE ---

NEVER call signal_done without proof your work is correct:
- Run the code. Check the output. Test edge cases.
- Compare expected vs actual behavior.
- Check for: missing error handling, untested paths, hardcoded values, security issues.
- Ask yourself: "Would a senior engineer approve this as production-ready?"
- If you cannot verify (no test runner, no simulator), explain what you verified manually.

signal_done summary MUST include: what changed, what was tested, what the results were.

--- 4. FEEDBACK & SELF-IMPROVEMENT ---

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

--- 5. TEAM AWARENESS ---

Stay aware and proactive:
- Call check_messages frequently — new work arrives at any time.
- Call check_team_status to see who needs help, who is blocked, who is waiting for review.
- If a teammate signals done and your role involves review/QA: START IMMEDIATELY. Do not wait to be asked.
- If you see a teammate stuck: message them with specific help, not "need help?".
- If you have suggestions that improve overall quality, message the relevant teammate.

--- 6. BUG FIXING ---

When bugs are reported to you:
- Investigate autonomously. Trace logs, read error output, find the root cause.
- Do NOT ask "what should I do?" — you are the expert on your code.
- Fix the root cause, not the symptom.
- Verify the fix resolves the issue AND doesn't break other things.
- Then signal_done with the fix summary.

--- 7. HANDOFF PROTOCOL ---

Engineers: implement -> verify -> signal_done -> receive feedback -> fix -> verify -> signal_done -> repeat until approved.
QA/Testers: watch for task_complete -> test/verify -> submit_feedback or approve -> watch for re-submissions.
Reviewers: watch for task_complete -> review code quality, correctness, security -> submit_feedback or approve -> re-review after fixes.
Team Lead: coordinates priorities, resolves conflicts, releases agents when ALL work is production-grade.

--- 8. COMMUNICATION STANDARDS ---

- Lead with the answer, not the reasoning. Be concise.
- When reporting status: what you did, what the result was, what's next.
- When blocked: state what you need, from whom, and what you'll do while waiting.
- Respond to ALL teammate messages promptly.
- Use send_message for targeted communication. Use signal_done for completion signals.

--- 9. STAYING ACTIVE ---

The system DENIES disconnect attempts until you are released. While waiting:
- Check messages and team status every few seconds.
- Look for teammates who need unblocking.
- Look for review/QA work you can start.
- If truly nothing to do: set your summary to describe your availability and what you can help with.
- NEVER go silent. The team depends on your responsiveness.
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
