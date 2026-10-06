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
    const tabSwitch = extractFunction('switchTab');

    expect(organizations).toContain("api('/api/user/default-organization')");
    expect(organizations).not.toContain('S.organizations[0]');
    expect(organizations).not.toContain("organization.kind === 'personal'");
    expect(profile).toContain("organizationComboHtml('default-organization'");
    expect(wiring).toContain("wireOrganizationCombo($('#default-organization')");
    expect(profile).toContain('S.defaultOrganizationId');
    expect(wiring).toContain("method: 'PUT'");
    expect(wiring).toContain("toast('Default organization updated')");
    expect(tabSwitch).toContain('firstProjectForOrganization(S.organizationId)');
  });

  it('lands the root URL on the default organization\'s home, not on the first project anywhere', async () => {
    const state: any = {
      organizationId: 'personal', defaultOrganizationId: 'personal', projectId: null,
      organizations: [{ id: 'new-team', slug: 'team' }, { id: 'personal', slug: 'mine' }],
      projects: [{ id: 'other-project', organizationId: 'new-team', name: 'Other' }],
    };
    const went: string[] = [];
    const helpers = ['slugify', 'orgSlug', 'organizationById', 'projectById', 'currentOrg', 'orgBase', 'encodeQuery',
      'listRoute', 'homeRoute', 'globalRoute', 'applyRoute'].map(extractFunction).join('\n');
    const applyRoute = Function('S', 'go', 'parseRoute', 'currentPath', 'location', 'DEFAULT_LIST_QUERY',
      `${helpers}; return applyRoute;`)(state, (to: string) => { went.push(to); }, () => ({ name: 'home' }), () => '/',
      { pathname: '/' }, 'for:me');
    await applyRoute();
    expect(went).toEqual(['/mine']);
  });
});

describe('searchable organization selection', () => {
  function fixture(onSelect: (id: string) => Promise<void>, discover = false) {
    class Element {
      value = 'Alpha'; hidden = true; disabled = false; id = 'picker'; isConnected = true;
      innerHTML = ''; style: any = {}; scrollHeight = 100;
      attributes: Record<string, string> = {};
      listeners: Record<string, Function> = {};
      addEventListener(name: string, callback: Function) { this.listeners[name] = callback; }
      removeEventListener() {}
      setAttribute(name: string, value: string) { this.attributes[name] = value; }
      removeAttribute(name: string) { delete this.attributes[name]; }
      select() {}
      blur() { this.listeners.blur?.(); }
      contains() { return false; }
      getBoundingClientRect() { return { left: 20, top: 300, bottom: 330, width: 200, height: 100 }; }
      querySelectorAll() {
        return [...this.innerHTML.matchAll(/role="option" id="([^"]+)"/g)].map((match) => ({
          id: match[1], classList: { toggle() {} }, scrollIntoView() {},
        }));
      }
      async emit(name: string, key?: string) { await this.listeners[name]?.({ key, preventDefault() {} }); }
    }
    const input = new Element();
    const menu = new Element();
    const caret = new Element();
    const root = Object.assign(new Element(), {
      querySelector: (selector: string) => selector === 'input' ? input : selector === '.combo-menu' ? menu : caret,
    });
    const organizations = [{ id: 'a', name: 'Alpha' }, { id: 'b', name: 'Beta' }];
    let selected = 'a';
    const errors: string[] = [];
    const wire = Function('S', 'organizationById', 'esc', 'document', 'window', 'api', 'toast',
      `${extractFunction('wireOrganizationCombo')}; return wireOrganizationCombo;`)(
      { organizations }, (id: string) => organizations.find((o) => o.id === id), String,
      new Element(), Object.assign(new Element(), { innerWidth: 800, innerHeight: 400 }),
      async () => [...organizations.map((o) => ({ ...o, accessible: true })), { id: 'public', name: 'Public', accessible: false }],
      (message: string) => errors.push(message),
    );
    wire(root, () => selected, async (id: string) => { await onSelect(id); selected = id; }, discover);
    return { input, menu, errors, selected: () => selected };
  }

  it('filters without committing, selects by keyboard, and restores uncommitted text', async () => {
    const commits: string[] = [];
    const ui = fixture(async (id) => { commits.push(id); });
    await ui.input.emit('focus');
    expect(ui.menu.innerHTML).toContain('Alpha');
    expect(ui.menu.innerHTML).toContain('Beta');
    ui.input.value = 'bET';
    await ui.input.emit('input');
    expect(ui.menu.innerHTML).not.toContain('Alpha');
    expect(commits).toEqual([]);
    await ui.input.emit('keydown', 'ArrowDown');
    expect(ui.input.attributes['aria-activedescendant']).toBeDefined();
    await ui.input.emit('keydown', 'Enter');
    await new Promise((resolve) => setImmediate(resolve));
    expect(commits).toEqual(['b']);
    expect(ui.input.value).toBe('Beta');
    ui.input.value = 'unknown';
    await ui.input.emit('input');
    expect(ui.menu.innerHTML).toContain('No matching organizations');
    await ui.input.emit('keydown', 'Enter');
    await ui.input.emit('keydown', 'Escape');
    expect(commits).toEqual(['b']);
    expect(ui.input.value).toBe('Beta');
    expect(ui.menu.hidden).toBe(true);
  });

  it('prevents entering public nonmember organizations and rolls back a failed save', async () => {
    const ui = fixture(async () => { throw new Error('Save failed'); }, true);
    await ui.input.emit('focus');
    ui.input.value = 'Public';
    await ui.input.emit('input');
    expect(ui.menu.innerHTML).toContain('aria-disabled="true"');
    await ui.input.emit('keydown', 'Enter');
    expect(ui.selected()).toBe('a');
    expect(ui.errors).toEqual([]);
    ui.input.value = 'Beta';
    await ui.input.emit('input');
    await ui.input.emit('keydown', 'Enter');
    await new Promise((resolve) => setImmediate(resolve));
    expect(ui.errors).toEqual(['Save failed']);
    expect(ui.input.value).toBe('Alpha');
    expect(ui.input.disabled).toBe(false);
  });
});
