import { describe, expect, it } from 'vitest';
import { assemblePrompt } from '../src/agent/prompt.js';
import { consoleOrigin, organizationPath, projectPath, taskPath } from '../src/domain/console-links.js';
import { parseRef } from '../src/cli/refs.js';

describe('console links', () => {
  const organization = { name: 'Acme Corp', slug: 'acme' };
  const project = { name: 'Web Site' };

  it('build the paths the console router reads', () => {
    expect(organizationPath(organization)).toBe('/acme');
    expect(organizationPath({ name: 'Acme Corp' })).toBe('/acme-corp');
    expect(projectPath(project, organization)).toBe('/acme/web-site');
    expect(projectPath(project)).toBe('/projects/web-site');
    expect(taskPath({ id: 'task_1', num: 12 }, project, organization)).toBe('/acme/web-site/tasks/12');
    expect(taskPath({ id: 'task_1' }, project, organization)).toBe('/acme/web-site/tasks/task_1');
    // The CLI reads the same address back.
    expect(parseRef(`https://tavya.io${taskPath({ id: 'task_1', num: 12 }, project, organization)}`))
      .toEqual({ server: 'https://tavya.io', organization: 'acme', project: 'web-site', task: '12' });
  });

  it('are absolute at the installation\'s public address, else the gateway\'s', () => {
    expect(consoleOrigin({ KARMAX_PUBLIC_URL: 'https://tavya.io/' })).toBe('https://tavya.io');
    expect(consoleOrigin({ KARMAX_GATEWAY_URL: 'http://127.0.0.1:4505' })).toBe('http://127.0.0.1:4505');
    expect(consoleOrigin({})).toBe('');
  });

  it('reach every agent through its prompt, with or without a computer', () => {
    const links = { task: 'https://tavya.io/acme/web-site/tasks/7', project: 'https://tavya.io/acme/web-site', organization: 'https://tavya.io/acme' };
    const task = { taskId: 'task_7', projectId: 'proj_1', title: 'T', prompt: 'P', project: {} } as any;
    for (const kind of ['memory', 'none']) {
      const prompt = assemblePrompt({ profile: { id: 'p', provider: 'mock' } as any, role: 'do', task,
        world: { kind, root: '/w', branch: 'b', base: 'main' } as any, links });
      expect(prompt).toContain('Links: when you mention a task, project, wiki page, file or setting');
      expect(prompt).toContain('This task: https://tavya.io/acme/web-site/tasks/7.');
      expect(prompt).toContain('/settings#<card> (e.g. #project-environment, #project-secrets)');
      expect(prompt).toContain('another of its projects: https://tavya.io/acme/<project id>/… with the same paths.');
    }
  });
});
