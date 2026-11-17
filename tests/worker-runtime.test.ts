import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';

// wiki ops/ci "Temporal dev server gone mid-shard": after one test file lost its
// server, every later file in the same process failed "Runtime singleton has
// already been installed", because another copy of src/temporal/worker.ts had
// installed the process's one Runtime. A worker must use the Runtime it finds.
it('starts a worker in a process whose Temporal Runtime another module copy installed', () => {
  const worker = new URL('../src/temporal/worker.ts', import.meta.url).href;
  const code = `
    import { Runtime, DefaultLogger } from '@temporalio/worker';
    Runtime.install({ logger: new DefaultLogger('WARN') });
    const { makeWorker } = await import(${JSON.stringify(worker)});
    try {
      await makeWorker({ address: '127.0.0.1:1', namespace: 'default' });
      console.log('RESULT connected');
    } catch (error) {
      console.log('RESULT ' + error.name + ': ' + error.message.split('\\n')[0]);
    }
  `;
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code],
    { encoding: 'utf8', timeout: 60_000, cwd: new URL('..', import.meta.url).pathname });
  const line = result.stdout.split('\n').find((l) => l.startsWith('RESULT ')) ?? `no result: ${result.stderr.slice(-500)}`;
  // The worker gets past the Runtime to the (unreachable) server.
  expect(line).not.toMatch(/IllegalStateError|Runtime singleton/);
  expect(line).toMatch(/^RESULT \w*Error/);
}, 90_000);
