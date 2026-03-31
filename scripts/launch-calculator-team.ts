#!/usr/bin/env bun
/**
 * Launch a 3-agent team to build a TypeScript calculator web app.
 * Gemini (UI/UX Designer) → Claude (Engineer) → Codex (Code Reviewer) → loop
 */

import { BrokerClient } from "../shared/broker-client.ts";
import { launchAgent, ensureMcpConfigs, announceNewMember } from "../orchestrator/launcher.ts";
import { monitorProcess, type AgentEvent } from "../orchestrator/monitor.ts";
import { getTeamStatus, formatTeamStatusForDisplay } from "../orchestrator/progress.ts";
import { BROKER_HOSTNAME, DEFAULT_BROKER_PORT } from "../shared/constants.ts";
import { slugify, log } from "../shared/utils.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentLaunchConfig } from "../shared/types.ts";

const BROKER_URL = `http://${BROKER_HOSTNAME}:${DEFAULT_BROKER_PORT}`;
const PROJECT_DIR = "/tmp/calculator-app";
const SESSION_NAME = "calculator-app";

const LOG_PREFIX = "launch-team";

// --- Ensure broker ---
async function ensureBroker(client: BrokerClient): Promise<void> {
  if (await client.isAlive()) {
    log(LOG_PREFIX, "Broker already running");
    return;
  }
  log(LOG_PREFIX, "Starting broker...");
  const brokerScript = path.resolve(import.meta.dir, "../broker.ts");
  Bun.spawn(["bun", brokerScript], { stdio: ["ignore", "ignore", "inherit"] }).unref();
  for (let i = 0; i < 30; i++) {
    await Bun.sleep(200);
    if (await client.isAlive()) { log(LOG_PREFIX, "Broker started"); return; }
  }
  throw new Error("Broker failed to start");
}

// --- Launch dashboard ---
function launchDashboard(sessionId: string): void {
  const cliPath = path.resolve(import.meta.dir, "../cli.ts");
  const script = `tell application "Terminal" to do script "cd ${PROJECT_DIR} && bun ${cliPath} dashboard ${sessionId}"`;
  Bun.spawn(["osascript", "-e", script], { stdio: ["ignore", "ignore", "ignore"] }).unref();
  log(LOG_PREFIX, "Dashboard launched in Terminal.app");
}

// --- Event handler ---
function handleEvent(event: AgentEvent): void {
  const icon = event.severity === "critical" ? "!!!" : event.severity === "warning" ? "!!" : ">";
  log(LOG_PREFIX, `[${icon}] ${event.message}`);
}

