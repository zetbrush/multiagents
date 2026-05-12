#!/usr/bin/env bun
/**
 * JinnAdapter — MCP adapter acting as a bridge to the Jinn Gateway.
 *
 * Exposes the 13 Jinn AI employees as virtual peers on the multiagents
 * network. Inbound messages are routed via HTTP POST to the local Jinn
 * Gateway (default port 7777). This adapter does not run in driver mode;
 * it relies on the broker's polling loop like a standard BaseAdapter.
 */

import { BaseAdapter } from "./base-adapter.ts";
import type { BufferedMessage } from "../shared/types.ts";

const JINN_GATEWAY_URL = process.env.JINN_GATEWAY_URL ?? "http://127.0.0.1:7777";

const EMPLOYEES: readonly string[] = [
  "gpt-coder",
  "kimi-coder",
  "deep-reasoner",
  "deepseek-analyst",
  "code-reviewer",
  "remi-cohere",
  "sam-cerebras",
  "secops",
  "sysadmin",
  "tech-watch",
  "diane-nim",
  "kilocode-coder",
  "alibaba-coder",
];

// TODO: confirmer l'endpoint exact de l'API Jinn Gateway (delegate vs sessions)

export class JinnAdapter extends BaseAdapter {
  private messageBuffer: BufferedMessage[] = [];

  constructor() {
    super("jinn");
  }

  getCapabilities(): Record<string, unknown> {
    return {
      tools: {},
    };
  }

  getSystemPrompt(): string {
    const base = `You are a bridge adapter to the Jinn Gateway multi-AI team.
Your role is to proxy messages between the multiagents network and the
13 Jinn employees running on the local Gateway (${JINN_GATEWAY_URL}).

VIRTUAL EMPLOYEES — mention one with @<name> in your message text:
  • gpt-coder        — GPT-5.4 (Copilot)
  • kimi-coder       — Kimi K2.6 (Moonshot)
  • deep-reasoner    — DeepSeek R1 (reasoning)
  • deepseek-analyst — DeepSeek V3.2 (analysis)
  • code-reviewer    — Mistral Large (review)
  • remi-cohere      — Cohere Command A
  • sam-cerebras     — Cerebras Qwen3-235B
  • secops           — Hermes-4-70B (security)
  • sysadmin         — Qwen3-235B (OpenRouter)
  • tech-watch       — Gemini 2.5 Pro (R&D watch)
  • diane-nim        — Nemotron Ultra 253B (NIM)
  • kilocode-coder   — Claude Opus 4 (KiloCode)
  • alibaba-coder    — Qwen3-coder-next (DashScope)

ROUTING RULES:
  → Prefix your message with @<employee> to choose a recipient.
  → If you omit the mention, the gateway defaults to gpt-coder.
  → Do NOT call Jinn HTTP endpoints yourself — use send_message.

MCP TOOLS: set_summary, check_messages, send_message, check_team_status,
get_plan, update_plan, signal_done, submit_feedback, approve, list_peers,
acquire_file, release_file, view_file_locks, get_history`;

    if (this.roleContext) {
      return `${base}\n\n--- ROLE CONTEXT ---\n${this.roleContext}`;
    }
    return base;
  }

  async deliverMessage(msg: BufferedMessage): Promise<void> {
    // Retry previously failed deliveries first
    const backlog = [...this.messageBuffer];
    this.messageBuffer = [];
    for (const m of backlog) {
      await this.dispatch(m);
    }
    await this.dispatch(msg);
  }

  private async dispatch(msg: BufferedMessage): Promise<void> {
    const employee = this.resolveEmployee(msg);
    const payload = {
      employee,
      task: msg.text,
      from_id: msg.from_id,
      from_role: msg.from_role,
      msg_type: msg.msg_type,
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    try {
      const res = await fetch(`${JINN_GATEWAY_URL}/delegate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`HTTP ${res.status}: ${text}`);
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      console.error(`[JinnAdapter] Failed to route to ${employee}: ${error}`);
      this.messageBuffer.push(msg);
    } finally {
      clearTimeout(timeout);
    }
  }

  private resolveEmployee(msg: BufferedMessage): string {
    const mention = msg.text.match(/@([a-zA-Z0-9_-]+)/);
    const mentioned = mention?.[1];
    if (mentioned && (EMPLOYEES as readonly string[]).includes(mentioned)) {
      return mentioned;
    }
    if (msg.to_id && (EMPLOYEES as readonly string[]).includes(msg.to_id)) {
      return msg.to_id;
    }
    return "gpt-coder";
  }
}
