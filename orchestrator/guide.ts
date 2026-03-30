// ============================================================================
// multiagents — Orchestrator Guide & Documentation
// ============================================================================
// Comprehensive documentation for the orchestrator user (Claude Desktop).
// Exposed via the get_guide MCP tool with topic-based sections.
// ============================================================================

export type GuideTopic =
  | "overview"
  | "quickstart"
  | "roles"
  | "workflows"
  | "tools"
  | "session_lifecycle"
  | "troubleshooting"
  | "examples"
  | "best_practices";

export const GUIDE_TOPICS: { id: GuideTopic; title: string; summary: string }[] = [
  { id: "overview", title: "Overview", summary: "What multiagents is, architecture, core concepts" },
  { id: "quickstart", title: "Quick Start", summary: "Step-by-step guide to create your first team" },
  { id: "roles", title: "Roles & Team Composition", summary: "Core roles, platform prefixes, role_description best practices" },
  { id: "workflows", title: "Workflow Patterns", summary: "Common team workflows: feature dev, bug fix, UI feature, refactor" },
  { id: "tools", title: "Tool Reference", summary: "All orchestrator tools with usage examples" },
  { id: "session_lifecycle", title: "Session Lifecycle", summary: "Create, pause, resume, end sessions; agent lifecycle states" },
  { id: "troubleshooting", title: "Troubleshooting", summary: "Common issues and how to resolve them" },
  { id: "examples", title: "Examples", summary: "Complete create_team payloads for real-world scenarios" },
  { id: "best_practices", title: "Best Practices", summary: "Tips for effective multi-agent orchestration" },
];