// --- Main ---
async function main() {
  const client = new BrokerClient(BROKER_URL);
  await ensureBroker(client);

  // Init git
  if (!fs.existsSync(path.join(PROJECT_DIR, ".git"))) {
    Bun.spawnSync(["git", "init"], { cwd: PROJECT_DIR });
    log(LOG_PREFIX, "Git initialized");
  }

  // Create session
  const sessionId = slugify(SESSION_NAME);
  await client.createSession({
    id: sessionId,
    name: SESSION_NAME,
    project_dir: PROJECT_DIR,
    git_root: PROJECT_DIR,
  });
  log(LOG_PREFIX, `Session "${sessionId}" created`);

  // Agent configs
  const agents: AgentLaunchConfig[] = [
    {
      agent_type: "gemini",
      name: "Luna",
      role: "UI/UX Designer",
      role_description: `You are a senior UI/UX designer specializing in web applications.
You design clean, modern, accessible interfaces with clear visual hierarchy.

YOUR DELIVERABLES:
1. Create a design specification document at design/SPEC.md with:
   - Layout description (component hierarchy, spacing, colors)
   - Color palette (CSS variables)
   - Typography choices
   - Component list with HTML/CSS structure for each
   - Responsive behavior notes
   - Accessibility requirements (ARIA labels, keyboard navigation, focus states)
2. Create design/styles.css with the complete CSS for the calculator

CONSTRAINTS:
- Pure HTML + CSS + TypeScript — no frameworks, no React, no build tools
- Single page app served by Bun.serve()
- Calculator should have: digits 0-9, operations +−×÷, equals, clear, decimal point
- Dark theme with accent colors
- Large, touch-friendly buttons in a grid layout
- Display area showing current input and previous operation

WORKFLOW:
- After completing your design files, call signal_done with proof of what you created
- Send a message to the Engineer (via send_message) saying "Design ready for implementation"
- Wait for feedback — if the Engineer or Reviewer requests changes, address them promptly`,
      initial_task: `Design a beautiful, modern calculator web app. Create design/SPEC.md (design specification) and design/styles.css (complete stylesheet). The app uses pure HTML/CSS/TypeScript served by Bun. After finishing, signal_done and message the Engineer that design is ready.`,
      file_ownership: ["design/**"],
    },
    {
      agent_type: "claude",
      name: "Max",
      role: "Software Engineer",
      role_description: `You are a senior TypeScript engineer building a calculator web app served by Bun.

YOUR DELIVERABLES:
1. src/calculator.ts — Calculator logic class (pure TypeScript, no DOM)
   - Operations: add, subtract, multiply, divide
   - Handles: chained operations, decimal points, clear, error states (div by 0)
   - Fully testable without DOM
2. src/app.ts — DOM binding and event handlers
   - Reads the design spec from design/SPEC.md
   - Creates the HTML structure matching the designer's specification
   - Wires button clicks to calculator logic
   - Updates the display
3. src/index.ts — Bun.serve() entry point
   - Serves index.html with the app
4. index.html — Main HTML file importing app.ts
5. tests/calculator.test.ts — Unit tests for calculator logic

WORKFLOW:
- WAIT for the Designer (Luna) to finish the design spec before implementing
- Call check_messages frequently — the designer will message you when ready
- Read design/SPEC.md and design/styles.css before coding
- After implementing, run tests with 'bun test'
- Call signal_done with test results
- Message the Code Reviewer (via send_message) that implementation is ready for review
- Address any feedback from the reviewer, then signal_done again`,
      initial_task: `Build a calculator web app in TypeScript served by Bun. WAIT for the Designer (Luna) to complete design/SPEC.md before you start coding — call check_messages and check_team_status frequently until the design is ready. Then implement src/calculator.ts (logic), src/app.ts (DOM), src/index.ts (Bun.serve), index.html, and tests. After implementing + testing, signal_done and message the Code Reviewer.`,
      file_ownership: ["src/**", "tests/**", "index.html"],
    },
    {
      agent_type: "codex",
      name: "Riley",
      role: "Code Reviewer",
      role_description: `You are a senior code reviewer and QA engineer. You review code for correctness, style, security, accessibility, and completeness.

YOUR RESPONSIBILITIES:
1. Review ALL code files for:
   - Correctness (logic bugs, edge cases, error handling)
   - TypeScript best practices (types, no any, proper error handling)
   - Code style (consistent naming, clean structure)
   - Accessibility (ARIA attributes, keyboard navigation, screen reader support)
   - Security (input validation, no eval/innerHTML with user input)
   - Test coverage (are edge cases tested?)
2. Run the tests yourself: 'bun test'
3. Try running the app: 'bun src/index.ts' and verify it serves correctly

WORKFLOW:
- WAIT for the Engineer (Max) to signal completion before reviewing
- Call check_messages and check_team_status frequently
- When the Engineer signals done, read ALL source files and the design spec
- Use submit_feedback to send actionable feedback to the Engineer
- Set actionable=true if changes are required, actionable=false if just suggestions
- After the Engineer addresses your feedback and signals done again, re-review
- When everything meets quality standards, call approve for the Engineer
- Then call signal_done yourself`,
      initial_task: `Review the calculator web app code. WAIT for the Engineer (Max) to signal completion — call check_messages and check_team_status frequently. When ready, review all code (src/**, tests/**, index.html, design/**) for correctness, style, accessibility, and test coverage. Run 'bun test'. Use submit_feedback with actionable feedback. Only approve when everything is production-quality.`,
      file_ownership: [],
    },
  ];

  // Plan items
  const planItems = [
    { label: "Design calculator UI (SPEC.md + styles.css)", agent_name: "Luna" },
    { label: "Hand off design to Engineer", agent_name: "Luna" },
    { label: "Implement calculator logic (calculator.ts)", agent_name: "Max" },
    { label: "Implement DOM binding and Bun server", agent_name: "Max" },
    { label: "Write and pass unit tests", agent_name: "Max" },
    { label: "Hand off to Code Reviewer", agent_name: "Max" },
    { label: "Review code for correctness, style, a11y", agent_name: "Riley" },
    { label: "Address reviewer feedback", agent_name: "Max" },
    { label: "Final approval from Code Reviewer", agent_name: "Riley" },
  ];

  // Launch agents with stagger
  const launchedSlots: number[] = [];
  const launchedTypes = new Set<string>();
  const procs = new Map<number, any>();

  for (const agentCfg of agents) {
    if (launchedTypes.has(agentCfg.agent_type)) {
      log(LOG_PREFIX, `Staggering ${agentCfg.name} launch (3s delay)...`);
      await Bun.sleep(3000);
    }
    launchedTypes.add(agentCfg.agent_type);

    const result = await launchAgent(sessionId, PROJECT_DIR, agentCfg, client);
    procs.set(result.slotId, result.process);
    launchedSlots.push(result.slotId);

    // Monitor
    monitorProcess(result.process, result.slotId, sessionId, client, handleEvent);

    // Announce
    const slot = await client.getSlot(result.slotId);
    await announceNewMember(sessionId, slot, agentCfg, client);

    log(LOG_PREFIX, `✓ ${agentCfg.name} launched (slot ${result.slotId}, PID ${result.pid})`);
  }

  // Create plan
  const slotByName = new Map(agents.map((a, i) => [a.name, launchedSlots[i]!]));
  await client.createPlan({
    session_id: sessionId,
    title: SESSION_NAME,
    items: planItems.map((item) => ({
      label: item.label,
      assigned_to_slot: slotByName.get(item.agent_name),
    })),
  });
  log(LOG_PREFIX, "Plan created with 9 items");

  // Send plan to each agent
  const plan = await client.getPlan(sessionId);
  if (plan?.items) {
    for (const agent of agents) {
      const slotId = slotByName.get(agent.name);
      if (!slotId) continue;
      const myItems = plan.items.filter((i: any) => i.assigned_to_slot === slotId);
      if (myItems.length === 0) continue;
      const slot = await client.getSlot(slotId);
      if (!slot?.peer_id) continue;
      const itemLines = myItems.map((i: any) => `  [ ] #${i.id}: ${i.label}`).join("\n");
      await client.sendMessage({
        from_id: "orchestrator",
        to_id: slot.peer_id,
        text: `PLAN — Your assigned items:\n${itemLines}\n\nAs you complete each item, call: update_plan({item_id: <ID>, status: "done"}).`,
        msg_type: "system",
        session_id: sessionId,
      });
    }
  }

  // Launch dashboard
  launchDashboard(sessionId);

  // Print status
  const status = await getTeamStatus(sessionId, client);
  console.log("\n" + formatTeamStatusForDisplay(status));
  console.log("\n✓ Team launched! Dashboard opening in Terminal.app");
  console.log(`  Session: ${sessionId}`);
  console.log(`  Project: ${PROJECT_DIR}`);
  console.log(`  Monitor: bun cli.ts dashboard ${sessionId}`);
  console.log(`  Status:  bun cli.ts status`);
  console.log("\nThis script will now monitor events. Press Ctrl+C to stop monitoring.\n");

  // Keep alive and print events
  while (true) {
    await Bun.sleep(10000);
    try {
      const s = await getTeamStatus(sessionId, client);
      const connected = s.agents.filter(a => a.status === "connected").length;
      const done = s.agents.filter(a => a.task_state === "done_pending_review" || a.task_state === "approved").length;
      log(LOG_PREFIX, `Status: ${connected}/${s.agents.length} connected, ${done} done/approved, plan ${s.plan_completion}%`);

      // Check if all approved
      const allApproved = s.agents.length > 0 && s.agents.every(a =>
        a.task_state === "approved" || a.task_state === "released"
      );
      if (allApproved) {
        log(LOG_PREFIX, "🎉 ALL AGENTS APPROVED — Team work is complete!");
        break;
      }
    } catch { /* ok */ }
  }
}

main().catch((err) => {
  console.error(`Fatal: ${err}`);
  process.exit(1);
});
