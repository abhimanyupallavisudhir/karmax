import { describe, it, expect } from 'vitest';
import { PackageStore, livePinnedRefs } from '../src/packages/store.js';
import { safeParseManifest, parseManifest } from '../src/packages/schema.js';
import { manifest as bundled } from '../src/contrib/manifests.js';
import { TaskRecord, TaskStatus } from '../src/domain/types.js';

const task = (over: { workflow?: string; executionWorkflow?: string; workflowVersion?: string; status?: TaskStatus }): TaskRecord =>
  ({
    id: 't', projectId: 'p', listId: 'l', title: 't',
    workflow: over.workflow ?? 'software-dev', workflowVersion: over.workflowVersion ?? '1.0.0',
    ...(over.executionWorkflow ? { executionWorkflow: over.executionWorkflow } : {}),
    params: {}, createdAt: 0, order: 0,
    lastView: over.status ? ({ status: over.status } as TaskRecord['lastView']) : undefined,
  } as TaskRecord);

const valid = () => ({
  name: 'demo', version: '1.0.0', description: 'x', requires: [], events: [], capabilities: [], ui: [], commands: [], params: [],
  roles: [{ name: 'do', label: 'Do', promptTemplate: '{{prompt}}', capabilities: ['signal-completion'] }],
  stages: [{ key: 'setup', label: 'Setup' }, { key: 'done', label: 'End' }],
});

describe('manifest schema (PLAN 21a — verify a package before trusting it)', () => {
  it('accepts the real bundled manifests', () => {
    expect(() => parseManifest(bundled('software-dev'))).not.toThrow();
    expect(() => parseManifest(bundled('merge-only'))).not.toThrow();
  });
  it('accepts a manifest declaring the new ownership fields', () => {
    const r = safeParseManifest(valid());
    expect(r.ok).toBe(true);
  });
  it('rejects malformed manifests with a helpful error', () => {
    expect(safeParseManifest({ ...valid(), version: undefined })).toMatchObject({ ok: false });
    expect((safeParseManifest({ ...valid(), version: undefined }) as any).error).toMatch(/version/);
    expect((safeParseManifest({ ...valid(), name: '' }) as any).error).toMatch(/name/);
    // a role missing its prompt template is rejected
    const badRole = { ...valid(), roles: [{ name: 'do', label: 'Do' }] };
    expect(safeParseManifest(badRole).ok).toBe(false);
  });
});

describe('PackageStore (name@version resolution)', () => {
  it('seeds from the bundled workflows and resolves them', () => {
    const store = PackageStore.withBundled();
    const names = new Set(store.list().map((p) => p.name));
    expect(names).toEqual(new Set(['software-dev', 'just-do', 'script-exec', 'goal', 'merge-only', 'merge-queue', 'agent-queue', 'account-coordinator']));
    expect(store.resolve('software-dev')!.version).toBe('1.9.0');
    expect(store.resolve('just-do')!.version).toBe('1.3.0');
    expect(store.resolve('merge-only')!.version).toBe('1.5.0');
    expect(store.resolve('software-dev', '1.0.0')!.name).toBe('software-dev');
    expect(store.resolve('nope')).toBeUndefined();
    expect(store.resolve('software-dev', '9.9.9')).toBeUndefined();
  });

  it('pins by version and returns the latest when unspecified', () => {
    const store = PackageStore.withBundled();
    store.register({ ...bundled('software-dev'), version: '1.10.0', description: 'newer' });
    store.register({ ...bundled('software-dev'), version: '1.2.0', description: 'mid' });
    expect(store.versions('software-dev')).toEqual(['1.0.0', '1.1.0', '1.2.0', '1.3.0', '1.4.0', '1.5.0', '1.6.0', '1.7.0', '1.8.0', '1.9.0', '1.10.0']); // numeric, not lexical
    expect(store.resolve('software-dev')!.version).toBe('1.10.0'); // latest
    expect(store.resolve('software-dev', '1.0.0')!.description).not.toBe('newer'); // old version intact
  });

  it('rejects a malformed package without registering it', () => {
    const store = PackageStore.withBundled();
    const before = store.list().length;
    const r = store.tryRegister({ name: 'broken' }); // missing required fields
    expect(r.ok).toBe(false);
    expect(store.list().length).toBe(before);
  });
});

