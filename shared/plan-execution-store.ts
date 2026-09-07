import type { Database } from 'bun:sqlite';
import { join } from 'node:path';
import { runVerification, transitionExecutionStep, type ExecutionProgress } from './plan-execution.ts';

export interface StepRequest { session_id: string; item_id: number; slot_id?: number; peer_id?: string }
export class PlanExecutionStore {
  private active = new Map<number, AbortController>();
  cancelSession(sessionId: string) {
    const rows = this.db.query("SELECT pi.id FROM plan_items pi JOIN plans p ON pi.plan_id = p.id WHERE p.session_id = ?").all(sessionId) as { id: number }[];
    for (const row of rows) this.active.get(row.id)?.abort();
  }
  cancelAll() { for (const controller of this.active.values()) controller.abort(); }
  constructor(private db: Database) {
    const columns = db.query('PRAGMA table_info(plan_items)').all() as { name: string }[];
    if (!columns.some(c => c.name === 'execution')) db.run('ALTER TABLE plan_items ADD COLUMN execution TEXT');
    // A broker restart cannot establish the outcome of interrupted subprocesses.
    for (const row of db.query('SELECT id, execution FROM plan_items WHERE execution IS NOT NULL').all() as { id: number; execution: string }[]) {
      const step = JSON.parse(row.execution) as ExecutionProgress;
      if (step.verifying) this.save(row.id, { ...step, verifying: false, status: 'in_progress', results: [], blocker: 'Verification interrupted by broker restart; run verify_plan_step again.' });
    }
  }
  isExecution(sessionId: string): boolean {
    const row = this.db.query('SELECT config FROM sessions WHERE id = ?').get(sessionId) as { config: string } | null;
    return !!row && JSON.parse(row.config || '{}').execution_mode === 'plan_execution';
  }
  load(req: StepRequest, worker = true) {
    const row = this.db.query('SELECT pi.*, p.session_id FROM plan_items pi JOIN plans p ON p.id = pi.plan_id WHERE pi.id = ?').get(req.item_id) as any;
    if (!row || row.session_id !== req.session_id) throw new Error('Plan item does not belong to this session');
    if (!row.execution) throw new Error('Not an execution step');
    if (worker) {
      const session = this.db.query("SELECT status FROM sessions WHERE id = ?").get(req.session_id) as { status: string } | null;
      if (session?.status !== 'active') throw new Error('Execution session is paused or archived');
      const assigned = this.db.query("SELECT paused FROM slots WHERE id = ?").get(row.assigned_to_slot) as { paused: number } | null;
      if (assigned?.paused) throw new Error('Execution worker is paused');
      const peer = req.peer_id ? this.db.query('SELECT slot_id, session_id FROM peers WHERE id = ?').get(req.peer_id) as any : null;
      if (!peer || peer.session_id !== req.session_id || peer.slot_id !== row.assigned_to_slot) throw new Error('Only the assigned worker may update this step');
    }
    return { row, step: JSON.parse(row.execution) as ExecutionProgress };
  }
  all(sessionId: string): ExecutionProgress[] {
    return (this.db.query('SELECT pi.execution FROM plan_items pi JOIN plans p ON p.id = pi.plan_id WHERE p.session_id = ? ORDER BY pi.sort_order').all(sessionId) as { execution: string }[]).map(r => JSON.parse(r.execution));
  }
  save(id: number, step: ExecutionProgress) {
    this.db.run('UPDATE plan_items SET status = ?, execution = ?, completed_at = ? WHERE id = ?', [step.status, JSON.stringify(step), step.status === 'done' ? Date.now() : null, id]);
    this.db.run('UPDATE plans SET updated_at = ? WHERE id = (SELECT plan_id FROM plan_items WHERE id = ?)', [Date.now(), id]);
  }
  update(req: StepRequest & { status: string; reason?: string }) {
    const { row, step } = this.load(req);
    const next = transitionExecutionStep(step, req.status, this.all(req.session_id), req.reason);
    this.save(row.id, next);
    if (next.status === 'blocked') this.pause(row.assigned_to_slot);
  }
  private pause(slotId: number) {
    this.db.run('UPDATE slots SET paused = 1, paused_at = ? WHERE id = ?', [Date.now(), slotId]);
  }
  resolve(req: StepRequest & { from_id: string; decision: string; reopen?: boolean }) {
    if (req.from_id !== 'orchestrator') throw new Error('Only the coordinator can resolve a decision');
    if (typeof req.decision !== 'string' || !req.decision.trim()) throw new Error('Resolution must describe the decision');
    const { row, step } = this.load(req, false);
    if (req.reopen) {
      const rows = this.db.query('SELECT id, execution FROM plan_items WHERE plan_id = ? AND sort_order >= ? ORDER BY sort_order').all(row.plan_id, row.sort_order) as { id: number; execution: string }[];
      if (rows.some(r => JSON.parse(r.execution).verifying)) throw new Error('Wait for verification before reopening');
      this.db.transaction(() => {
        for (const r of rows) {
          const old = JSON.parse(r.execution) as ExecutionProgress;
          this.save(r.id, { ...old, status: 'pending', attempts: 0, results: [], summary: undefined, blocker: undefined, decision: r.id === row.id ? req.decision.slice(0, 4000) : undefined });
        }
        this.db.run("UPDATE slots SET task_state = 'addressing_feedback', paused = 0, paused_at = NULL WHERE id = ?", [row.assigned_to_slot]);
      })();
      return;
    }
    if (step.verifying || step.status === 'done' || (step.status !== 'blocked' && !step.decision_required)) throw new Error('No pending decision');
    this.save(row.id, { ...step, status: 'pending', attempts: 0, blocker: undefined, decision: req.decision.slice(0, 4000) });
    this.db.run('UPDATE slots SET paused = 0, paused_at = NULL WHERE id = ?', [row.assigned_to_slot]);
  }
  async verify(req: StepRequest & { summary: string }) {
    const { row, step } = this.load(req);
    if (step.status !== 'in_progress' || step.verifying) throw new Error('Start the step before verification; only one verification may run');
    transitionExecutionStep(step, 'in_progress', this.all(req.session_id));
    if (typeof req.summary !== 'string' || !req.summary.trim()) throw new Error('Provide implementation and acceptance evidence');
    this.save(row.id, { ...step, verifying: true, summary: req.summary.slice(0, 4000) });
    const session = this.db.query('SELECT project_dir FROM sessions WHERE id = ?').get(req.session_id) as { project_dir: string };
    let results: ExecutionProgress['results'] = [];
    let error: string | undefined;
    const controller = new AbortController();
    this.active.set(row.id, controller);
    try { results = await runVerification(step.checks, session.project_dir, join(session.project_dir, '.multiagents', 'verification', String(row.id)), controller.signal); }
    catch (e) { error = String(e); }
    finally { this.active.delete(row.id); }
    if (controller.signal.aborted) error = "Verification cancelled; run it again after resuming";
    // Deletion during a check must not resurrect the plan.
    const current = this.db.query('SELECT id FROM plan_items WHERE id = ?').get(row.id);
    if (!current) throw new Error('Plan deleted during verification');
    const success = !error && results.length === step.checks.length && results.every(r => r.exit_code === 0 && !r.timed_out);
    const attempts = success || controller.signal.aborted ? (step.attempts ?? 0) : (step.attempts ?? 0) + 1;
    const status = success ? 'done' : attempts >= 2 ? 'blocked' : 'in_progress';
    this.save(row.id, { ...step, status, attempts, verifying: false, results, summary: req.summary.slice(0, 4000), blocker: success ? undefined : error ?? 'Verification failed; inspect recorded logs. After two failures a coordinator decision is required.' });
    if (status === 'blocked') this.pause(row.assigned_to_slot);
  }
  assertComplete(sessionId: string) {
    const steps = this.all(sessionId);
    if (!steps.length || steps.some(s => !s || s.status !== 'done' || s.verifying)) throw new Error('All execution steps must pass verification before final review');
  }
}
