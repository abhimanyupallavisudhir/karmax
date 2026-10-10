import { describe, expect, it } from 'vitest';
import { assertComputerFits, computerLimits, limitFromMessage, providerDefaults } from '../src/domain/computer-limits.js';
import { e2bFreeDiskMb, e2bTotalDiskGb } from '../src/world/e2b-template.js';
import { probeDaytonaLimits, probeE2BLimits } from '../src/world/provider-limits.js';

// The provider's own words when it refuses a size (checked live 2026-10-10:
// org_personal's E2B team and the production Daytona organization).
const E2B = {
  disk: "Minimum free disk can't be higher than 25600 MiB (if you need to increase this limit, please contact support)",
  memory: "Memory can't be higher than 8192 MiB (if you need to increase this limit, please contact support)",
  cpu: "CPU count can't be higher than 8 (if you need to increase this limit, please contact support)",
  schema: 'CPU count must be at most 32',
};
const DAYTONA = {
  disk: 'Disk request 100000GB exceeds maximum allowed per sandbox (10GB).\nNeed higher resource limits per-sandbox? Contact us at support@daytona.io and let us know about your use case.',
  memory: 'Memory request 100000GB exceeds maximum allowed per sandbox (8GB).\nNeed higher resource limits per-sandbox?',
  cpu: 'CPU request 32 exceeds maximum allowed per sandbox (4).\nNeed higher resource limits per-sandbox?',
};

describe('computer limits', () => {
  it('reads the limit out of each provider\'s refusal', () => {
    expect(limitFromMessage(E2B.disk)).toEqual({ dimension: 'disk', value: 25600, unit: 'MiB' });
    expect(limitFromMessage(E2B.memory)).toEqual({ dimension: 'memory', value: 8192, unit: 'MiB' });
    expect(limitFromMessage(E2B.cpu)).toEqual({ dimension: 'cpu', value: 8 });
    expect(limitFromMessage(E2B.schema)).toEqual({ dimension: 'cpu', value: 32 });
    expect(limitFromMessage(DAYTONA.disk)).toEqual({ dimension: 'disk', value: 10, unit: 'GB' });
    expect(limitFromMessage(DAYTONA.memory)).toEqual({ dimension: 'memory', value: 8, unit: 'GB' });
    expect(limitFromMessage(DAYTONA.cpu)).toEqual({ dimension: 'cpu', value: 4 });
    expect(limitFromMessage('Internal server error')).toBeUndefined();
  });

  it('shows E2B disk as the total a machine has, not the free space E2B counts', () => {
    // Measured live: the default template is 22 GB total; at a 25600 MiB
    // free-disk ceiling a machine is 29.1 GB total (df: 29841 MiB).
    expect(e2bTotalDiskGb(25_600)).toBe(29);
    expect(e2bFreeDiskMb(29)).toBeLessThanOrEqual(25_600);
    expect(e2bFreeDiskMb(29)).toBeGreaterThan(25_000);
    // The default template already has 22 GB: nothing to grow.
    expect(e2bFreeDiskMb(22)).toBeUndefined();
    expect(e2bFreeDiskMb(10)).toBeUndefined();
  });

  it('layers configured over measured over documented limits, and says where each came from', () => {
    expect(computerLimits('daytona')).toMatchObject({ cpu: 4, memoryMb: 8192, diskGb: 10,
      source: { cpu: 'default', memoryMb: 'default', diskGb: 'default' } });
    const measured = { cpu: 4, memoryMb: 8192, diskGb: 10, pool: { cpu: 10, memoryMb: 10_240, diskGb: 30 }, checkedAt: 5 };
    expect(computerLimits('daytona', measured, { diskGb: 25 })).toEqual({ cpu: 4, memoryMb: 8192, diskGb: 25,
      pool: { cpu: 10, memoryMb: 10_240, diskGb: 30 }, checkedAt: 5,
      source: { cpu: 'provider', memoryMb: 'provider', diskGb: 'configured' } });
    // A machine can never be bigger than the organization's whole pool.
    expect(computerLimits('daytona', measured, { diskGb: 50 })).toMatchObject({ diskGb: 30, source: { diskGb: 'provider' } });
    expect(computerLimits('daytona', { pool: { diskGb: 8 } })).toMatchObject({ diskGb: 8, source: { diskGb: 'provider' } });
    expect(computerLimits('e2b', { diskGb: 29, checkedAt: 1 })).toMatchObject({ diskGb: 29, source: { diskGb: 'provider' } });
    // Self-hosted computers have no provider account to limit them.
    expect(computerLimits('worktree')).toEqual({ source: {} });
    expect(providerDefaults('e2b')).toEqual({ cpu: 2, memoryMb: 2048, diskGb: 22 });
    expect(providerDefaults('daytona')).toMatchObject({ diskGb: 8 });
  });

  it('refuses a size above the account\'s limit up front, saying what is allowed', () => {
    const limits = computerLimits('e2b', { cpu: 8, memoryMb: 8192, diskGb: 29 });
    expect(() => assertComputerFits({ diskGb: 29, cpu: 8, memoryMb: 8192 }, limits, 'e2b')).not.toThrow();
    expect(() => assertComputerFits({ diskGb: 50 }, limits, 'e2b')).toThrow('Disk can be at most 29 GB on this E2B account');
    expect(() => assertComputerFits({ memoryMb: 16_384 }, limits, 'e2b')).toThrow('Memory can be at most 8 GB on this E2B account');
    expect(() => assertComputerFits({ cpu: 16 }, limits, 'e2b')).toThrow('CPU can be at most 8 on this E2B account');
    expect(() => assertComputerFits({ diskGb: 20 }, computerLimits('daytona', undefined, { diskGb: 15 }), 'daytona'))
      .toThrow('Disk can be at most 15 GB on this Daytona account');
    expect(() => assertComputerFits({ diskGb: 900 }, computerLimits('worktree'), 'worktree')).not.toThrow();
  });
});

