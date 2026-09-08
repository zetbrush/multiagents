import { test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const dir = mkdtempSync(join(tmpdir(), 'execution-broker-'));
const port = 18943;
let proc: ReturnType<typeof Bun.spawn>;
const post = async (path: string, body: any) => {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
  return { status: response.status, data: await response.json() as any };
};
async function start() {
  proc = Bun.spawn([process.execPath, 'broker.ts'], { env: { ...process.env, MULTIAGENTS_PORT: String(port), MULTIAGENTS_DB: join(dir, 'db.sqlite') }, stdout: 'ignore', stderr: 'ignore' });
  for (let i = 0; i < 50; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) return; } catch {} await Bun.sleep(20); }
  throw new Error('broker startup failed');
}
beforeAll(start);
afterAll(async () => { proc.kill(); await proc.exited; rmSync(dir, { recursive: true, force: true }); });
async function setup(check = 'process.exit(0)', decision?: string) {
  const session_id = crypto.randomUUID();
  await post('/sessions/create', { id: session_id, name: session_id, project_dir: dir, config: { execution_mode: 'plan_execution' } });
  const slot = (await post('/slots/create', { session_id, agent_type: 'agy', role: 'Engineer' })).data;
  const peer = (await post('/register', { session_id, slot_id: slot.id, agent_type: 'agy', pid: 99999999, cwd: dir, summary: 'Starting', git_root: null, tty: null })).data;
  const plan = (await post('/plan/create', { session_id, title: 'Execute', items: [{ label: 'Implement', assigned_to_slot: slot.id, execution: { key: 'impl', label: 'Implement', files: ['src/**'], depends_on: [], acceptance: ['works'], checks: [{ argv: [process.execPath, '-e', check], cwd: '.', timeout_ms: 1000 }], decision_required: decision } }] })).data;
  return { session_id, item_id: plan.items[0].id, slot_id: slot.id, peer_id: peer.id ?? peer.peer?.id };
}

test('broker enforces transitions, records verification and persists completed work across restart', async () => {
  const req = await setup();
  expect((await post('/plan/update-item', { ...req, status: 'done' })).status).not.toBe(200);
  expect((await post('/plan/update-item', { ...req, session_id: 'wrong', status: 'in_progress' })).status).not.toBe(200);
  expect((await post('/plan/update-item', { ...req, status: 'in_progress' })).status).toBe(200);
  const verified = await post('/plan/verify', { ...req, summary: 'Implemented and ready' });
  expect(verified.status).toBe(200);
  expect(verified.data.items[0].status).toBe('done');
  expect(verified.data.items[0].execution.results[0].exit_code).toBe(0);
  proc.kill(); await proc.exited; await start();
  expect((await post('/plan/get', req)).data.items[0].status).toBe('done');
});

test('two failures block work until coordinator resolves and worker cannot bypass it', async () => {
  const req = await setup('process.exit(2)');
  await post('/plan/update-item', { ...req, status: 'in_progress' });
  expect((await post('/plan/verify', { ...req, summary: 'attempt one' })).data.items[0].status).toBe('in_progress');
  expect((await post('/plan/verify', { ...req, summary: 'attempt two' })).data.items[0].status).toBe('blocked');
  expect((await post('/plan/update-item', { ...req, status: 'in_progress' })).status).not.toBe(200);
  expect((await post('/plan/resolve', { ...req, decision: 'Try again', from_id: req.peer_id })).status).not.toBe(200);
  expect((await post('/plan/resolve', { ...req, decision: 'Try again', from_id: 'orchestrator' })).status).toBe(200);
  expect((await post('/plan/get', req)).data.items[0].status).toBe('pending');
});

test('decision gates and premature final completion are enforced', async () => {
  const req = await setup('process.exit(0)', 'Choose migration strategy');
  expect((await post('/plan/update-item', { ...req, status: 'in_progress' })).status).not.toBe(200);
  expect((await post('/lifecycle/signal-done', { session_id: req.session_id, peer_id: req.peer_id, summary: 'done' })).status).not.toBe(200);
  expect((await post('/plan/resolve', { ...req, decision: 'Use additive migration', from_id: 'orchestrator' })).status).toBe(200);
  expect((await post('/plan/update-item', { ...req, status: 'in_progress' })).status).toBe(200);
});

test('final review cannot self-approve and corrections invalidate verified work', async () => {
  const req = await setup();
  await post('/plan/update-item', { ...req, status: 'in_progress' });
  await post('/plan/verify', { ...req, summary: 'implemented' });
  expect((await post('/lifecycle/signal-done', { ...req, summary: 'ready for review' })).data.task_state).toBe('done_pending_review');
  expect((await post('/lifecycle/approve', { ...req, target_slot_id: req.slot_id })).status).not.toBe(200);
  const reopen = await post('/plan/resolve', { ...req, from_id: 'orchestrator', reopen: true, decision: 'Fix edge case' });
  expect(reopen.status).toBe(200);
  expect(reopen.data.items[0].status).toBe('pending');
  expect((await post('/lifecycle/approve', { ...req, peer_id: 'orchestrator', target_slot_id: req.slot_id })).status).not.toBe(200);
  await post('/plan/update-item', { ...req, status: 'in_progress' });
  await post('/plan/verify', { ...req, summary: 'fixed edge case' });
  await post('/lifecycle/signal-done', { ...req, summary: 'corrected and verified' });
  expect((await post('/lifecycle/approve', { ...req, peer_id: 'orchestrator', target_slot_id: req.slot_id })).data.task_state).toBe('approved');
});

