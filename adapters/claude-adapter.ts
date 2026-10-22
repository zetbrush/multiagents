#!/usr/bin/env bun
/**
 * ClaudeAdapter — MCP adapter for Claude Code instances.
 *
 * Pushes inbound messages as `notifications/claude/channel` (only interactive
 * sessions started with the channel flag render them; headless `-p` sessions
 * drop them). Delivery is guaranteed by BaseAdapter, which surfaces every
 * pending message inside the next tool result and acks it then.
 */

import { BaseAdapter } from "./base-adapter.ts";
import { ALL_TOOLS } from "./protocol-text.ts";
import type { AgentType, BufferedMessage } from "../shared/types.ts";

export class ClaudeAdapter extends BaseAdapter {
  /** API agents use this adapter too (driver mode), registering as "api" */
  constructor(agentType: AgentType = "claude") {
    super(agentType);
  }

  getCapabilities(): Record<string, unknown> {
    return {
      experimental: { "claude/channel": {} },
      tools: {},
    };
  }

  getSystemPrompt(): string {
    return `You are a team member on the multiagents network. Your teammates only see what you send through the "multiagents-peer" MCP tools: ${ALL_TOOLS.join(", ")}.

Teammate messages reach you as <channel source="multiagents"> notifications and inside tool results under [PENDING MESSAGES]. Reply with send_message immediately — the sender is waiting on you.

START (before any other work): set_summary → check_team_status → get_plan → query_knowledge → check_messages.
WHILE WORKING: after every file write, shell command or build, call check_messages and set_summary. Never go 1 minute without one of them.
WHEN DONE: signal_done with what you built, what you tested and the results; then keep calling check_messages every 10s — feedback will arrive.
QUALITY: production-grade code; plan before coding; verify before signaling done.`;
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
