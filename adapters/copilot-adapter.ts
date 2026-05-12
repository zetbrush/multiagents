#!/usr/bin/env bun
/**
 * CopilotAdapter — MCP adapter for Copilot CLI instances.
 *
 * Nearly identical to CodexAdapter: no push capability. Messages are
 * delivered via file-based inbox + piggybacked on tool responses.
 */

import { BaseAdapter } from "./base-adapter.ts";
import type { BufferedMessage } from "../shared/types.ts";
import * as fs from "node:fs";
import * as path from "node:path";

export class CopilotAdapter extends BaseAdapter {
  private messageBuffer: BufferedMessage[] = [];
  private inboxPath: string | null = null;
  private hasRunStartup = false;

  constructor() {
    super("copilot");
  }

  getCapabilities(): Record<string, unknown> {
    return {
      tools: {},
    };
  }

  getSystemPrompt(): string {
    const inboxHint = this.inboxPath
      ? `\nYour INBOX FILE: ${this.inboxPath}`
      : "\nYour INBOX FILE: .multiagents/inbox/<your-name>.md (created after registration)";

    const base = `You are GitHub Copilot CLI (backed by GPT-5.4) on the multiagents network.

⚠ IMPORTANT: Copilot executes long shell commands (build, tests, refactors) BETWEEN tool calls.
You MUST periodically read \`.multiagents/inbox/<slot>.md\` — do NOT rely only on MCP piggyback.
After every shell command longer than 10s, re-check the inbox.

═══ COMMUNICATION IS YOUR #1 PRIORITY ═══

You have MCP tools from the "multiagents-peer" server. USE THEM — not shell commands, not HTTP calls, not CLI scripts. The MCP tools are:
  set_summary, check_messages, send_message, check_team_status, get_plan,
  update_plan, signal_done, submit_feedback, approve, list_peers,
  acquire_file, release_file, view_file_locks, get_history

BEFORE ANY OTHER WORK — call these MCP tools in this exact order:
  1. set_summary → describe your task in one line
  2. check_team_status → see your teammates and their roles
  3. get_plan → see the plan and your assigned items
  4. check_messages → read pending messages from teammates

AFTER EVERY SHELL COMMAND OR FILE WRITE:
  → Call check_messages (teammates may have sent critical updates)
  → Call set_summary with what you just did

AFTER EVERY 2-3 TOOL CALLS:
  → Read your inbox file for real-time messages from teammates${inboxHint}

WHEN YOU FINISH YOUR TASK:
  → Call signal_done with what you built, tested, and results
  → Then call check_messages every 10s waiting for review feedback

WHEN A TEAMMATE MESSAGES YOU:
  → Reply via send_message IMMEDIATELY — they are blocked waiting on you

DO NOT:
  ✗ Work for 1+ minute without calling check_messages
  ✗ Finish without calling signal_done
  ✗ Ignore teammate messages
  ✗ Try to use CLI/HTTP to talk to the broker — use MCP tools only
  ✗ Go silent — if you have nothing to do, call check_team_status and set_summary "Idle, ready to help"

QUALITY: Production-grade code. Plan before coding. Verify before signaling done.`;

    if (this.roleContext) {
      return `${base}\n\n--- ROLE CONTEXT ---\n${this.roleContext}`;
    }
    return base;
  }

  /**
   * Deliver a message by both buffering (for piggyback) and writing to
   * the file-based inbox so Copilot sees it via native file reads.
   */
  async deliverMessage(msg: BufferedMessage): Promise<void> {
    this.messageBuffer.push(msg);
    await this.writeToInbox(msg);
  }

  // --- File-based inbox ---

  private ensureInboxPath(): string | null {
    if (this.inboxPath) return this.inboxPath;

    const slotId = this.mySlot?.id;
    const name = this.mySlot?.display_name ?? (slotId ? `slot-${slotId}` : null);
    if (!name) return null;

    const inboxDir = path.join(process.cwd(), ".multiagents", "inbox");
    try {
      if (!fs.existsSync(inboxDir)) {
        fs.mkdirSync(inboxDir, { recursive: true });
      }
    } catch {
      return null;
    }

    const safeName = path.basename(name).replace(/[^a-zA-Z0-9_\-. ]/g, "_");
    this.inboxPath = path.join(inboxDir, `${safeName}.md`);

    try {
      fs.writeFileSync(this.inboxPath, `# Inbox for ${name}\n\nMessages from teammates appear below. Newest at bottom.\n\n---\n\n`);
    } catch { /* best effort */ }

    return this.inboxPath;
  }

