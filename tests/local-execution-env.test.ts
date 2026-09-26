import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorktreeProvider } from '../src/world/worktree.js';
import { openLocalPty, startLocalProcess } from '../src/world/local-execution.js';

vi.mock('node-pty', () => ({ spawn: vi.fn(() => ({ onData: () => ({ dispose() {} }), onExit: () => ({ dispose() {} }), write() {}, resize() {}, kill() {} })) }));
afterEach(() => vi.unstubAllEnvs());
it('scrubs control-plane secrets from commands, processes and terminals (WD-28)', async () => {
  vi.stubEnv('KARMAX_VAULT_KEY', 'host-vault'); vi.stubEnv('E2B_API_KEY', 'host-provider');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-env-'));
  try {
    const world = await new WorktreeProvider(root).create({ taskId: 'env', base: 'main' });
    const script = 'console.log(JSON.stringify([process.env.KARMAX_VAULT_KEY,process.env.E2B_API_KEY,process.env.TASK_VALUE]))';
    const result = await world.exec('node', ['-e', script], { env: { TASK_VALUE: 'explicit' } });
    expect(JSON.parse(result.stdout)).toEqual([null, null, 'explicit']);
    const process = startLocalProcess(root, { command: `node -e '${script}'`, env: { TASK_VALUE: 'explicit' } });
    let output = '';
    process.onOutput(chunk => { output += chunk; });
    await new Promise(resolve => process.onExit(resolve));
    expect(JSON.parse(output)).toEqual([null, null, 'explicit']);
    await openLocalPty(root, { env: { TASK_VALUE: 'explicit' } });
    const pty = await import('node-pty');
    const env = vi.mocked(pty.spawn).mock.calls.at(-1)![2]!.env!;
    expect(env.KARMAX_VAULT_KEY).toBeUndefined(); expect(env.E2B_API_KEY).toBeUndefined();
    expect(env.TASK_VALUE).toBe('explicit');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