const GUIDES: Record<GuideTopic, string> = {
  overview: `# Multiagents — Overview

## What It Is
Multiagents is a multi-agent orchestration platform that lets you manage teams of AI coding agents (Claude Code, Codex CLI, Gemini CLI) working together on the same codebase. Agents discover each other, communicate in real-time, coordinate file edits, and follow structured feedback loops.

## Architecture
\`\`\`
You (Claude Desktop / Orchestrator)
  |
  v
Orchestrator MCP Server (multiagents-orch)
  |
  v
Broker (HTTP + SQLite on localhost:7899)
  |         |         |
  v         v         v
Agent 1   Agent 2   Agent 3
(Claude)  (Claude)  (Claude)
  |         |         |
  v         v         v
MCP Adapter (multiagents) — each agent gets peer communication tools
\`\`\`

## Core Concepts
- **Session**: A project workspace with agents, plans, and message history. Persists in SQLite.
- **Slot**: A pre-allocated position for an agent in a session. Preserves context across reconnections.
- **Role**: What an agent does (Engineer, Designer, QA, Reviewer). Determines injected best practices.
- **Plan**: Task items tracked across the session. Each item can be assigned to an agent.
- **Task State**: Agent lifecycle: idle → in_progress → done_pending_review → addressing_feedback → approved → released.
- **Guardrails**: Session limits (duration, messages, restarts) that auto-pause the session when exceeded.

## What Agents Get Automatically
When you assign a role to an agent, the system automatically injects:
- Role-specific best practices (TDD for engineers, OWASP for reviewers, test pyramid for QA, etc.)
- Tool discovery hints (which available tools to use for their role)
- Completion criteria (who must approve them, what "done" means)
- Platform-specific guidance (web, Android, iOS, CLI, API) if detected from task/description`,

  quickstart: `# Quick Start — Your First Team

## Step 1: Create a Team
Call create_team with a project directory, session name, and agents:

\`\`\`json
{
  "project_dir": "/path/to/your/project",
  "session_name": "add-auth-feature",
  "agents": [
    {
      "agent_type": "claude",
      "name": "Engineer",
      "role": "Software Engineer",
      "role_description": "Implement features in TypeScript/React. Follow existing patterns.",
      "initial_task": "Implement JWT authentication for the /api/login and /api/register endpoints. Write tests."
    },
    {
      "agent_type": "claude",
      "name": "Reviewer",
      "role": "Code Reviewer",
      "role_description": "Review code for security, performance, and correctness.",
      "initial_task": "Review the authentication implementation when the Engineer signals done. Focus on OWASP top 10."
    },
    {
      "agent_type": "claude",
      "name": "QA",
      "role": "QA Engineer",
      "role_description": "Test the authentication feature end-to-end.",
      "initial_task": "Test the auth endpoints when Engineer signals done. Test: valid login, invalid credentials, expired tokens, SQL injection."
    }
  ],
  "plan": [
    { "label": "Implement auth API endpoints", "agent_name": "Engineer" },
    { "label": "Write auth unit tests", "agent_name": "Engineer" },
    { "label": "Review auth code", "agent_name": "Reviewer" },
    { "label": "Test auth E2E", "agent_name": "QA" }
  ]
}
\`\`\`

## Step 2: Monitor Progress
Call get_team_status periodically to see:
- Which agents are online and their task states
- Plan completion percentage
- Any blocked agents that need your help

## Step 3: Respond to Escalations
If get_team_status shows "BLOCKED AGENTS", read their message and help unblock them:
- Need an emulator? Set it up and tell the agent via direct_agent
- Need credentials? Provide them via direct_agent
- Need clarification? Answer via direct_agent

## Step 4: Complete the Session
When get_team_status shows "ALL AGENTS APPROVED":
1. Call release_all to let agents disconnect
2. Call end_session to archive

## Step 5: Resume Later (optional)
If you need to pause and come back:
1. Call control_session with action "pause_all"
2. Close Claude Desktop
3. Later: call list_sessions to find your session
4. Call resume_session to restart all agents with their context`,

  roles: `# Roles & Team Composition

## 4 Core Roles

| Role | What They Do | Who Must Approve Them |
|------|-------------|----------------------|
| Software Engineer | Implements features, writes tests, fixes bugs | Code Reviewer AND QA |
| UI/UX Designer | Creates implementable specs, design tokens, accessibility requirements | Engineer confirms implementable, QA verifies a11y |
| QA Engineer | Tests on real platforms, finds bugs, regression tests after fixes | N/A (QA approves others) |
| Code Reviewer | Reviews security, performance, architecture, test coverage | N/A (Reviewer approves others) |

## Platform Prefixes
Add a platform prefix for targeted guidance:
- "Android Software Engineer" → gets Android-specific practices (Kotlin, Compose, ADB, emulator)
- "iOS QA Engineer" → gets iOS-specific testing (xcrun simctl, simulator, XCTest)
- "Web Code Reviewer" → gets web-specific security (XSS, CSRF, CSP)
- "Backend Software Engineer" → gets API-specific practices (REST, SQL injection, rate limiting)

## Recommended Team Compositions

**Feature Development (small)**:
- 1 Software Engineer + 1 Code Reviewer + 1 QA Engineer

**Feature Development (with design)**:
- 1 UI/UX Designer + 1-2 Software Engineers + 1 Code Reviewer + 1 QA Engineer

**Bug Fix**:
- 1 Software Engineer + 1 QA Engineer

**Refactoring**:
- 1 Software Engineer + 1 Code Reviewer

**Full Product Team**:
- 1 UI/UX Designer + 2 Software Engineers (frontend + backend) + 1 Code Reviewer + 1 QA Engineer

## Writing Good role_descriptions
The richer the role_description, the better the agent performs. Include:
- **Platform/framework**: "React/TypeScript frontend", "Kotlin/Jetpack Compose Android"
- **Specific expertise**: "Focus on authentication and authorization"
- **Constraints**: "Must use existing Prisma schema, don't add new dependencies"
- **Acceptance criteria**: "Feature must pass Lighthouse accessibility score > 90"

## Writing Good initial_tasks
Be specific:
- BAD: "Implement the feature"
- GOOD: "Implement JWT auth for /api/login and /api/register. Use bcrypt for password hashing. Store tokens in httpOnly cookies. Write unit tests for token generation and validation. Acceptance: all tests pass, no TypeScript errors."`,

  workflows: `# Workflow Patterns

## Pattern 1: Standard Feature Development
\`\`\`
Designer → writes spec → signal_done
    |
    v
Engineer → reads spec → asks questions → gets answers → implements (TDD) → signal_done
    |                                                                         |
    v                                                                         v
                                                              Code Reviewer → reviews → feedback
                                                              QA Engineer → tests → bugs
    |
    v
Engineer → fixes feedback + bugs → signal_done
    |
    v
Code Reviewer → re-reviews → approve()
QA Engineer → re-tests → approve()
    |
    v
Orchestrator → sees ALL APPROVED → release_all → end_session
\`\`\`

## Pattern 2: Bug Fix
\`\`\`
Engineer → investigates → fixes → writes regression test → signal_done
    |
    v
QA → tests fix + regression → feedback or approve()
    |
    v
(loop until QA approves)
\`\`\`

## Pattern 3: Parallel Development
\`\`\`
Engineer A (frontend) → implements UI → signal_done
Engineer B (backend) → implements API → signal_done
    |                                       |
    v                                       v
Reviewer → reviews both → feedback ----→ approve
QA → tests integration → feedback ----→ approve
\`\`\`

## The Feedback Loop (Critical)
The core pattern that keeps quality high:
1. Agent completes work → calls signal_done
2. Reviewer/QA sees "done_pending_review" in check_team_status → starts immediately
3. Reviewer/QA finds issues → submit_feedback(actionable=true)
4. Agent receives feedback → task_state becomes "addressing_feedback"
5. Agent fixes ALL issues → calls signal_done again
6. Reviewer/QA re-checks → either more feedback or approve()
7. Loop continues until approve() is called
8. Session not complete until ALL cross-role approvals are done

## Orchestrator's Role
You (the orchestrator) should:
- Call get_team_status every few minutes to monitor progress
- Unblock agents that send you BLOCKED messages (infrastructure, credentials, etc.)
- Use direct_agent to clarify requirements or resolve disputes
- Use broadcast_to_team for priority changes or scope adjustments
- Only call release_all when ALL agents show "approved" task_state`,

  tools: `# Tool Reference

## Session Management
| Tool | When to Use | Key Params |
|------|------------|------------|
| create_team | Start a new multi-agent session | project_dir, session_name, agents[], plan[] |
| list_sessions | Find sessions from previous conversations | status_filter (all/active/paused/archived) |
| resume_session | Restart agents in a paused/stopped session | session_id, agents_to_skip[] |
| control_session | Pause/resume session or agents | session_id, action (pause_all/resume_all/pause_agent/resume_agent) |
| end_session | Archive session and stop all agents | session_id |

## Agent Management
| Tool | When to Use | Key Params |
|------|------------|------------|
| add_agent | Add a new agent mid-session | session_id, agent_type, name, role, role_description, initial_task |
| remove_agent | Remove an agent from session | session_id, target (name/role/slot ID) |
| release_agent | Let a specific agent disconnect | session_id, target |
| release_all | Let all agents disconnect | session_id |
| cleanup_dead_slots | Remove stale disconnected slots | session_id |

## Communication
| Tool | When to Use | Key Params |
|------|------------|------------|
| direct_agent | Send a message to one agent | session_id, target, message |
| broadcast_to_team | Send a message to all agents | session_id, message, exclude_roles[] |
| get_session_log | Read message history | session_id, limit, since |

## Monitoring
| Tool | When to Use | Key Params |
|------|------------|------------|
| get_team_status | Check agent health, task states, plan progress | session_id |
| adjust_guardrail | View or change session limits | session_id, action (view/update), guardrail_id, new_value |

## Typical Flow
1. create_team → session_id
2. get_team_status (repeat) → monitor
3. direct_agent → answer questions, unblock
4. get_team_status → see "ALL APPROVED"
5. release_all → let agents go
6. end_session → archive`,

  session_lifecycle: `# Session Lifecycle

## Session States
\`\`\`
                  create_team
                      |
                      v
                  [ACTIVE] ←──── resume_session / resume_all
                   |    |
         pause_all |    | end_session
                   v    v
               [PAUSED] [ARCHIVED]
                   |
                   v
              (close Claude Desktop)
                   |
                   v
              list_sessions → resume_session
\`\`\`

## Agent Task States
\`\`\`
idle → in_progress → done_pending_review → addressing_feedback ←→ done_pending_review
                                              |
                                              v
                                          approved → released
\`\`\`

- **idle**: Agent is waiting for work or hasn't started
- **in_progress**: Agent is actively working (implicit)
- **done_pending_review**: Agent called signal_done, waiting for feedback
- **addressing_feedback**: Received actionable feedback, fixing issues
- **approved**: Reviewer/QA called approve() — work accepted
- **released**: Orchestrator released agent — can disconnect

## Pause & Resume
- **pause_all**: Holds all messages, agents enter wait mode
- **resume_all**: Releases held messages, agents resume
- **pause_agent**: Pause a specific agent (holds their messages)
- **resume_agent**: Resume a specific agent

## Session Persistence
Everything is stored in SQLite via the broker:
- Session metadata (name, dir, status, timestamps)
- Slot data (role, description, task_state, context_snapshot)
- All messages (full history, preserved across pauses)
- Plan items (status, assignments)
- File locks and ownership

When you close Claude Desktop and come back:
1. Call list_sessions → shows all sessions with status and agent counts
2. Call resume_session(session_id) → respawns agents with:
   - Their original role and description
   - Last known summary and task state
   - Recent message history recap
   - Plan items assigned to them
   - Instructions to check codebase state and resume work

## Guardrails
Default limits (adjustable via adjust_guardrail):
- Session duration: 30 minutes
- Messages per agent: 200
- Max agents: 6
- Max restarts per agent: 3

When a guardrail triggers, the session auto-pauses. Use adjust_guardrail to raise the limit, then control_session(resume_all).`,

  troubleshooting: `# Troubleshooting

## Agent Not Responding
**Symptom**: Agent shows "connected" but no activity
**Fix**:
1. Check get_team_status — is the agent "stuck" health?
2. The system auto-nudges agents silent for >2 minutes
3. Use direct_agent to send a specific message asking for status
4. If still stuck: remove_agent and add_agent to restart fresh

## Agent Crashed / Disconnected
**Symptom**: Agent shows "crashed" in health status
**Auto-fix**: The system auto-respawns crashed agents with their context (unless flapping — 3+ crashes in 5 min)
**Manual fix**: If flapping, check the project for issues (build errors, missing deps), fix them, then add_agent

## Session Paused Unexpectedly
**Symptom**: Session status shows "paused"
**Cause**: Usually a guardrail limit exceeded
**Fix**:
1. Call adjust_guardrail with action "view" to see which guardrail triggered
2. Call adjust_guardrail with action "update" to raise the limit
3. Call control_session with action "resume_all"

## Agent Says "BLOCKED"
**Symptom**: get_team_status shows "BLOCKED AGENTS" section
**Fix**: Read the blocked message — agent explains what they need. Common cases:
- Need emulator/simulator → set it up and tell agent via direct_agent
- Need environment variable → set it in the project and tell agent
- Need dependency installed → install it and tell agent
- Need database running → start it and tell agent

## Can't Find Previous Session
**Fix**: Call list_sessions with no filter to see ALL sessions including archived ones.

## Agents Finishing Too Early
**Symptom**: Agents signal_done without thorough work
**Fix**: The system injects role-specific completion criteria. If still insufficient:
1. Use direct_agent to send specific instructions about what "done" means
2. Add more specific acceptance criteria in initial_task next time

## Dashboard Not Showing
**Fix**: Run manually: \`bun cli.ts dashboard <session-id>\`

## Broker Not Running
**Fix**: \`bun cli.ts broker start\` or the system auto-starts it when needed`,

  examples: `# Complete Examples

## Example 1: React Web Feature
\`\`\`json
{
  "project_dir": "/Users/me/my-react-app",
  "session_name": "user-profile-page",
  "agents": [
    {
      "agent_type": "claude",
      "name": "Frontend Engineer",
      "role": "Web Software Engineer",
      "role_description": "React/TypeScript frontend developer. Use existing component library in src/components/ui/. Follow App Router patterns. Use Tailwind CSS for styling.",
      "initial_task": "Create a user profile page at /profile that shows: avatar, name, email, bio, and an edit form. Use the existing UserService API at src/services/user.ts. Write unit tests with Vitest. Acceptance: page renders, form submits, tests pass, no TypeScript errors.",
      "file_ownership": ["src/app/profile/**", "src/components/profile/**"]
    },
    {
      "agent_type": "claude",
      "name": "Reviewer",
      "role": "Web Code Reviewer",
      "role_description": "Frontend code reviewer. Check React patterns, TypeScript strictness, accessibility, performance (no unnecessary re-renders).",
      "initial_task": "Review the profile page implementation. Focus on: React best practices, a11y (ARIA, keyboard nav), TypeScript strictness, component composition, test quality."
    },
    {
      "agent_type": "claude",
      "name": "QA",
      "role": "Web QA Engineer",
      "role_description": "Web QA tester. Test in browser using available automation tools.",
      "initial_task": "Test the profile page: rendering, form validation, API error handling, responsive layout (mobile + desktop), keyboard navigation, screen reader accessibility."
    }
  ],
  "plan": [
    { "label": "Implement profile page component", "agent_name": "Frontend Engineer" },
    { "label": "Implement profile edit form", "agent_name": "Frontend Engineer" },
    { "label": "Write profile page tests", "agent_name": "Frontend Engineer" },
    { "label": "Review profile code", "agent_name": "Reviewer" },
    { "label": "Test profile E2E in browser", "agent_name": "QA" }
  ]
}
\`\`\`

## Example 2: Android Feature
\`\`\`json
{
  "project_dir": "/Users/me/my-android-app",
  "session_name": "settings-screen",
  "agents": [
    {
      "agent_type": "claude",
      "name": "Android Dev",
      "role": "Android Software Engineer",
      "role_description": "Kotlin/Jetpack Compose developer. Follow MVVM with StateFlow. Use Koin for DI. Use existing theme in ui/theme/.",
      "initial_task": "Implement a Settings screen with: dark mode toggle, notification preferences, account info display, logout button. Use SettingsRepository for persistence. Write unit tests for SettingsViewModel.",
      "file_ownership": ["app/src/main/java/**/settings/**"]
    },
    {
      "agent_type": "claude",
      "name": "QA",
      "role": "Android QA Engineer",
      "role_description": "Android QA. Test on emulator with ADB. Check lifecycle handling.",
      "initial_task": "Test settings screen: toggle persistence, rotation handling, back navigation, process death recovery. Test on emulator."
    }
  ]
}
\`\`\`

## Example 3: API + Database
\`\`\`json
{
  "project_dir": "/Users/me/my-api",
  "session_name": "payment-api",
  "agents": [
    {
      "agent_type": "claude",
      "name": "Backend Dev",
      "role": "Backend Software Engineer",
      "role_description": "Node.js/TypeScript API developer. Use Prisma ORM. Follow REST conventions. All endpoints need auth middleware.",
      "initial_task": "Implement payment CRUD endpoints: POST /api/payments (create), GET /api/payments (list with pagination), GET /api/payments/:id (detail), POST /api/payments/:id/refund. Use Stripe SDK for processing. Write integration tests.",
      "file_ownership": ["src/routes/payments/**", "src/services/payment/**", "prisma/migrations/**"]
    },
    {
      "agent_type": "claude",
      "name": "Security Reviewer",
      "role": "Backend Code Reviewer",
      "role_description": "Security-focused code reviewer for financial APIs. Check OWASP, PCI compliance patterns, input validation, error handling.",
      "initial_task": "Review payment API for: SQL injection, auth bypass, amount manipulation, refund abuse, error message information leakage, proper Stripe webhook verification."
    },
    {
      "agent_type": "claude",
      "name": "QA",
      "role": "Backend QA Engineer",
      "role_description": "API QA tester. Test all endpoints with curl/httpie.",
      "initial_task": "Test payment API: valid payments, insufficient funds, duplicate payments, concurrent requests, pagination, refund flow, auth errors, malformed input, rate limiting."
    }
  ]
}
\`\`\``,

  best_practices: `# Best Practices

## For the Orchestrator (You)

1. **Be specific in role_descriptions** — Include platform, framework, constraints, and what "done" looks like. The system auto-injects practices, but YOUR context makes agents more effective.

2. **Include review + QA in your plan** — Don't just plan implementation tasks. Add explicit "Review X" and "Test X" plan items assigned to Reviewer and QA.

3. **Monitor regularly** — Call get_team_status every few minutes. Look for:
   - Blocked agents that need your help
   - Silent agents that may be stuck
   - Agents in "done_pending_review" with no reviewer picking up

4. **Respond to escalations immediately** — When agents send "BLOCKED:" messages, they're waiting on you. Unblock fast to keep the team moving.

5. **Don't release early** — Wait until get_team_status shows ALL agents approved before calling release_all. Premature release means incomplete work.

6. **Use pause for breaks** — If you need to step away, call control_session(pause_all). Come back with resume_session. All context is preserved.

7. **Start small** — Your first team should be 2-3 agents, not 6. Learn the patterns, then scale.

## For Role Descriptions

- **Engineer**: Include framework, architecture patterns, file conventions, testing framework
- **Designer**: Include design system, component library, brand guidelines, accessibility requirements
- **QA**: Include target platforms, test tools available, performance requirements, a11y level
- **Reviewer**: Include security requirements, performance budgets, code style preferences

## For Initial Tasks

- Include specific acceptance criteria
- Reference specific files, APIs, and patterns to follow
- State what "done" looks like in measurable terms
- For QA: list specific test scenarios, not just "test it"

## Common Mistakes to Avoid

1. **Vague role descriptions** → Agents guess instead of following specific guidance
2. **No plan items** → Progress isn't tracked, agents don't know what's left
3. **No QA agent** → Features ship without testing
4. **Releasing before all approve** → Incomplete feedback loops
5. **Not checking get_team_status** → Blocked agents wait forever
6. **Too many agents** → Communication overhead. 3-4 is the sweet spot.
7. **No file_ownership** → Agents may edit the same file and create conflicts`,
};

/**
 * Get guide content for a specific topic.
 * Returns null if topic not found.
 */
export function getGuide(topic: GuideTopic): string | null {
  return GUIDES[topic] ?? null;
}

/**
 * Get the topic list formatted for display.
 */
export function formatTopicList(): string {
  const lines = [
    "=== Multiagents Guide ===",
    "",
    "Available topics:",
    "",
  ];

  for (const topic of GUIDE_TOPICS) {
    lines.push(`  ${topic.id.padEnd(20)} ${topic.summary}`);
  }

  lines.push("");
  lines.push('Call get_guide with a topic name to read the full guide.');
  lines.push('Start with "quickstart" for a step-by-step tutorial.');

  return lines.join("\n");
}
