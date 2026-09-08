#!/usr/bin/env bun
/**
 * ClaudeAdapter — MCP adapter for Claude Code instances.
 *
 * Uses the experimental claude/channel capability to push inbound
 * messages directly into the Claude session as channel notifications.
 */

import { BaseAdapter } from "./base-adapter.ts";
import type { BufferedMessage } from "../shared/types.ts";

export class ClaudeAdapter extends BaseAdapter {
  constructor() {
    super("claude");
  }

  getCapabilities(): Record<string, unknown> {
    return {
      experimental: { "claude/channel": {} },
      tools: {},
    };
  }

  getSystemPrompt(): string {
    return this.getBaseTeamPrompt({
      transport: `CHANNEL MESSAGES: When you receive a <channel source="multiagents" ...> message:
  → STOP what you're doing immediately
  → Read from_id, from_role, from_summary to understand the sender
  → Reply via send_message with their from_id — they are WAITING on you
  → Then resume your previous work
  Treat every channel message like a production alert — respond first, continue after.`,
      extraDonts: ["Ignore channel messages"],
    });
  }

  async deliverMessage(msg: BufferedMessage): Promise<void> {
    await this.mcp.notification({
      method: "notifications/claude/channel",
      params: {
        content: msg.text,
        meta: {
          from_id: msg.from_id,
          from_summary: msg.from_summary ?? "",
          from_cwd: msg.from_cwd ?? "",
          from_role: msg.from_role ?? "",
          sent_at: msg.sent_at,
        },
      },
    });
  }
}
