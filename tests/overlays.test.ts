import { describe, it, expect } from 'vitest';
import { Overlays } from '../src/store/overlays.js';
import { activationTaskPrompt, resolveRequires, manifest } from '../src/contrib/manifests.js';

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
    expect(manifest('software-dev')?.onActivate?.spawnTask?.workflow).toBe('software-dev');
  });

  it('tailors the initial tavya-readiness task to the deployment', () => {
    const prep = manifest('software-dev')!.onActivate!.spawnTask!;
    const local = activationTaskPrompt(prep, false);
    const hosted = activationTaskPrompt(prep, true);
    const expectedHosted = `## Initial set-up task for tavya-readiness
1) Migrate AGENTS.md, CLAUDE.md or any other similar agent context systems to tavya's project wiki.
2) If no such files exist, or if they are out of date, please compile a new wiki page containing everything essential for a new developer/agent to get up and running with it.
It is important to use the "default" tag on wiki articles that must appear in the context of every new agent.
Report what you changed.
[To humans: This is not for you. Just press "Queue" and the agent will do the above.]`;
    expect(local).toContain('Migrate AGENTS.md, CLAUDE.md');
    expect(local).toContain('compile a new wiki page');
    expect(local).toContain('use the "default" tag');
    expect(local).toContain('hardcoded resources (e.g. ports)');
    expect(local).not.toContain('Ensure git is initialized');
    expect(hosted).toBe(expectedHosted);
  });
});
