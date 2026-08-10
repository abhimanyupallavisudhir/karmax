import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const source = fs.readFileSync(path.resolve('web/app.js'), 'utf8');

function extractFunction(name: string): string {
  const plain = source.indexOf(`function ${name}(`);
  const asyncStart = source.indexOf(`async function ${name}(`);
  const start = asyncStart >= 0 ? asyncStart : plain;
  if (start < 0) throw new Error(`${name} not found`);
  let depth = 0;
  for (let index = source.indexOf('{', start); index < source.length; index++) {
    if (source[index] === '{') depth++;
    else if (source[index] === '}' && --depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`unterminated ${name}`);
}

describe('default organization browser behavior', () => {
  it('selects startup projects only from the persisted default organization', async () => {
    const state: any = { organizationId: null, defaultOrganizationId: null, projectId: null, projects: [], organizations: [] };
    const organizations = [
      { id: 'new-team', kind: 'team' },
      { id: 'personal', kind: 'personal' },
    ];
    const projects = [
      { id: 'other-project', organizationId: 'new-team' },
      { id: 'personal-project', organizationId: 'personal' },
    ];
    const api = async (url: string) => url === '/api/organizations'
      ? organizations : { organizationId: 'personal' };
    const loadOrganizations = Function('S', 'api',
      `${extractFunction('loadOrganizations')}; return loadOrganizations;`)(state, api);
    const loadProjects = Function('S', 'api', 'firstProjectForOrganization', 'projectById',
      `${extractFunction('loadProjects')}; return loadProjects;`)(
      state,
      async () => projects,
      (organizationId: string) => state.projects.find((project: any) => project.organizationId === organizationId),
      (projectId: string) => state.projects.find((project: any) => project.id === projectId),
    );

    await loadOrganizations();
    await loadProjects();
    expect(state.defaultOrganizationId).toBe('personal');
    expect(state.projectId).toBe('personal-project');
    expect(state.organizationId).toBe('personal');
  });

  it('loads the persisted preference and exposes an explicit profile control', () => {
    const organizations = extractFunction('loadOrganizations');
    const profile = extractFunction('profileView');
    const wiring = extractFunction('wireProfileView');
    const routing = extractFunction('applyRoute');
    const tabSwitch = extractFunction('switchTab');

    expect(organizations).toContain("api('/api/user/default-organization')");
    expect(organizations).not.toContain('S.organizations[0]');
    expect(organizations).not.toContain("organization.kind === 'personal'");
    expect(profile).toContain('Set as default');
    expect(profile).toContain('S.defaultOrganizationId');
    expect(wiring).toContain("method: 'PUT'");
    expect(wiring).toContain("toast('Default organization updated')");
    expect(routing).toContain('firstProjectForOrganization(S.organizationId)');
    expect(routing).not.toContain('S.projects[0]?.id');
    expect(tabSwitch).toContain('firstProjectForOrganization(S.organizationId)');
  });
});
