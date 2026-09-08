import { test, expect } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('MCP coordinator launches fixed-model worker with plan ready, verifies real edits and explicitly approves', async () => {
  const root = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), 'plan-mcp-'));
  const project = join(dir, 'project');
  mkdirSync(project); mkdirSync(join(dir, 'bin'));
  symlinkSync(process.execPath, join(dir, 'bin', 'bun'));
  const port = 18944;
  const env = { ...process.env, HOME: dir, PATH: `${join(dir, 'bin')}:/usr/bin:/bin`, MULTIAGENTS_PORT: String(port), MULTIAGENTS_DB: join(dir, 'broker.db') } as Record<string, string>;
  const script = `#!${process.execPath}
import { Client } from ${JSON.stringify(join(root, 'node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js'))};
import { StdioClientTransport } from ${JSON.stringify(join(root, 'node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js'))};
if (process.argv.includes('--version')) { console.log('fake agy 1.0'); process.exit(0); }
const client = new Client({name:'fake-worker',version:'1'});
const transport = new StdioClientTransport({command:process.execPath,args:[${JSON.stringify(join(root, 'server.ts'))},'--agent-type','agy'],env:process.env});
try {
await client.connect(transport);
const plan = await fetch('http://127.0.0.1:'+process.env.MULTIAGENTS_PORT+'/plan/get',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({session_id:process.env.MULTIAGENTS_SESSION})}).then(r=>r.json());
if (!plan.items.length || plan.items[0].assigned_to_slot !== Number(process.env.MULTIAGENTS_SLOT)) throw new Error('plan not assigned before launch');
const item_id=plan.items[0].id;
const outputs=[];
outputs.push(await client.callTool({name:'get_plan',arguments:{}}));
outputs.push(await client.callTool({name:'update_plan',arguments:{item_id,status:'in_progress'}}));
await Bun.write('result.txt','implemented');
outputs.push(await client.callTool({name:'verify_plan_step',arguments:{item_id,summary:'Created result.txt with required content'}}));
outputs.push(await client.callTool({name:'signal_done',arguments:{summary:'result.txt implemented and verified'}}));
await Bun.write('worker-report.json',JSON.stringify({argv:process.argv,outputs}));
} catch(e) { await Bun.write('worker-error.txt',String(e)); } finally {await client.close();}
`;
  writeFileSync(join(dir, 'bin', 'agy'), script, { mode: 0o755 });
  const broker = Bun.spawn([process.execPath, 'broker.ts'], { env, stdout: 'ignore', stderr: 'ignore' });
  const client = new Client({ name: 'test-coordinator', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(root, 'orchestrator/orchestrator-server.ts')], env, stderr: 'pipe' });
  const errors: string[] = [];
  transport.stderr?.on('data', data => errors.push(String(data)));
  try {
    for (let i = 0; i < 50; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch {} await Bun.sleep(20); }
    await client.connect(transport);
    const payload = { project_dir: project, session_name: 'MCP execution', execution_mode: 'plan_execution', agents: [{ agent_type: 'agy', name: 'Worker', role: 'Engineer', role_description: 'Implement plan', initial_task: 'Write result.txt', model_policy: { model: 'test-flash', auto_escalate: true } }], plan: [{ key: 'write', label: 'Write file', files: ['result.txt'], depends_on: [], acceptance: ['Content is implemented'], checks: [{ argv: [process.execPath, '-e', "if(await Bun.file('result.txt').text()!=='implemented')process.exit(1)"], cwd: '.' }] }] };
    const response = await client.callTool({ name: 'create_team', arguments: payload });
    expect(response.isError, JSON.stringify(response) + errors.join('')).not.toBe(true);
    for (let i = 0; i < 100; i++) { if (await Bun.file(join(project, 'worker-report.json')).exists() || await Bun.file(join(project, 'worker-error.txt')).exists()) break; await Bun.sleep(50); }
    expect(await Bun.file(join(project, 'worker-error.txt')).exists(), errors.join('') + (await Bun.file(join(project, 'worker-error.txt')).exists() ? await Bun.file(join(project, 'worker-error.txt')).text() : '')).toBe(false);
    expect(await Bun.file(join(project, 'worker-report.json')).exists(), JSON.stringify(response) + errors.join('')).toBe(true);
    const report = await Bun.file(join(project, 'worker-report.json')).json();
    expect(report.argv[report.argv.indexOf('--model') + 1]).toBe('test-flash');
    expect(report.outputs.every((r: any) => !r.isError), JSON.stringify(report)).toBe(true);
    const status = await client.callTool({ name: 'get_team_status', arguments: { session_id: 'mcp-execution' } });
    expect(JSON.stringify(status)).toContain('done_pending_review');
    const evidence = await client.callTool({ name: 'get_execution_plan', arguments: { session_id: 'mcp-execution' } });
    expect(JSON.stringify(evidence)).toContain('exit_code');
    expect(JSON.stringify(evidence)).toContain('log_path');
    const approval = await client.callTool({ name: 'approve_execution', arguments: { session_id: 'mcp-execution', message: 'Inspected result and recorded checks' } });
    expect(approval.isError, JSON.stringify(approval)).not.toBe(true);
    expect(JSON.stringify(approval)).toContain('approved');
  } finally { await client.close(); broker.kill(); await broker.exited; rmSync(dir, { recursive: true, force: true }); }
}, 20_000);
