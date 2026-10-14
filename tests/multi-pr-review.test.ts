import { describe, it, expect } from 'vitest';
import { reviewCheckouts, allCheckoutsApproved, approveAll, approveProposed, movedSinceProposal, landableBranches, branchLedgerOf, approvalsOf, combineProposals } from '../src/domain/checkouts.js';
import type { BranchLedger } from '../src/domain/types.js';
import { runTurn } from '../src/agent/runtime.js';
import { MockAdapter } from '../src/agent/mock.js';
import { WorldRepo } from '../src/world/types.js';

/**
 * Review approval for a multi-PR task (SPEC §11.1).
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

/**
 * Software-dev ≥1.30: each branch has its own Review → landing lifecycle while
 * the agent keeps working in the others. An approval binds to the head the
 * branch was PROPOSED at, which is what its pull request showed the reviewer.
 */
describe('per-branch lifecycle', () => {
  const ledger = (proposed: Record<string, string>, landed: Record<string, string> = {}): BranchLedger => ({ proposed, landed });

  it('reports each branch\'s own state', () => {
    const view = reviewCheckouts(
      [repo('alpha', 'tavya/t'), repo('docs', 'tavya/t-docs'), repo('api', 'tavya/t-api'), repo('cli', 'tavya/t-cli')],
      { alpha: 'a1', docs: 'd1', api: 'p1', cli: 'c1' },
      { docs: 'd1', api: 'p1' },
      [],
      { ledger: ledger({ docs: 'd1', api: 'p1', cli: 'c1' }, { old: 'x' }), landing: ['api'] },
    );
    expect(view.map((c) => [c.name, c.state, c.approved])).toEqual([
      ['alpha', 'working', false],
      ['docs', 'approved', true],
      ['api', 'landing', true],
      ['cli', 'review', false],
    ]);
    expect(view.find((c) => c.name === 'cli')!.proposedHead).toBe('c1');
  });

  it('shows a landed branch as landed, with the commit it landed as', () => {
    const [c] = reviewCheckouts([repo('docs', 'tavya/t-docs')], { docs: 'd1' }, {}, [],
      { ledger: ledger({}, { docs: 'm1' }), landing: [] });
    expect([c!.state, c!.landedSha]).toEqual(['landed', 'm1']);
  });

  it('approves at the PROPOSED head, not at whatever the branch holds now', () => {
    const approvals = approveProposed(ledger({ docs: 'd1' }), {}, ['docs']);
    expect(approvals).toEqual({ docs: 'd1' });
    // The agent committed again after proposing: nothing it did since was reviewed.
    expect(landableBranches([repo('docs', 'tavya/t-docs')], ledger({ docs: 'd1' }), approvals, { docs: 'd2' })).toEqual([]);
    expect(movedSinceProposal(ledger({ docs: 'd1' }), { docs: 'd2' })).toEqual(['docs']);
  });

  it('approves nothing that was not proposed', () => {
    expect(approveProposed(ledger({ docs: 'd1' }), {}, ['alpha'])).toEqual({});
    expect(approveProposed(ledger({ docs: 'd1', api: 'p1' }), {})).toEqual({ docs: 'd1', api: 'p1' });
  });

  it('does not treat an unreadable head as a move', () => {
    expect(movedSinceProposal(ledger({ docs: 'd1' }), {})).toEqual([]);
  });

  it('lands only approved branches, and a stacked one only with or after its base', () => {
    const repos = [repo('alpha', 'tavya/t'), repo('api', 'tavya/t-api', 'tavya/t'), repo('docs', 'tavya/t-docs')];
    const heads = { alpha: 'a1', api: 'p1', docs: 'd1' };
    const proposed = ledger({ alpha: 'a1', api: 'p1', docs: 'd1' });
    // api is approved but stacks on alpha, which is not: it waits.
    expect(landableBranches(repos, proposed, { api: 'p1', docs: 'd1' }, heads)).toEqual(['docs']);
    // Approved together, they land together (merge orders the stack).
    expect(landableBranches(repos, proposed, { alpha: 'a1', api: 'p1' }, heads)).toEqual(['alpha', 'api']);
    // Its base already landed: it lands alone.
    expect(landableBranches(repos, ledger({ api: 'p1' }, { alpha: 'm1' }), { api: 'p1' }, heads)).toEqual(['api']);
  });
});

describe('carrying branch state into a replacement run', () => {
  it('rebuilds the ledger and approvals from the last view', () => {
    const checkouts = reviewCheckouts(
      [repo('alpha', 'tavya/t'), repo('docs', 'tavya/t-docs'), repo('api', 'tavya/t-api'), repo('cli', 'tavya/t-cli')],
      { alpha: 'a2', docs: 'd1', api: 'p1', cli: 'c1' }, { docs: 'd1', api: 'p1' }, [],
      { ledger: { proposed: { docs: 'd1', api: 'p1', cli: 'c1' }, landed: { alpha: 'a1' } }, landing: ['api'] },
    );
    expect(branchLedgerOf(checkouts, { branchesFinal: ['cli'], branchesRepairing: ['x'] })).toEqual({
      // A branch that was landing is proposed again: it lands again.
      proposed: { docs: 'd1', api: 'p1', cli: 'c1' }, landed: { alpha: 'a1' }, finish: true, finalBranches: ['cli'], repairing: ['x'],
    });
    // Approvals bind to the proposed head, not the head the checkout has now.
    expect(approvalsOf(checkouts)).toEqual({ docs: 'd1', api: 'p1' });
    expect(branchLedgerOf(checkouts).finish).toBeUndefined();
  });
});

describe('several open_pr calls before the workflow acts', () => {
  it('add up: every branch named, everything once a call names none, the last word on final', () => {
    expect(combineProposals(undefined, { branches: ['a'] })).toEqual({ branches: ['a'] });
    expect(combineProposals({ branches: ['a'] }, { branches: ['b'], final: true })).toEqual({ branches: ['a', 'b'], final: true });
    expect(combineProposals({ branches: ['a'], final: true }, {})).toEqual({ final: true });
    expect(combineProposals({}, { branches: ['b'], final: false })).toEqual({ final: false });
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
