import { describe, it, expect, beforeEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { capMatches, allows, attenuate, effectiveAllows } from '../src/platform/capabilities.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { Vault } from '../src/autonomy/vault.js';
import { CredentialBroker } from '../src/autonomy/broker.js';

describe('capability model + attenuation (SPEC §8.2)', () => {
  it('matches exact, prefix-wildcard, and global', () => {
    expect(capMatches('create-task', 'create-task')).toBe(true);
    expect(capMatches('merge-into:*', 'merge-into:/r:main')).toBe(true);
    expect(capMatches('*', 'anything')).toBe(true);
    expect(capMatches('merge-into:/r:main', 'merge-into:/r:dev')).toBe(false);
  });

  it('effective capabilities are the intersection of ceiling and grantor', () => {
    const ceiling = ['merge-into:*', 'create-task'];
    const grantor = ['merge-into:/r:main', 'read-task'];
    // ceiling allows merge-into:/r:main (wildcard) AND grantor allows it → permitted
    expect(effectiveAllows(ceiling, grantor, 'merge-into:/r:main')).toBe(true);
    // ceiling allows create-task but grantor does NOT → denied (attenuated by grantor)
    expect(effectiveAllows(ceiling, grantor, 'create-task')).toBe(false);
    // grantor allows read-task but ceiling does NOT → denied (over the ceiling)
    expect(effectiveAllows(ceiling, grantor, 'read-task')).toBe(false);
    const eff = attenuate(ceiling, grantor);
    expect(allows(eff, 'merge-into:/r:main')).toBe(true);
    expect(allows(eff, 'create-task')).toBe(false);
  });

  it("a sub-task's grant scopes merge to EXACTLY the parent branch, not merge-into:* (SPEC §5.3/§8.2)", () => {
    // Mirrors prepareChildTask: delegation caps attenuated by the parent's grant,
    // merge scoped to the parent's own branch.
    const parentBranch = 'karmax/task_parent';
    const collaboration = ['task:read', 'task:event:read', 'task:git:publish', 'task:git:import',
      'task:conversation:read', 'task:conversation:fork', 'task:conversation:message'];
    const delegation = attenuate(['create-sub-task', 'create-review-info', 'signal-completion', 'save-skill', ...collaboration], ['*']);
    const childGrant = [...delegation, `merge-into:${parentBranch}`];
    // The do-agent profile ceiling still carries the broad merge-into:* …
    const ceiling = ['create-sub-task', 'create-review-info', 'signal-completion', 'save-skill', ...collaboration, 'merge-into:*'];
    const eff = attenuate(ceiling, childGrant);
    // … but the child may merge into ONLY its parent's branch.
    expect(allows(eff, `merge-into:${parentBranch}`)).toBe(true);
    expect(allows(eff, 'merge-into:main')).toBe(false);
    expect(allows(eff, 'merge-into:karmax/task_sibling')).toBe(false);
    expect(allows(eff, 'merge-into:*')).toBe(false);
    // Delegation caps survive so it can run its own Do/Review/sub-tasks.
    expect(allows(eff, 'create-sub-task')).toBe(true);
    expect(allows(eff, 'signal-completion')).toBe(true);
    expect(allows(eff, 'task:git:publish')).toBe(true);
    expect(allows(eff, 'task:git:import')).toBe(true);
  });
});

describe('TokenAuthority (workflow-minted scoped tokens)', () => {
  it('mints a token scoped to effective capabilities and checks against it', () => {
    const ta = new TokenAuthority();
    const { token } = ta.mint({
      taskId: 't1',
      profileId: 'merge-default',
      principal: 'user:abc',
      ceiling: ['merge-into:*', 'signal-completion'],
      grantorCaps: ['merge-into:/r:main', 'signal-completion', 'create-task'],
    });
    expect(ta.check(token, 'merge-into:/r:main').ok).toBe(true);
    expect(ta.check(token, 'signal-completion').ok).toBe(true);
    // create-task was over the profile ceiling → not in effective set
    expect(ta.check(token, 'create-task').ok).toBe(false);
    expect(ta.check('kt_bogus', 'signal-completion').ok).toBe(false);
  });
});

describe('CredentialBroker (vault-backed, JIT, scoped, audited)', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-vault-'));
  });

  it('stores secrets encrypted at rest and resolves only with capability', () => {
    const vault = new Vault(dir);
    vault.put('openai', 'sk-secret-123');
    // raw file never contains the plaintext secret
    const raw = fs.readFileSync(path.join(dir, 'secrets.json'), 'utf8');
    expect(raw).not.toContain('sk-secret-123');

    const broker = new CredentialBroker(vault);
    // permitted requester
    expect(broker.resolve('openai', { caps: ['use-credential:openai'], taskId: 't1' })).toBe('sk-secret-123');
    // denied requester
    expect(() => broker.resolve('openai', { caps: ['use-credential:other'] })).toThrow(/not permitted/);
    // audit captures both attempts
    const log = broker.audit_log();
    expect(log).toHaveLength(2);
    expect(log[0]!.granted).toBe(true);
    expect(log[1]!.granted).toBe(false);
  });

  it('write-back of a newly created account is resolvable later', () => {
    const broker = new CredentialBroker(new Vault(dir));
    broker.registerHandle('new-acct', 'pw-xyz');
    expect(broker.resolve('new-acct', { caps: ['use-credential:*'] })).toBe('pw-xyz');
  });
});
