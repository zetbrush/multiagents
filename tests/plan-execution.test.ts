import { test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateExecutionPlan, transitionExecutionStep, runVerification } from '../shared/plan-execution.ts';

const step = (key = 'one') => ({ key, label: key, files: ['src/**'], depends_on: [], acceptance: ['Works'], checks: [{ argv: [process.execPath, '-e', 'console.log("verified")'], cwd: '.', timeout_ms: 1000 }] });

test('rejects duplicate, missing, cyclic and out-of-order dependencies before execution', () => {
  expect(() => validateExecutionPlan([step(), step()])).toThrow();
  expect(() => validateExecutionPlan([{ ...step(), depends_on: ['missing'] }])).toThrow();
  expect(() => validateExecutionPlan([{ ...step('a'), depends_on: ['b'] }, { ...step('b'), depends_on: ['a'] }])).toThrow();
  expect(() => validateExecutionPlan([{ ...step(), checks: [] }])).toThrow();
  expect(() => validateExecutionPlan([{ ...step(), checks: [{ argv: [], cwd: '.' }] }])).toThrow();
  expect(() => validateExecutionPlan([step(), { ...step('two'), depends_on: ['one'] }])).not.toThrow();
});

test('cannot skip preceding work, decision gate or complete without verification', () => {
  const first = { ...step(), status: 'pending' as const };
  const second = { ...step('two'), status: 'pending' as const };
  expect(() => transitionExecutionStep(second, 'in_progress', [first, second])).toThrow();
  expect(() => transitionExecutionStep({ ...first, decision_required: 'Confirm migration' }, 'in_progress', [first])).toThrow();
  expect(() => transitionExecutionStep(first, 'done', [first])).toThrow();
  expect(transitionExecutionStep(first, 'in_progress', [first]).status).toBe('in_progress');
});

test('verification records actual exit codes and bounded logs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'plan-check-'));
  try {
    const ok = await runVerification(step().checks, dir, join(dir, 'logs'));
    expect(ok[0]!.exit_code).toBe(0);
    expect(await Bun.file(ok[0]!.log_path).text()).toContain('verified');
    const fail = await runVerification([{ argv: [process.execPath, '-e', 'process.exit(3)'], cwd: '.' }], dir, join(dir, 'logs'));
    expect(fail[0]!.exit_code).toBe(3);
    const timeout = await runVerification([{ argv: [process.execPath, '-e', 'setInterval(()=>{},1000)'], cwd: '.', timeout_ms: 30 }], dir, join(dir, 'logs'));
    expect(timeout[0]!.timed_out).toBe(true);
    expect(timeout[0]!.exit_code).not.toBe(0);
    await expect(runVerification([{ argv: ['true'], cwd: '..' }], dir, join(dir, 'logs'))).rejects.toThrow();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