describe('version retirement (§21c — never drop code a live execution replays)', () => {
  it('livePinnedRefs tracks only non-terminal executions', () => {
    const refs = livePinnedRefs([
      task({ status: 'active', workflowVersion: '1.0.0' }),
      task({ status: 'waiting', workflow: 'goal', workflowVersion: '2.0.0' }),
      task({ status: 'active', workflow: 'goal', executionWorkflow: 'software-dev', workflowVersion: '1.3.0' }),
      task({ status: 'done', workflowVersion: '0.9.0' }), // terminal → not pinned
      task({ status: 'cancelled', workflowVersion: '0.8.0' }),
    ]);
    expect(refs).toEqual(new Set(['software-dev@1.0.0', 'goal@2.0.0', 'software-dev@1.3.0']));
  });

  it('refuses to retire a version a live execution is pinned to, but allows it once drained', () => {
    const store = PackageStore.withBundled();
    store.register({ ...bundled('goal'), version: '2.0.0' });

    const live = livePinnedRefs([task({ workflow: 'goal', workflowVersion: '1.0.0', status: 'active' })]);
    expect(() => store.retire('goal', '1.0.0', live)).toThrow(/live execution/);
    expect(store.versions('goal')).toContain('1.0.0'); // still registered

    // a newer version with no live executions retires freely
    expect(store.retire('goal', '2.0.0', live)).toBe(true);
    expect(store.versions('goal')).toEqual(['1.0.0', '1.1.0', '1.2.0', '1.3.0', '1.4.0', '1.5.0', '1.6.0', '1.7.0', '1.8.0', '1.9.0']);

    // once the execution drains (done), the old version can be retired too.
    // Driven off the registered list rather than a hand-written ladder, so
    // bundling a new goal version doesn't silently go stale here.
    const drained = livePinnedRefs([task({ workflow: 'goal', workflowVersion: '1.0.0', status: 'done' })]);
    const [oldest, ...rest] = store.versions('goal');
    expect(store.retire('goal', oldest!, drained)).toBe(true);
    expect(store.resolve('goal')?.version).toBe(rest.at(-1)); // latest survives
    for (const v of rest) expect(store.retire('goal', v, drained)).toBe(true);
    expect(store.resolve('goal')).toBeUndefined();
  });

  it('retire returns false for an unknown version', () => {
    const store = PackageStore.withBundled();
    expect(store.retire('software-dev', '9.9.9')).toBe(false);
  });
});

/**
 * A sub-task's child workflow used to be selected by a hand-maintained chain of
 * `behaviorVersion === '1.x.0'` arms. Releasing a version without extending it
 * silently dropped every child of that version to the bare (v1.1) type — no
 * error, just a child running years-old semantics. This pins the rule instead.
 */
describe('sub-task children inherit their parent version', () => {
  it('resolves to the parent version from 1.5.0 on, and that type is registered', async () => {
    const { childWorkflowType } = await import('../src/workflows/software-dev.js');
    const { BUNDLED_QUALIFIED } = await import('../src/workflows/names.js');

    // Historical parents keep the bare type their recorded command replays.
    for (const old of ['1.0.0', '1.1.0', '1.2.0', '1.3.0', '1.4.0'] as const)
      expect(childWorkflowType(old)).toBe('softwareDev');
    for (const current of ['1.5.0', '1.6.0', '1.7.0', '1.8.0', '1.9.0'] as const)
      expect(childWorkflowType(current)).toBe(`softwareDev@${current}`);

    // The current bundled version must be inheritable AND registered, or its
    // sub-tasks fail to start at all.
    const version = bundled('software-dev')!.version;
    expect(childWorkflowType(version as '1.8.0')).toBe(`softwareDev@${version}`);
    expect(BUNDLED_QUALIFIED.has(`softwareDev@${version}`)).toBe(true);
  });
});