type Call = { method: string; url: string; body?: any };
function fakeFetch(answer: (call: Call) => { status: number; body: unknown }) {
  const calls: Call[] = [];
  const fetch = async (url: string | URL, init?: RequestInit) => {
    const call = { method: init?.method ?? 'GET', url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    const { status, body } = answer(call);
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  };
  return { calls, fetch: fetch as typeof globalThis.fetch };
}

describe('provider limit probes', () => {
  it('learns an E2B account\'s ceilings from immediate refusals, building nothing', async () => {
    const { calls, fetch } = fakeFetch(({ body }) => ({ status: 400, body: { code: 400,
      message: body.minFreeDiskMb ? E2B.disk : body.memoryMB > 100_000 ? E2B.memory : E2B.cpu } }));
    const limits = await probeE2BLimits('e2b-key', { fetch, apiUrl: 'https://api.e2b.test', now: () => 7 });
    expect(limits).toEqual({ cpu: 8, memoryMb: 8192, diskGb: 29, checkedAt: 7 });
    expect(calls.every((call) => call.method === 'POST' && call.url === 'https://api.e2b.test/v3/templates')).toBe(true);
    // CPU is asked at the schema's own maximum, so the account's limit answers.
    expect(calls.map((call) => call.body.cpuCount)).toContain(32);
  });

  it('deletes anything an E2B probe was unexpectedly allowed to create', async () => {
    const { calls, fetch } = fakeFetch(({ method, body }) => method === 'DELETE' ? { status: 204, body: {} }
      : body?.cpuCount === 32 ? { status: 202, body: { templateID: 'tpl_probe', buildID: 'b1' } }
        : { status: 400, body: { message: body.minFreeDiskMb ? E2B.disk : E2B.memory } });
    expect(await probeE2BLimits('e2b-key', { fetch, apiUrl: 'https://api.e2b.test', now: () => 1 }))
      .toEqual({ cpu: 32, memoryMb: 8192, diskGb: 29, checkedAt: 1 });
    expect(calls).toContainEqual({ method: 'DELETE', url: 'https://api.e2b.test/templates/tpl_probe', body: undefined });
  });

  it('reads a Daytona organization\'s pool and per-sandbox maxima', async () => {
    const { calls, fetch } = fakeFetch(({ method, url, body }) => {
      if (url.endsWith('/api-keys/current')) return { status: 200, body: { name: 'k', organizationId: 'org-1' } };
      if (url.endsWith('/organizations/org-1/usage')) return { status: 200, body: { regionUsage: [
        { regionId: 'us', sandboxClass: 'windows', totalCpuQuota: 2, totalMemoryQuota: 8, totalDiskQuota: 30, maxDiskPerSandbox: 50 },
        { regionId: 'us', sandboxClass: 'container', totalCpuQuota: 10, totalMemoryQuota: 10, totalDiskQuota: 30,
          maxCpuPerSandbox: null, maxMemoryPerSandbox: null, maxDiskPerSandbox: null },
      ] } };
      if (method === 'POST') return { status: 400, body: { message: body.disk > 1000 ? DAYTONA.disk : body.memory > 1000 ? DAYTONA.memory : DAYTONA.cpu } };
      return { status: 404, body: {} };
    });
    const limits = await probeDaytonaLimits('dtn-key', { fetch, apiUrl: 'https://daytona.test/api', target: 'us', now: () => 9 });
    expect(limits).toEqual({ cpu: 4, memoryMb: 8192, diskGb: 10, pool: { cpu: 10, memoryMb: 10_240, diskGb: 30 }, checkedAt: 9 });
    expect(calls.filter((call) => call.method === 'POST').every((call) => call.body.buildInfo)).toBe(true);
  });

  it('keeps what it learned when part of a Daytona probe fails', async () => {
    const { fetch } = fakeFetch(({ method }) => method === 'POST'
      ? { status: 400, body: { message: DAYTONA.disk } } : { status: 401, body: { message: 'Invalid credentials' } });
    expect(await probeDaytonaLimits('dtn-key', { fetch, apiUrl: 'https://daytona.test/api', now: () => 3 }))
      .toEqual({ diskGb: 10, checkedAt: 3 });
  });
});
