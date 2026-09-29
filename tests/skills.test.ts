import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listResolveSkills, renderSkillsIndex } from '../src/resolve/skills.js';
import { KarmaxApi } from '../src/platform/api.js';
import { Store } from '../src/store/db.js';
import { TokenAuthority } from '../src/platform/tokens.js';

/**
 * Self-healing loop (SPEC §3.4): the Resolve agent's saved skills must be READABLE
 * back as an index it can reuse — until now they were write-only. Covers the index
 * reader, its render, and a saveSkill→listResolveSkills round-trip.
 */
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-skills-'));

describe('listResolveSkills', () => {
  it('indexes canonical resolve/<slug>.md and legacy resolve-<slug>.md, with a one-line summary', () => {
    const dir = tmp();
    try {
      fs.mkdirSync(path.join(dir, 'skills', 'resolve'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'skills', 'resolve', 'npm-eresolve.md'), '# ERESOLVE\nRun npm install with --legacy-peer-deps.\n');
      fs.writeFileSync(path.join(dir, 'skills', 'resolve-flaky-clone.md'), 'Retry the git clone; the mirror is intermittently down.\n'); // legacy flat form
      fs.writeFileSync(path.join(dir, 'skills', 'not-a-resolve.md'), 'unrelated skill'); // ignored (not resolve)

      const skills = listResolveSkills(dir);
      expect(skills.map((s) => s.name)).toEqual(['resolve/flaky-clone', 'resolve/npm-eresolve']); // sorted
      const eresolve = skills.find((s) => s.name === 'resolve/npm-eresolve')!;
      expect(eresolve.summary).toBe('Run npm install with --legacy-peer-deps.'); // first NON-heading line
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('lets the most specific fix win a name clash: project, then organization, then installation', () => {
    const dir = tmp();
    try {
      const put = (root: string, summary: string) => {
        fs.mkdirSync(path.join(root, 'resolve'), { recursive: true });
        fs.writeFileSync(path.join(root, 'resolve', 'clash.md'), `${summary}\n`);
      };
      put(path.join(dir, 'skills'), 'installation');
      put(path.join(dir, 'skills', 'organizations', 'o1'), 'organization');
      put(path.join(dir, 'skills', 'projects', 'p1'), 'project');
      const summary = (...scope: [string?, string?]) => listResolveSkills(dir, ...scope).find((s) => s.name === 'resolve/clash')?.summary;
      expect(summary('o1', 'p1')).toBe('project');
      expect(summary('o1', 'p2')).toBe('organization');
      expect(summary()).toBe('installation');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns [] when there are no skills (or no content dir)', () => {
    const dir = tmp();
    try {
      expect(listResolveSkills(dir)).toEqual([]);
      expect(listResolveSkills(path.join(dir, 'does-not-exist'))).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('renderSkillsIndex', () => {
  it('renders a bullet list, or a helpful placeholder when empty', () => {
    expect(renderSkillsIndex([])).toMatch(/none saved yet/i);
    const out = renderSkillsIndex([{ name: 'resolve/x', summary: 'do the thing' }, { name: 'resolve/y', summary: '' }]);
    expect(out).toContain('- resolve/x — do the thing');
    expect(out).toContain('- resolve/y');
  });
});

describe('saveSkill → listResolveSkills round-trip', () => {
  const api = async () => {
    const contentDir = tmp();
    const tokens = new TokenAuthority();
    const store = (await Store.create(':memory:'));
    const k = new KarmaxApi({ store, client: {} as any, taskQueue: 'tq', tokens, contentDir } as any);
    // Saved skills reach every Resolve prompt in the organization: organization-wide authority.
    const caps = ['save-skill', 'organization:wiki:write'];
    const token = (await tokens.mint({ taskId: 't', profileId: 'resolve', principal: 'user:a', ceiling: caps, grantorCaps: caps })).token;
    return { k, token, contentDir };
  };

  it('writes a "resolve/<slug>" skill into the resolve/ subdir, where the index finds it', async () => {
    const { k, token, contentDir } = (await api());
    try {
      const { path: file } = await k.saveSkill(token, { name: 'resolve/npm eresolve!', content: 'Use --legacy-peer-deps.' });
      // Name is sanitized per-segment but the resolve/ subdir is preserved (not flattened).
      // Saved under the caller's organization, indexed for that organization only.
      expect(file.replace(/\\/g, '/')).toContain('/skills/organizations/org_personal/resolve/npm-eresolve-.md');
      expect(listResolveSkills(contentDir, 'org_personal').map((s) => s.name)).toContain('resolve/npm-eresolve-');
      expect(listResolveSkills(contentDir, 'org_other').map((s) => s.name)).not.toContain('resolve/npm-eresolve-');
      expect(listResolveSkills(contentDir).map((s) => s.name)).not.toContain('resolve/npm-eresolve-');
    } finally {
      fs.rmSync(contentDir, { recursive: true, force: true });
    }
  });

  it('saves to the calling task\'s project without organization-wide authority', async () => {
    const contentDir = tmp();
    const tokens = new TokenAuthority();
    const store = (await Store.create(':memory:'));
    try {
      const k = new KarmaxApi({ store, client: {} as any, taskQueue: 'tq', tokens, contentDir } as any);
      const organization = (await store.createOrganization({ name: 'Acme' }));
      const web = (await store.createProject('Web', {}, organization.id));
      const docs = (await store.createProject('Docs', {}, organization.id));
      const task = (await store.createTask({ projectId: web.id, title: 'Fix', workflow: 'just-do', workflowVersion: '1', params: { prompt: 'x' } }));
      const mint = async (caps: string[], scope: { taskId?: string; projectIds?: string[] } = {}) => (await tokens.mint({
        taskId: scope.taskId ?? '*', profileId: 'resolve', principal: 'user:a', organizationId: organization.id,
        projectIds: scope.projectIds, ceiling: caps, grantorCaps: caps })).token;

      // A project-scoped Resolve agent: its skill lands in its own project.
      const projectAgent = (await mint(['skill:write'], { taskId: task.id, projectIds: [web.id] }));
      const saved = (await k.saveSkill(projectAgent, { name: 'resolve/flaky clone', content: 'Retry the clone.' }));
      expect(saved.scope).toBe('project');
      expect(saved.path.replace(/\\/g, '/')).toContain(`/skills/projects/${web.id}/resolve/flaky-clone.md`);
      expect(listResolveSkills(contentDir, organization.id, web.id).map((s) => s.name)).toContain('resolve/flaky-clone');
      expect(listResolveSkills(contentDir, organization.id, docs.id).map((s) => s.name)).not.toContain('resolve/flaky-clone');
      expect(listResolveSkills(contentDir, organization.id).map((s) => s.name)).not.toContain('resolve/flaky-clone');

      // organization:wiki:write still saves organization-wide.
      const organizationAgent = (await mint(['skill:write', 'organization:wiki:write'], { taskId: task.id }));
      const shared = (await k.saveSkill(organizationAgent, { name: 'resolve/flaky clone', content: 'Organization fix.' }));
      expect(shared.scope).toBe('organization');
      expect(shared.path.replace(/\\/g, '/')).toContain(`/skills/organizations/${organization.id}/resolve/flaky-clone.md`);

      // Neither a project of its own nor organization-wide authority: refused.
      const unscoped = (await mint(['skill:write']));
      await expect(k.saveSkill(unscoped, { name: 'x', content: 'y' })).rejects.toMatchObject({ status: 403 });
      await expect(k.saveSkill((await mint(['task:read'], { taskId: task.id, projectIds: [web.id] })), { name: 'x', content: 'y' }))
        .rejects.toMatchObject({ status: 403 });
    } finally {
      (await store.close());
      fs.rmSync(contentDir, { recursive: true, force: true });
    }
  });

  it('blocks path traversal in a skill name (stays under skills/)', async () => {
    const { k, token, contentDir } = (await api());
    try {
      const { path: file } = await k.saveSkill(token, { name: '../../etc/evil', content: 'x' });
      expect(path.resolve(file).startsWith(path.resolve(contentDir, 'skills'))).toBe(true);
    } finally {
      fs.rmSync(contentDir, { recursive: true, force: true });
    }
  });
});
