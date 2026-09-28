import { describe, it, expect } from 'vitest';
import { reviewCheckouts, allCheckoutsApproved, approveAll } from '../src/domain/checkouts.js';
import { runTurn } from '../src/agent/runtime.js';
import { MockAdapter } from '../src/agent/mock.js';
import { WorldRepo } from '../src/world/types.js';

/**
 * Review approval for a multi-PR task (SPEC §11.1, PLAN-multi-pr.md §3).
 *
 * The gate stays singular — one Do agent, one Review, one Merge — but a human
 * may approve branches ONE AT A TIME, so they can confirm what is finished and
 * send a follow-up about what is not. The property that makes that safe is that
 * an approval is bound to `(checkout, head sha)`: if the Do agent touches an
 * approved branch afterwards, its approval lapses and has to be given again.
 * Otherwise "confirm these three" would silently keep approving work nobody
 * looked at.
 */

const repo = (name: string, branch: string, base = 'main'): WorldRepo =>
  ({ name, repo: '/src/alpha', root: `/w/${name}`, branch, base, target: 'main' });

const REPOS = [repo('alpha', 'tavya/t'), repo('docs', 'tavya/t-docs')];

describe('per-checkout review approval', () => {
  it('reports each checkout with its head and approval state', () => {
    const view = reviewCheckouts(REPOS, { alpha: 'aaa', docs: 'bbb' }, { alpha: 'aaa' }, []);
    expect(view.map((c) => [c.name, c.branch, c.head, c.approved])).toEqual([
      ['alpha', 'tavya/t', 'aaa', true],
      ['docs', 'tavya/t-docs', 'bbb', false],
    ]);
  });

  it('is not satisfied until every checkout is approved', () => {
    const heads = { alpha: 'aaa', docs: 'bbb' };
    expect(allCheckoutsApproved(REPOS, heads, { alpha: 'aaa' })).toBe(false);
    expect(allCheckoutsApproved(REPOS, heads, { alpha: 'aaa', docs: 'bbb' })).toBe(true);
  });

  it('lapses an approval when that branch moves, and keeps the others', () => {
    // Approve both, then the Do agent pushes another commit to `docs` only.
    const approvals = approveAll(REPOS, { alpha: 'aaa', docs: 'bbb' }, {});
    const moved = { alpha: 'aaa', docs: 'ccc' };

    expect(allCheckoutsApproved(REPOS, moved, approvals)).toBe(false);
    const after = reviewCheckouts(REPOS, moved, approvals, []);
    expect(after.find((c) => c.name === 'alpha')!.approved).toBe(true);   // untouched, still approved
    expect(after.find((c) => c.name === 'docs')!.approved).toBe(false);   // moved, must be re-reviewed
  });

  it('treats an unknown head as unapproved rather than approved by default', () => {
    // A head we could not read must never pass the gate by omission.
    expect(allCheckoutsApproved(REPOS, { alpha: 'aaa' }, { alpha: 'aaa', docs: 'bbb' })).toBe(false);
    expect(reviewCheckouts(REPOS, {}, { alpha: 'aaa' }, [])[0]!.approved).toBe(false);
  });

  it('a single Confirm approves every checkout at its current head', () => {
    const heads = { alpha: 'aaa', docs: 'bbb' };
    expect(allCheckoutsApproved(REPOS, heads, approveAll(REPOS, heads, {}))).toBe(true);
  });

  it('carries each checkout\'s pull request onto its row', () => {
    const prs = [{ repo: 'docs', slug: 'o/r', number: 7, url: 'u', state: 'open' as const }];
    const view = reviewCheckouts(REPOS, { alpha: 'aaa', docs: 'bbb' }, {}, prs);
    expect(view.find((c) => c.name === 'docs')!.pr?.number).toBe(7);
    expect(view.find((c) => c.name === 'alpha')!.pr).toBeUndefined();
  });

  it('marks a checkout stacked on a sibling so review can show the stack', () => {
    const stacked = [REPOS[0]!, repo('api', 'tavya/t-api', 'tavya/t')];
    const view = reviewCheckouts(stacked, {}, {}, []);
    expect(view.find((c) => c.name === 'api')!.stackedOn).toBe('alpha');
    expect(view.find((c) => c.name === 'alpha')!.stackedOn).toBeUndefined();
  });
});

describe('who may add a branch', () => {
  const adapters = new Map<any, any>([['mock', new MockAdapter()]]);
  const profile: any = { id: 'p', name: 'm', provider: 'mock', capabilities: [] };
  /** A world that would happily create the checkout, so only the guard can stop it. */
  const worldWith = (added: string[]): any => ({
    handle: { id: 'w1', root: '/tmp/w', branch: 'tavya/t', base: 'main',
      repos: [{ name: 'alpha', repo: '/src/alpha', root: '/tmp/w/alpha', branch: 'tavya/t', base: 'main' }] },
    async addCheckout(spec: any) {
      added.push(spec.name);
      return { ...this.handle, repos: [...this.handle.repos, { name: spec.name, repo: '/src/alpha',
        root: `/tmp/w/${spec.name}`, branch: `tavya/t-${spec.name}`, base: 'main' }] };
    },
  });
  const turn = (role: string, added: string[]) => runTurn(
    { profile, world: worldWith(added), systemPrompt: '', role,
      messages: [{ id: 'm', role: 'user', text: '@branch docs', ts: 0 }] } as any,
    { adapters },
  );

  it('lets the Do agent partition its change, and reports the branch back for the workflow to adopt', async () => {
    const added: string[] = [];
    const res = await turn('do', added);
    expect(added).toEqual(['docs']);
    expect(res.worldHandle?.repos?.map((r) => r.name)).toEqual(['alpha', 'docs']);
  });

  // Every activity re-opens the world from the DURABLE handle, so a branch added by
  // another role would be persisted and then landed by a merge nobody reviewed —
  // while the Do transcript that owns the partitioning never mentioned it.
  for (const role of ['merge', 'resolve', 'confirm']) {
    it(`refuses the ${role} agent, leaving the world untouched`, async () => {
      const added: string[] = [];
      const res = await turn(role, added);
      expect(added).toEqual([]);
      expect(res.worldHandle).toBeUndefined();
      expect(res.output).toMatch(/cannot add branches/);
    });
  }
});
