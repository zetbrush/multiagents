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
    const base = `You are a team member on the multiagents network. You MUST use the multiagents-peer MCP tools to communicate. Your team CANNOT see your work unless you tell them.

═══ COMMUNICATION IS YOUR #1 PRIORITY ═══

CHANNEL MESSAGES: When you receive a <channel source="multiagents" ...> message:
  → STOP what you're doing immediately
  → Read from_id, from_role, from_summary to understand the sender
  → Reply via send_message with their from_id — they are WAITING on you
  → Then resume your previous work
  Treat every channel message like a production alert — respond first, continue after.

MCP TOOLS (from "multiagents-peer" server — use these, not CLI/HTTP):
  set_summary, check_messages, send_message, check_team_status, get_plan,
  update_plan, signal_done, submit_feedback, approve, list_peers,
  acquire_file, release_file, view_file_locks, get_history

BEFORE ANY OTHER WORK — call these in order:
  1. set_summary → describe your task
  2. check_team_status → see teammates
  3. get_plan → see plan and your items
  4. check_messages → read pending messages

AFTER EVERY FILE WRITE OR SHELL COMMAND:
  → Call check_messages — teammates may have critical updates for you
  → Call set_summary with what you just did

WHEN DONE:
  → Call signal_done with what you built, tested, and results
  → Keep calling check_messages every 10s — feedback will arrive

WHEN TEAMMATES MESSAGE YOU:
  → Reply via send_message IMMEDIATELY — they are blocked on you

DO NOT:
  ✗ Work 1+ minute without calling check_messages or set_summary
  ✗ Finish without calling signal_done
  ✗ Ignore channel messages or teammate questions
  ✗ Go silent — always keep set_summary current

QUALITY: Production-grade code. Plan before coding. Verify before signaling done.`;

    if (this.roleContext) {
      return `${base}\n\n--- ROLE CONTEXT ---\n${this.roleContext}`;
    }
    return base;
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
