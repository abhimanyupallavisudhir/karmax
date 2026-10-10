import { describe, expect, it } from 'vitest';
import { liveEnabled } from './helpers/live-gate.js';
import { E2BWorldProvider } from '../src/world/e2b.js';
import { sizedTemplateName, DEFAULT_E2B_TEMPLATE } from '../src/world/e2b-template.js';
import { probeE2BLimits } from '../src/world/provider-limits.js';
import { checkWorldDisk } from '../src/world/disk.js';

// E2B fixes CPU, memory and disk per template (features/computers). This proves
// on the real control plane that karmax learns an account's limits without
// building anything, and that a Computer above the disk ceiling is built at it:
// `karmax-sized-…` from the default template, booted at that size, with the
// ballast that lets a full disk still start its agent. Spends a template build
// (once per key and shape; later runs reuse it) and one sandbox for a minute.
describe.skipIf(!liveEnabled() || !process.env.E2B_API_KEY)('E2B computer sizes', () => {
  it('learns the account\'s limits from immediate refusals, creating nothing', async () => {
    const limits = await probeE2BLimits(process.env.E2B_API_KEY!);
    console.log('E2B limits', JSON.stringify(limits));
    // org_personal's team (2026-10-10): 8 CPU, 8192 MiB, 25600 MiB free = 29 GB total.
    expect(limits.cpu).toBeGreaterThanOrEqual(2);
    expect(limits.memoryMb).toBeGreaterThanOrEqual(2048);
    expect(limits.diskGb).toBeGreaterThanOrEqual(22);
    const { Template } = await import('e2b');
    expect(await Template.exists('karmax-limits-probe', { apiKey: process.env.E2B_API_KEY })).toBe(false);
  }, 60_000);

  it('boots a world at the computer size it was asked for, its disk fitted to the account', async () => {
    const limits = await probeE2BLimits(process.env.E2B_API_KEY!);
    // 40 GB total is above some accounts' ceiling (29 GB on a Pro team): such
    // an account gets its ceiling and a warning saying so, never a failure.
    const shape = { cpu: 4, memoryMb: 4096, diskGb: 40 };
    const learned: unknown[] = [];
    const world = await new E2BWorldProvider(undefined, undefined, undefined, () => ({ provider: 'e2b', apiKey: process.env.E2B_API_KEY!,
      config: {}, recordLimits: async (value) => { learned.push(value); } })).create({ taskId: `computer-live-${Date.now()}`, base: 'main', resources: shape });
    try {
      const warnings = world.handle.warnings ?? [];
      console.log('warnings', JSON.stringify(warnings), 'learned', JSON.stringify(learned));
      const disk = Math.min(shape.diskGb, limits.diskGb!);
      if (disk < shape.diskGb) {
        expect(warnings).toEqual([`This E2B account allows at most ${disk} GB of disk, so this computer has 4 CPU · 4 GB · ${disk} GB disk, not 4 CPU · 4 GB · 40 GB disk.`]);
        expect(learned).toEqual([{ diskGb: disk }]);
      } else expect(warnings).toEqual([]);
      expect(world.handle.meta?.environmentArtifact).toBe(sizedTemplateName(DEFAULT_E2B_TEMPLATE, { ...shape, diskGb: disk }));
      const probe = await world.exec('bash', ['-lc', 'nproc; free -m | awk "/Mem:/{print \\$2}"']);
      const [cpus, memoryMb] = probe.stdout.trim().split('\n').map((line) => Number.parseInt(line, 10));
      expect(cpus).toBe(4);
      expect(memoryMb).toBeGreaterThan(3500);
      // Disk is the machine's total, as `df` shows it — and the guard keeps its ballast.
      const check = await checkWorldDisk(world);
      console.log('disk', JSON.stringify(check));
      expect(Math.round(check!.disk.totalKb / 2 ** 20)).toBe(disk);
      expect(check!.ballast).toBe('created');
      const ballast = await world.exec('bash', ['-lc', `stat -c %s ${world.handle.root}/.karmax-injection/ballast`]);
      expect(Number(ballast.stdout.trim())).toBe(512 * 2 ** 20);
    } finally { await world.destroy(); }
  }, 20 * 60_000);
});
