import { describe, expect, it } from 'vitest';
import { Daytona } from '@daytona/sdk';
import { DaytonaWorldProvider } from '../src/world/daytona.js';
import { buildEnvironment, environmentArtifactName } from '../src/world/environment-build.js';
import type { World } from '../src/world/types.js';
import { liveEnabled } from './helpers/live-gate.js';

const live = liveEnabled() && !!process.env.DAYTONA_API_KEY;
describe.skipIf(!live)('Daytona live environments', () => {
  it.skipIf(process.env.KARMAX_DAYTONA_LIVE_BUILD !== '1')('builds a setup snapshot and launches it without resource overrides', async () => {
    const client = new Daytona();
    const projectId = `live-${Date.now()}`;
    const name = environmentArtifactName(projectId, 'fixture');
    let world: World | undefined;
    try {
      const built = await buildEnvironment({ provider: 'daytona', projectId, digest: 'fixture',
        spec: { image: 'node:22-slim', setup: ['echo snapshot-ready > /tmp/karmax-built'] } });
      expect(built.ref).toBe(name);
      world = await new DaytonaWorldProvider().create({ taskId: projectId, base: 'main',
        network: { unrestricted: true }, environment: { snapshot: built.ref }, resources: { cpu: 2, memoryMb: 2048 } });
      expect(await world.exec('cat', ['/tmp/karmax-built'])).toMatchObject({ code: 0, stdout: 'snapshot-ready\n' });
      expect(await world.exec('node', ['--version'])).toMatchObject({ code: 0, stdout: expect.stringMatching(/^v22\./) });
    } finally {
      try { await world?.destroy(); }
      finally {
        try {
          const snapshot = await client.snapshot.get(name).catch((error) => {
            if (!/not found|404/i.test(String(error))) throw error;
          });
          if (snapshot) await client.snapshot.delete(snapshot);
        } finally { await client[Symbol.asyncDispose](); }
      }
    }
  }, 600_000);

  it('launches an OCI image with the requested CPU and memory', async () => {
    const client = new Daytona();
    const taskId = `live-image-${Date.now()}`;
    let world: World | undefined;
    try {
      world = await new DaytonaWorldProvider().create({ taskId, base: 'main', network: { unrestricted: true },
        environment: { image: 'node:22-slim' }, resources: { cpu: 2, memoryMb: 2048 } });
      expect(await world.exec('node', ['--version'])).toMatchObject({ code: 0, stdout: expect.stringMatching(/^v22\./) });
      const found = [];
      for await (const sandbox of client.list({ labels: { karmaxTaskId: taskId } })) found.push(sandbox);
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({ cpu: 2, memory: 2 });
      await found[0]!.refreshActivity();
    } finally { try { await world?.destroy(); } finally { await client[Symbol.asyncDispose](); } }
  }, 600_000);
});
