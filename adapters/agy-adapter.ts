#!/usr/bin/env bun
/**
 * AgyAdapter — MCP adapter for Antigravity CLI instances.
 *
 * Nearly identical to CodexAdapter: no push capability. Messages are
 * delivered via file-based inbox + piggybacked on tool responses.
 */

import { BaseAdapter } from "./base-adapter.ts";
import type { BufferedMessage } from "../shared/types.ts";
import * as fs from "node:fs";
import * as path from "node:path";

export class AgyAdapter extends BaseAdapter {
  private messageBuffer: BufferedMessage[] = [];
  private inboxPath: string | null = null;
  private hasRunStartup = false;

  constructor() {
    super("agy");
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

    return this.getBaseTeamPrompt({
      transport: `INBOUND MESSAGES: you have no push channel — teammates reach you through your inbox file.
  → Read it whenever you check in, and after any operation that ran longer than a minute${inboxHint}`,
      extraDonts: ["Try to use CLI/HTTP to talk to the broker — use MCP tools only"],
    });
  }

  /**
   * Deliver a message by both buffering (for piggyback) and writing to
   * the file-based inbox so AGY sees it via native file reads.
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
      "Use multiagents-peer at meaningful milestones: reply to teammates, update changed status/plan items, and signal_done with verification evidence.",
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
