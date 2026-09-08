import { mkdirSync, realpathSync, openSync, writeSync, closeSync } from 'node:fs';
import { resolve, relative, isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';

export interface VerificationCheck { argv: string[]; cwd: string; timeout_ms?: number }
export interface VerificationResult { argv: string[]; exit_code: number | null; timed_out: boolean; log_path: string; error?: string }
export interface ExecutionStep {
  key: string;
  label: string;
  files: string[];
  depends_on: string[];
  acceptance: string[];
  checks: VerificationCheck[];
  decision_required?: string;
}
export interface ExecutionProgress extends ExecutionStep {
  status: 'pending' | 'in_progress' | 'done' | 'blocked';
  attempts?: number;
  verifying?: boolean;
  decision?: string;
  blocker?: string;
  summary?: string;
  results?: VerificationResult[];
}
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(v => typeof v === 'string' && !!v.trim());
export function validateExecutionPlan(items: ExecutionStep[]): void {
  if (!Array.isArray(items) || !items.length) throw new Error('Execution plan must contain steps');
  const seen = new Set<string>();
  for (const item of items) {
    if (!item || typeof item.key !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(item.key) || seen.has(item.key)) throw new Error('Step keys must be unique identifiers');
    if (typeof item.label !== 'string' || !item.label.trim() || !strings(item.files) || !item.files.length || !strings(item.acceptance) || !item.acceptance.length) throw new Error('Each step requires label, files and acceptance criteria');
    if (!strings(item.depends_on) || item.depends_on.some(key => !seen.has(key))) throw new Error('Dependencies must refer to earlier steps (no cycles or unknown keys)');
    if (item.decision_required !== undefined && (typeof item.decision_required !== 'string' || !item.decision_required.trim())) throw new Error('Decision gate must describe a decision');
    if (!Array.isArray(item.checks) || !item.checks.length || item.checks.length > 10) throw new Error('Each step requires at least one executable check');
    for (const check of item.checks) {
      if (!strings(check.argv) || !check.argv.length || typeof check.cwd !== 'string' || !check.cwd.trim()) throw new Error('Checks require argv and cwd');
      if (check.timeout_ms !== undefined && (!Number.isInteger(check.timeout_ms) || check.timeout_ms < 1 || check.timeout_ms > 300_000)) throw new Error('Check timeout must be 1..300000 ms');
      if (isAbsolute(check.cwd) || check.cwd.split(/[\\/]/).includes('..')) throw new Error('Check cwd must be inside the project');
    }
    seen.add(item.key);
  }
}
export function transitionExecutionStep(step: ExecutionProgress, status: string, all: ExecutionProgress[], reason?: string): ExecutionProgress {
  if (step.verifying) throw new Error('Verification already running');
  if (status === 'done') throw new Error('Use verify_plan_step to complete an execution step');
  if (step.status === 'done') throw new Error('Completed steps are immutable');
  if (status === 'blocked') {
    if (!reason?.trim()) throw new Error('Describe the blocker, attempts and decision needed');
    return { ...step, status, blocker: reason.slice(0, 4000) };
  }
  if (status !== 'in_progress') throw new Error('Execution steps support in_progress or blocked updates');
  if (step.status === 'blocked') throw new Error('Coordinator must resolve this blocker');
  if (step.decision_required && !step.decision) throw new Error(`Coordinator decision required: ${step.decision_required}`);
  const index = all.findIndex(s => s.key === step.key);
  if (index < 0 || all.slice(0, index).some(s => s.status !== 'done')) throw new Error('Complete preceding steps first');
  return { ...step, status };
}
export async function runVerification(checks: VerificationCheck[], projectDir: string, logDir: string, signal?: AbortSignal): Promise<VerificationResult[]> {
  const root = realpathSync(projectDir);
  mkdirSync(logDir, { recursive: true });
  const results: VerificationResult[] = [];
  for (const check of checks) {
    if (signal?.aborted) break;
    const cwd = realpathSync(resolve(root, check.cwd));
    const rel = relative(root, cwd);
    if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) throw new Error('Check cwd escapes the project');
    const logPath = join(logDir, `${randomUUID()}.log`);
    const fd = openSync(logPath, 'wx', 0o600);
    let bytes = 0;
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cleanup = () => {};
    try {
      const proc = Bun.spawn([process.execPath, new URL('./verification-runner.ts', import.meta.url).pathname, ...check.argv], { cwd, stdout: 'pipe', stderr: 'pipe', stdin: 'pipe', detached: process.platform !== 'win32' });
      const kill = () => {
        try { if (process.platform !== 'win32') process.kill(-proc.pid, 'SIGKILL'); else proc.kill('SIGKILL'); } catch { proc.kill('SIGKILL'); }
      };
      const abort = () => kill();
      signal?.addEventListener('abort', abort, { once: true });
      cleanup = () => { signal?.removeEventListener('abort', abort); proc.stdin.end(); kill(); };
      if (signal?.aborted) kill();
      timer = setTimeout(() => { timedOut = true; kill(); }, check.timeout_ms ?? 60_000);
      const drain = async (stream: ReadableStream<Uint8Array>) => {
        for await (const chunk of stream) {
          const remaining = 1_048_576 - bytes;
          if (remaining > 0) { const part = chunk.subarray(0, remaining); writeSync(fd, part); bytes += part.length; }
        }
      };
      const completion = proc.exited.then(code => { if (process.platform !== 'win32') { try { process.kill(-proc.pid, 'SIGKILL'); } catch {} } return code; });
      const [exitCode] = await Promise.all([completion, drain(proc.stdout), drain(proc.stderr)]);
      proc.stdin.end();
      results.push({ argv: check.argv, exit_code: timedOut || signal?.aborted ? null : exitCode, timed_out: timedOut, log_path: logPath, ...(signal?.aborted ? { error: "Verification cancelled" } : {}) });
    } catch (error) {
      results.push({ argv: check.argv, exit_code: null, timed_out: timedOut, log_path: logPath, error: String(error) });
    } finally { clearTimeout(timer); cleanup(); closeSync(fd); }
    if (results.at(-1)?.exit_code !== 0) break;
  }
  return results;
}

export const AUTONOMOUS_INSTRUCTIONS = `PLAN EXECUTION MODE: Call get_plan before editing. Execute the first unfinished step only, following its file scope and acceptance criteria. Call update_plan(in_progress) before work, then verify_plan_step with a concise summary after implementing. The broker runs the approved checks; never substitute your own success claim. Continue to the next step after successful verification without asking for intermediate review. On ambiguity that changes scope or after two unsuccessful attempts at the same problem, call update_plan(blocked, reason) with attempts and the decision needed, notify orchestrator once, and stop work until a coordinator resolution. Do not change models. Send concise progress only at step completion, blockage and final delivery. Once all steps are verified call signal_done once, with changed files, verification results and remaining concerns; await explicit final review. On restart inspect files and durable plan state, do not replay completed steps.`;
