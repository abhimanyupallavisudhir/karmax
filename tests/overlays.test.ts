import { describe, it, expect } from 'vitest';
import { Overlays } from '../src/store/overlays.js';
import { resolveRequires } from '../src/contrib/manifests.js';
import { STORE_TASKS, PROJECT_WIKI_TEMPLATE_ID } from '../src/domain/task-store.js';

describe('overlay resolution + safe mode (SPEC §9)', () => {
  it('resolves project → user → bundled, and safe mode uses bundled only', () => {
    const o = new Overlays()
      .setBundled({ theme: 'light', pr: false })
      .setUser({ theme: 'dark' })
      .setProject({ pr: true });
    expect(o.resolve('theme')).toBe('dark'); // user shadows bundled
    expect(o.resolve('pr')).toBe(true); // project shadows bundled
    // safe mode: all overlays off → bundled floor
    expect(o.resolve('theme', { safeMode: true })).toBe('light');
    expect(o.resolve('pr', { safeMode: true })).toBe(false);
  });

  it('per-workflow fallback drops one workflow; safe mode re-enables all (vanilla)', () => {
    const o = new Overlays();
    o.disableWorkflow('goal');
    const all = ['software-dev', 'goal', 'just-do'];
    expect(o.effectiveWorkflows(all)).toEqual(['software-dev', 'just-do']);
    expect(o.effectiveWorkflows(all, { safeMode: true })).toEqual(all); // vanilla
  });
});

describe('manifest dependency resolution (SPEC §4.6)', () => {
  it('resolves the transitive closure of requires', () => {
    expect(resolveRequires(['software-dev']).sort()).toEqual(['merge-queue', 'software-dev'].sort());
  });

  it('tailors the store\'s project-wiki task to the deployment', () => {
    const wiki = STORE_TASKS.find((task) => task.id === PROJECT_WIKI_TEMPLATE_ID)!.task;
    expect(wiki.workflow).toBe('software-dev');
    for (const prompt of [wiki.prompt, wiki.hostedPrompt!]) {
      expect(prompt).toContain('Migrate AGENTS.md, CLAUDE.md');
      expect(prompt).toContain('memories for facts worth knowing, skills for procedures worth repeating');
      expect(prompt).toContain('"default" label');
      // Set up once, then kept current.
      expect(prompt).toMatch(/has no pages yet, set it up[\s\S]*Otherwise keep it current/);
      expect(prompt).not.toContain('Queue');
    }
    // Isolated cloud worlds have no worktrees to collide.
    expect(wiki.prompt).toContain('hardcoded resources (e.g. ports)');
    expect(wiki.hostedPrompt).not.toContain('ports');
  });
});
