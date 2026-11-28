import { describe, expect, it } from 'vitest';
import { capabilityPhrases, nameList, permissionAsk, taskAgent } from '../src/domain/permission-ask.js';
import { CAPABILITIES, capabilityPhrase } from '../src/platform/capabilities.js';
import { exactCapability } from '../src/platform/permission-requests.js';

// The one phrasing of a permission request (src/domain/permission-ask.ts).
describe('permissionAsk', () => {
  it('names the projects of a request that adds no capabilities, never a count of 0', () => {
    // preq_mx07uw7p312057c6ae read "Give the agent 0 permissions?" and never named admin_docs.
    const ask = permissionAsk({ agent: '#1060\'s agent', capabilities: [], projects: ['admin_docs'], level: 'Developer' });
    expect(ask.question).toBe('Let #1060\'s agent work in admin_docs too (as Developer)?');
    expect(ask.detail).toBe('Projects: admin_docs (as Developer)');
    expect(ask.grant).toBe('work in admin_docs too (as Developer)');
    expect(ask.question).not.toMatch(/\b0\b|permissions\?/);
  });

  it('says what each capability lets the agent do, read and write merged, ids only in the tooltip', () => {
    const ask = permissionAsk({ agent: '#12\'s agent', capabilities: ['settings:read', 'settings:write'] });
    expect(ask.question).toBe('Let #12\'s agent view and edit global settings?');
    expect(ask.question).not.toContain('settings:');
    expect(ask.detail).toBe('Permissions: settings:read, settings:write');
    // Agents act on ids: their words keep them.
    expect(ask.grant).toBe('view and edit global settings (settings:read, settings:write)');
    expect(permissionAsk({ agent: 'its agent', capabilities: ['github:actions:write'] }).question)
      .toBe('Let its agent operate GitHub Actions?');
  });

  it('says both when it adds both', () => {
    const ask = permissionAsk({ agent: '#7\'s agent', capabilities: ['credential:reveal'], projects: ['docs', 'site'], level: 'Project maintainer' });
    expect(ask.question).toBe('Let #7\'s agent work in docs and site too (as Project maintainer) and read the vault?');
    expect(ask.detail).toBe('Projects: docs, site (as Project maintainer)\nPermissions: credential:reveal');
    expect(ask.grant).toBe('work in docs and site too (as Project maintainer) and read the vault (credential:reveal)');
  });

  it('omits the level of a delegated grant', () => {
    expect(permissionAsk({ agent: 'its agent', capabilities: [], projects: ['docs'] }).question).toBe('Let its agent work in docs too?');
  });

  it('keeps a long question short; the detail and the grant name everything', () => {
    const capabilities = ['task:delete', 'project:delete', 'team:write', 'user:write', 'payment:write'];
    const ask = permissionAsk({ agent: 'its agent', capabilities });
    expect(ask.question).toBe('Let its agent delete tasks, delete projects, manage teams and 2 more?');
    expect(ask.detail).toBe(`Permissions: ${capabilities.join(', ')}`);
    expect(ask.grant).toContain('manage payments (payment:write)');
  });

  it('phrases the concrete families and falls back to the id for an unknown capability', () => {
    expect(capabilityPhrase('merge-into:main')).toBe('merge into main');
    expect(capabilityPhrase('use-credential:item:vi_1')).toBe('use a credential from the vault');
    expect(capabilityPhrase('use-credential:openai')).toBe('use the openai credential');
    expect(capabilityPhrase('use-card:card_1')).toBe('use a payment card');
    expect(capabilityPhrase('create-sub-task')).toBe('create tasks');
    expect(capabilityPhrase('made:up')).toBe('made:up');
    expect(capabilityPhrases(['made:up', 'other:thing'])).toEqual([{ phrase: 'made:up', ids: ['made:up'] }, { phrase: 'other:thing', ids: ['other:thing'] }]);
    expect(permissionAsk({ agent: 'its agent', capabilities: ['made:up'] }).grant).toBe('made:up');
  });

  it('has words for every capability a task can request', () => {
    // What request_permission accepts (exactCapability): the catalogue without
    // wildcards, and one of each concrete family.
    const requestable = [...CAPABILITIES.filter((capability) => !capability.includes('*')),
      'merge-into:main', 'use-credential:item:vi_1', 'use-credential:openai', 'use-card:card_1'];
    for (const capability of requestable) {
      expect(exactCapability(capability)).toBe(capability);
      const phrase = capabilityPhrase(capability);
      expect(phrase, `${capability} has no label`).not.toBe(capability);
      expect(phrase, capability).toMatch(/^[a-z]/);
      expect(phrase, capability).not.toContain(':');
    }
  });

  it('lists names', () => {
    expect([[], ['a'], ['a', 'b'], ['a', 'b', 'c'], ['a', 'b', 'c', 'd']].map((names) => nameList(names)))
      .toEqual(['', 'a', 'a and b', 'a, b and c', 'a, b, c and 1 more']);
    expect(taskAgent({ num: 1060 })).toBe('#1060\'s agent');
    expect(taskAgent({})).toBe('this task\'s agent');
  });
});