  private async writeToInbox(msg: BufferedMessage): Promise<void> {
    const inboxPath = this.ensureInboxPath();
    if (!inboxPath) return;

    try {
      const timestamp = new Date().toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit" });
      const from = msg.from_display_name ?? msg.from_role ?? msg.from_id;
      const entry = `**[${timestamp}] ${from}** (${msg.msg_type}):\n${msg.text}\n\n---\n\n`;
      fs.appendFileSync(inboxPath, entry);
    } catch { /* best effort */ }
  }

  // --- Auto-startup: inject team context on first MCP tool call ---

  private async runAutoStartup(): Promise<string> {
    if (this.hasRunStartup) return "";
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

    try {
      const msgResult = await this.handleCheckMessages();
      parts.push("", "── PENDING MESSAGES ──", msgResult.content[0]?.text ?? "");
    } catch { parts.push("✗ check_messages failed"); }

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

  protected wrapToolResult(result: string): string {
    if (this.messageBuffer.length === 0) {
      return result;
    }

    const pending = this.messageBuffer
      .map((m) => this.formatMessage(m))
      .join("\n");
    this.messageBuffer = [];

    return `[PENDING MESSAGES]\n${pending}\n[END PENDING MESSAGES]\n\n${result}`;
  }

  protected override async handleListPeers(args: any) {
    const r = await super.handleListPeers(args);
    return this.wrapResult(r);
  }

  protected override async handleSendMessage(args: any) {
    const r = await super.handleSendMessage(args);
    return this.wrapResult(r);
  }

  protected override async handleSetSummary(args: any) {
    const r = await super.handleSetSummary(args);
    return this.wrapResult(r);
  }

  protected override async handleCheckMessages() {
    const r = await super.handleCheckMessages();
    return this.wrapResult(r);
  }

  protected override async handleAssignRole(args: any) {
    const r = await super.handleAssignRole(args);
    return this.wrapResult(r);
  }

  protected override async handleRenamePeer(args: any) {
    const r = await super.handleRenamePeer(args);
    return this.wrapResult(r);
  }

  protected override async handleAcquireFile(args: any) {
    const r = await super.handleAcquireFile(args);
    return this.wrapResult(r);
  }

  protected override async handleReleaseFile(args: any) {
    const r = await super.handleReleaseFile(args);
    return this.wrapResult(r);
  }

  protected override async handleViewFileLocks() {
    const r = await super.handleViewFileLocks();
    return this.wrapResult(r);
  }

  protected override async handleGetHistory(args: any) {
    const r = await super.handleGetHistory(args);
    return this.wrapResult(r);
  }

  // --- Lifecycle tool wrappers (critical for message delivery) ---

  protected override async handleSignalDone(args: any) {
    const r = await super.handleSignalDone(args);
    return this.wrapResult(r);
  }

  protected override async handleSubmitFeedback(args: any) {
    const r = await super.handleSubmitFeedback(args);
    return this.wrapResult(r);
  }

  protected override async handleApprove(args: any) {
    const r = await super.handleApprove(args);
    return this.wrapResult(r);
  }

  protected override async handleCheckTeamStatus() {
    const r = await super.handleCheckTeamStatus();
    return this.wrapResult(r);
  }

  protected override async handleGetPlan() {
    const r = await super.handleGetPlan();
    return this.wrapResult(r);
  }

  protected override async handleUpdatePlan(args: any) {
    const r = await super.handleUpdatePlan(args);
    return this.wrapResult(r);
  }

  private async wrapResult(result: { content: { type: string; text: string }[]; isError?: boolean }) {
    const text = result.content[0]?.text ?? "";
    const startupContext = await this.runAutoStartup();
    const wrapped = this.wrapToolResult(text);
    return {
      ...result,
      content: [{ type: "text" as const, text: startupContext + wrapped }],
    };
  }
}