test('legacy lifecycle routes cannot approve or release unfinished execution work', async () => {
  const req = await setup();
  expect((await post('/slots/update', { id: req.slot_id, task_state: 'approved' })).status).not.toBe(200);
  expect((await post('/lifecycle/approve', { ...req, session_id: 'wrong', target_slot_id: req.slot_id })).status).not.toBe(200);
  expect((await post('/lifecycle/release', { ...req, target_slot_id: req.slot_id, released_by: 'orchestrator' })).status).not.toBe(200);
});

test('abrupt broker death terminates checks and interrupted verification never counts as success', async () => {
  const marker = join(dir, 'orphan-marker');
  const req = await setup(`setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'orphan'), 600); setInterval(()=>{},1000)`);
  await post('/plan/update-item', { ...req, status: 'in_progress' });
  const pending = post('/plan/verify', { ...req, summary: 'long check' }).catch(() => null);
  await Bun.sleep(120);
  proc.kill('SIGKILL'); await proc.exited; await pending;
  await start();
  const item = (await post('/plan/get', req)).data.items[0];
  expect(item.status).not.toBe('done');
  expect(item.execution.verifying).toBe(false);
  await Bun.sleep(650);
  expect(await Bun.file(marker).exists()).toBe(false);
});

test('disconnect preserves model and original task for later resume', async () => {
  const req = await setup();
  const optimization = { model: 'fixed-flash', auto_escalate: false, tier: 'balanced' };
  await post('/slots/update', { id: req.slot_id, context_snapshot: JSON.stringify({ optimization, original_task: 'Important task' }) });
  await post('/plan/update-item', { ...req, status: 'in_progress' });
  await post('/plan/verify', { ...req, summary: 'done' });
  await post('/lifecycle/signal-done', { ...req, summary: 'review' });
  await post('/lifecycle/approve', { ...req, peer_id: 'orchestrator', target_slot_id: req.slot_id });
  await post('/lifecycle/release', { ...req, target_slot_id: req.slot_id, released_by: 'orchestrator' });
  await post('/unregister', { id: req.peer_id });
  const slot = (await post('/slots/get', { id: req.slot_id })).data;
  expect(JSON.parse(slot.context_snapshot).optimization.model).toBe('fixed-flash');
  expect(JSON.parse(slot.context_snapshot).original_task).toBe('Important task');
});

test('Antigravity terminal usage is recorded before exit and accumulated across processes', async () => {
  const { monitorProcess } = await import('../orchestrator/monitor.ts');
  const { BrokerClient } = await import('../shared/broker-client.ts');
  const req = await setup();
  const client = new BrokerClient(`http://127.0.0.1:${port}`);
  for (let i = 0; i < 2; i++) {
    const event = { event: 'result', result: { status: 'SUCCESS', response: 'complete', usage: { input_tokens: 100, output_tokens: 20, cache_read_tokens: 40 } } };
    const child = Bun.spawn([process.execPath, '-e', `process.stdout.write(${JSON.stringify(JSON.stringify(event))})`], { stdout: 'pipe', stderr: 'pipe' });
    await new Promise<void>(resolve => monitorProcess(child, req.slot_id, req.session_id, client, event => { if (event.type === 'agent_completed') resolve(); }));
  }
  const slot = await client.getSlot(req.slot_id);
  expect(slot.input_tokens).toBe(200);
  expect(slot.output_tokens).toBe(40);
  expect(slot.cache_read_tokens).toBe(80);
});

test('pausing a session cancels its running verification without counting a failed implementation attempt', async () => {
  const marker = join(dir, 'cancelled-marker');
  const req = await setup(`setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'late'), 500); setInterval(()=>{},1000)`);
  await post('/plan/update-item', { ...req, status: 'in_progress' });
  const verifying = post('/plan/verify', { ...req, summary: 'running' });
  await Bun.sleep(100);
  await post('/sessions/update', { id: req.session_id, status: 'paused' });
  await verifying;
  await Bun.sleep(550);
  expect(await Bun.file(marker).exists()).toBe(false);
  const state = (await post('/plan/get', req)).data.items[0];
  expect(state.status).not.toBe('done');
  expect(state.execution.attempts).toBe(0);
  expect((await post('/plan/verify', { ...req, summary: 'retry while paused' })).status).not.toBe(200);
});
