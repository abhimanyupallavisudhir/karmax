import { describe, expect, it } from 'vitest';
import { applyComputer, assertInFlightComputerEdit, computerConfig, computerOf, describeMachine, machineShape,
  normalizeComputer, sameMachine } from '../src/domain/computer.js';

describe('computer value', () => {
  it('round-trips between the form value and the execution config', () => {
    const spec = { provider: 'e2b', cpu: 4, memoryMb: 8192, diskGb: 50, flavor: 'desktop' as const, hibernateAfterDays: 3,
      network: { unrestricted: false, allowDomains: ['pypi.org'], allowCidrs: [] } };
    const config = computerConfig(spec);
    expect(config).toEqual({ worldProvider: 'e2b', resources: { cpu: 4, memoryMb: 8192, diskGb: 50 },
      environment: { flavor: 'desktop' }, hibernateAfterMs: 3 * 86_400_000, network: spec.network });
    expect(computerOf(config)).toEqual(spec);
  });

  it('layers a sparse task override onto the project config without dropping inherited keys', () => {
    const project = { worldProvider: 'e2b', resources: { cpu: 2, memoryMb: 2048, gpu: 0 },
      environment: { flavor: 'headless' as const, template: 'custom' }, network: { unrestricted: true }, hibernateAfterMs: 604_800_000 };
    expect(applyComputer(project, { diskGb: 40, flavor: 'desktop' })).toEqual({ ...project,
      resources: { cpu: 2, memoryMb: 2048, gpu: 0, diskGb: 40 }, environment: { flavor: 'desktop', template: 'custom' } });
    expect(applyComputer(project, undefined)).toBe(project);
  });

  it('validates what people type and drops what it does not know', () => {
    expect(normalizeComputer({ cpu: '4', memoryMb: 4096, diskGb: '', extra: 1 })).toEqual({ cpu: 4, memoryMb: 4096 });
    expect(normalizeComputer({})).toBeUndefined();
    expect(normalizeComputer(null)).toBeUndefined();
    expect(() => normalizeComputer({ cpu: 0 })).toThrow(/CPU must be a whole number from 1/);
    expect(() => normalizeComputer({ diskGb: 1.5 })).toThrow(/Disk/);
    expect(() => normalizeComputer({ flavor: 'gui' })).toThrow(/experience/);
    expect(() => normalizeComputer({ provider: 'E2B; rm' })).toThrow(/provider/);
    expect(normalizeComputer({ network: { unrestricted: false, allowDomains: [' a.com ', ''] } }))
      .toEqual({ network: { unrestricted: false, allowDomains: ['a.com'], allowCidrs: [] } });
  });

  it('compares machines against the default size', () => {
    expect(sameMachine({}, { cpu: 2, memoryMb: 2048 })).toBe(true);
    expect(sameMachine({ cpu: 2 }, { cpu: 2, diskGb: 30 })).toBe(false);
    expect(machineShape({ resources: { cpu: 4, gpu: 0 } })).toEqual({ cpu: 4 });
    expect(describeMachine({ cpu: 4, memoryMb: 6144, diskGb: 50 })).toBe('4 CPU · 6 GB · 50 GB disk');
    expect(describeMachine({ memoryMb: 1536 })).toBe('2 CPU · 1.5 GB');
  });

  it('lets a running task resize but not become a different computer', () => {
    const current = { provider: 'e2b', cpu: 2, flavor: 'headless' as const };
    expect(() => assertInFlightComputerEdit(current, { provider: 'e2b', cpu: 8, diskGb: 40, hibernateAfterDays: 1 })).not.toThrow();
    expect(() => assertInFlightComputerEdit(current, { provider: 'daytona' })).toThrow(/provider/);
    expect(() => assertInFlightComputerEdit(current, { flavor: 'desktop' })).toThrow(/experience/);
    expect(() => assertInFlightComputerEdit(current, { network: { unrestricted: false, allowDomains: [], allowCidrs: [] } })).toThrow(/network/);
    expect(() => assertInFlightComputerEdit(current, { network: { unrestricted: true } })).not.toThrow();
  });
});
