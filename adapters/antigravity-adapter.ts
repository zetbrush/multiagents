#!/usr/bin/env bun
/**
 * AntigravityAdapter — MCP adapter for Antigravity CLI (`agy`) instances.
 *
 * Antigravity has no push capability: teammate messages reach the model inside
 * tool results ([PENDING MESSAGES], handled by BaseAdapter) and, in standalone
 * sessions, are mirrored to a file-based inbox (.multiagents/inbox/<name>.md).
 * Under the orchestrator's driver the session only takes a new prompt between
 * turns, so tool results keep carrying whatever the driver has not claimed.
 */

import { BaseAdapter } from "./base-adapter.ts";
import { FileInbox } from "./inbox.ts";
import { ALL_TOOLS } from "./protocol-text.ts";
import type { BufferedMessage } from "../shared/types.ts";

export class AntigravityAdapter extends BaseAdapter {
  private inbox = new FileInbox(process.cwd());

  constructor() {
    super("antigravity");
    this.autoStartupOnFirstCall = true;
    this.piggybackUnderDriver = true;
  }

  getCapabilities(): Record<string, unknown> {
    return { tools: {} };
  }

  getSystemPrompt(): string {
    return `Use the "multiagents-peer" MCP tools to work with your team: check_messages, send_message, set_summary, signal_done (core), plus ${ALL_TOOLS.slice(4).join(", ")}. Never use shell or HTTP to reach the broker. Your teammates only see what you send through these tools.

Teammate messages arrive inside tool results under [PENDING MESSAGES]. Reply with send_message immediately — the sender is waiting on you.

START (before any other work): set_summary → check_team_status → get_plan → query_knowledge → check_messages.
WHILE WORKING: after every shell command or file write call check_messages and set_summary. Never go 1 minute without one of them.
WHEN DONE: signal_done with what you built, what you tested and the results; then call check_messages every 10s — feedback will arrive.
QUALITY: production-grade code; plan before coding; verify before signaling done.`;
  }

  async deliverMessage(msg: BufferedMessage): Promise<void> {
    this.inbox.append(this.mySlot?.display_name ?? (this.mySlot ? `slot-${this.mySlot.id}` : null), msg);
  }
}
