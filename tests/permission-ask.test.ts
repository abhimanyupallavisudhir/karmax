import { describe, expect, it } from 'vitest';
import { nameList, permissionAsk, taskAgent } from '../src/domain/permission-ask.js';

// The one phrasing of a permission request (src/domain/permission-ask.ts).
describe('permissionAsk', () => {
  it('names the projects of a request that adds no capabilities, never a count of 0', () => {
    // preq_mx07uw7p312057c6ae read "Give the agent 0 permissions?" and never named admin_docs.
    const ask = permissionAsk({ agent: '#1060\'s agent', capabilities: [], projects: ['admin_docs'], level: 'Developer' });
    expect(ask.question).toBe('Let #1060\'s agent work in admin_docs too (as Developer)?');
    expect(ask.detail).toBe('Projects: admin_docs (as Developer)');
    expect(ask.grant).toBe('access to admin_docs (as Developer)');
    expect(ask.question).not.toMatch(/\b0\b|permissions\?/);
  });

  it('names the capabilities of a request that adds no projects', () => {
    expect(permissionAsk({ agent: 'its agent', capabilities: ['settings:read'] }).question).toBe('Give its agent settings:read?');
    expect(permissionAsk({ agent: 'its agent', capabilities: ['settings:read', 'settings:write'] }))
      .toEqual({ question: 'Give its agent settings:read and settings:write?',
        detail: 'Permissions: settings:read, settings:write', grant: 'settings:read and settings:write' });
  });

  it('says both when it adds both', () => {
    const ask = permissionAsk({ agent: '#7\'s agent', capabilities: ['vault:read'], projects: ['docs', 'site'], level: 'Project maintainer' });
    expect(ask.question).toBe('Let #7\'s agent work in docs and site too (as Project maintainer) and give it vault:read?');
    expect(ask.detail).toBe('Projects: docs, site (as Project maintainer)\nPermissions: vault:read');
    expect(ask.grant).toBe('access to docs and site (as Project maintainer), and vault:read');
  });

  it('omits the level of a delegated grant', () => {
    expect(permissionAsk({ agent: 'its agent', capabilities: [], projects: ['docs'] }).question).toBe('Let its agent work in docs too?');
  });

  it('keeps a long question short; the detail and the grant name everything', () => {
    const capabilities = ['a:1', 'b:2', 'c:3', 'd:4', 'e:5'];
    const ask = permissionAsk({ agent: 'its agent', capabilities });
    expect(ask.question).toBe('Give its agent a:1, b:2, c:3 and 2 more?');
    expect(ask.detail).toBe(`Permissions: ${capabilities.join(', ')}`);
    expect(ask.grant).toBe('a:1, b:2, c:3, d:4 and e:5');
  });

  it('lists names', () => {
    expect([[], ['a'], ['a', 'b'], ['a', 'b', 'c'], ['a', 'b', 'c', 'd']].map((names) => nameList(names)))
      .toEqual(['', 'a', 'a and b', 'a, b and c', 'a, b, c and 1 more']);
    expect(taskAgent({ num: 1060 })).toBe('#1060\'s agent');
    expect(taskAgent({})).toBe('this task\'s agent');
  });
});
