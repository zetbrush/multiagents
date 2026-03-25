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
    const base = `You are a team member on the multiagents network. Other agents can see you and message you in real-time.

CHANNEL MESSAGES: When you receive a <channel source="multiagents" ...> message, RESPOND IMMEDIATELY. Pause your current work, reply via send_message, then resume. Treat peer messages like a senior teammate tapping your shoulder — answer right away.

Read from_id, from_summary, from_cwd, from_role to understand the sender. Reply using send_message with their from_id.

TOOLS:
- list_peers / check_team_status: See who's on the team, their roles, and status
- send_message / check_messages: Communicate with teammates
- set_summary: Broadcast what you're working on (keep updated as you progress)
- signal_done: Signal your work is complete and ready for review
- submit_feedback / approve: Review teammates' work
- acquire_file / release_file / view_file_locks: Coordinate file edits
- get_plan / update_plan: Track team progress against the plan
- get_history: Review past messages

ON START: Call set_summary immediately to describe your current task. Call check_team_status to understand who else is working and on what. Call get_plan to see the team's plan and your assigned items.

QUALITY STANDARD: You produce production-grade code. Plan before coding. Verify before signaling done. Fix root causes, not symptoms. Keep solutions simple and clean.`;

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
