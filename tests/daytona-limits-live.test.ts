import { describe, expect, it } from 'vitest';
import { liveEnabled } from './helpers/live-gate.js';
import { probeDaytonaLimits } from '../src/world/provider-limits.js';

// Daytona refuses a size above an organization's per-sandbox maximum at once
// (400 "Disk request 12GB exceeds maximum allowed per sandbox (10GB)") and
// reports its tier pool in /organizations/<id>/usage (features/computers).
describe.skipIf(!liveEnabled() || !process.env.DAYTONA_API_KEY)('Daytona computer limits', () => {
  it('learns the organization\'s per-sandbox maxima and tier pool, creating nothing', async () => {
    const limits = await probeDaytonaLimits(process.env.DAYTONA_API_KEY!, { apiUrl: process.env.DAYTONA_API_URL });
    console.log('Daytona limits', JSON.stringify(limits));
    // Production's organization (2026-10-10): 4 vCPU / 8 GiB / 10 GiB per sandbox; Tier 1 pool 10 / 10 GiB / 30 GiB.
    expect(limits.cpu).toBeGreaterThanOrEqual(1);
    expect(limits.memoryMb).toBeGreaterThanOrEqual(1024);
    expect(limits.diskGb).toBeGreaterThanOrEqual(3);
    expect(limits.pool?.diskGb).toBeGreaterThanOrEqual(limits.diskGb!);
    const listed = await fetch(`${process.env.DAYTONA_API_URL ?? 'https://app.daytona.io/api'}/sandbox?labels=${encodeURIComponent(JSON.stringify({ karmaxProbe: 'limits' }))}`,
      { headers: { Authorization: `Bearer ${process.env.DAYTONA_API_KEY}` } });
    expect((await listed.json() as { items: unknown[] }).items).toEqual([]);
  }, 60_000);
});
