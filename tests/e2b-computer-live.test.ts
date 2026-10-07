import { describe, expect, it } from 'vitest';
import { liveEnabled } from './helpers/live-gate.js';
import { E2BWorldProvider } from '../src/world/e2b.js';
import { sizedTemplateName, DEFAULT_E2B_TEMPLATE } from '../src/world/e2b-template.js';

// E2B fixes CPU, memory and disk per template (features/computers). This proves
// the sized-template path on the real control plane: a Computer of 4 CPU, 4 GB
// and 30 GB of free disk builds `karmax-sized-…` from the default template and
// boots a sandbox that really is that size. Spends a template build (once per
// key; later runs reuse it) and one small sandbox for a minute.
describe.skipIf(!liveEnabled() || !process.env.E2B_API_KEY)('E2B computer sizes', () => {
  it('boots a world at the computer size it was asked for', async () => {
    const shape = { cpu: 4, memoryMb: 4096, diskGb: 30 };
    const world = await new E2BWorldProvider().create({ taskId: `computer-live-${Date.now()}`, base: 'main', resources: shape });
    try {
      expect(world.handle.warnings ?? []).toEqual([]);
      expect(world.handle.meta?.environmentArtifact).toBe(sizedTemplateName(DEFAULT_E2B_TEMPLATE, shape));
      const probe = await world.exec('bash', ['-lc', 'nproc; free -m | awk "/Mem:/{print \\$2}"; df -BG --output=avail / | tail -1']);
      const [cpus, memoryMb, freeDisk] = probe.stdout.trim().split('\n').map((line) => Number.parseInt(line, 10));
      expect(cpus).toBe(4);
      expect(memoryMb).toBeGreaterThan(3500);
      expect(freeDisk).toBeGreaterThanOrEqual(28);
    } finally { await world.destroy(); }
  }, 20 * 60_000);
});
