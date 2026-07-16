import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { manifest } from '../src/contrib/manifests.js';
import {
  resolveParams,
  resolveParamsLayers,
  assembleTaskInput,
  projectSettingsFor,
  globalSettingsFor,
  quickGlobalSettingsFor,
  quickProjectSettingsFor,
  quickScopeKey,
  settingsToProjectConfig,
  effectiveRepos,
} from '../src/platform/params.js';
import { Project } from '../src/domain/types.js';

const sd = manifest('software-dev')!;

describe('resolveParams (overlay: task → project → global → default)', () => {
  it('honors precedence and falls back to the field default', () => {
    const r = resolveParams(sd, {
      task: { prompt: 'do it', base: 'feature' },
      project: { base: 'develop', target: 'develop', repos: ['/r'] },
      global: { target: 'main' },
    });
    expect(r.prompt).toBe('do it');
    expect(r.base).toBe('feature'); // task wins
    expect(r.target).toBe('develop'); // project wins over global
    expect(r.remote).toBe('none'); // field default
  });

  it('resolves unified/separate agent forms across inheritance layers', () => {
    const doAgent = { provider: 'codex', model: 'do-model', resumeFrom: { taskId: 'old' } };
    const mergeAgent = { provider: 'claude', model: 'merge-model', resumeFrom: { taskId: 'merge-old' } };

    const separatedChild = resolveParams(sd, {
      task: { separateAgents: true },
      project: { separateAgents: false, 'agent:unified': doAgent },
    });
    expect(separatedChild['agent:do']).toEqual(doAgent);
    expect(separatedChild['agent:merge']).toEqual({ provider: 'codex', model: 'do-model' });

    const unifiedChild = resolveParams(sd, {
      task: { separateAgents: false },
      project: {
        separateAgents: true,
        'agent:do': doAgent,
        'agent:merge': mergeAgent,
      },
    });
    expect(unifiedChild['agent:do']).toEqual(doAgent);
    expect(unifiedChild['agent:merge']).toEqual({ provider: 'codex', model: 'do-model' });
    expect(unifiedChild.separateAgents).toBe(false);
  });
});

describe('resolveParams treats an empty list at a layer as "inherit", not an override', () => {
  it('a blank project `repos` list falls through to the lower layer instead of shadowing it', () => {
    // The scratch-sandbox incident: an empty `repos: []` in the project overlay used
    // to win over the configured repo (pick() only skipped undefined/null/''), which
    // stripped the repo and dropped the task into a README-only scratch world.
    const r = resolveParams(sd, { project: { repos: [] }, global: { repos: ['/fallback'] } });
    expect(r.repos).toEqual(['/fallback']);
  });

  it('an empty list everywhere resolves to undefined (no repos)', () => {
    const r = resolveParams(sd, { project: { repos: [] } });
    expect(r.repos).toBeUndefined();
  });

  it('a non-empty list still overrides normally', () => {
    const r = resolveParams(sd, { project: { repos: ['/a'] }, global: { repos: ['/b'] } });
    expect(r.repos).toEqual(['/a']);
  });
});

describe('effectiveRepos (what the world is actually built from)', () => {
  it('uses the resolved overlay repos when set', () => {
    expect(effectiveRepos({ repos: ['/x'] }, { repos: ['/config'] })).toEqual(['/x']);
  });

  it('falls back to project config when the overlay did not set repos', () => {
    expect(effectiveRepos({}, { repos: ['/config'] })).toEqual(['/config']);
  });

  it('drops blank/whitespace entries so they never count as configured', () => {
    expect(effectiveRepos({ repos: ['', '  '] }, { repos: ['/config'] })).toEqual([]);
    expect(effectiveRepos({}, { repos: ['   '] })).toEqual([]);
  });
});

describe('assembleTaskInput (binds resolved values into TaskInput)', () => {
  it('places prompt/branches/project fields/agents and expands repo paths', () => {
    const resolved = {
      prompt: 'build X',
      base: 'main',
      target: 'release',
      repos: ['~/code/app'],
      copyGlobs: ['.env'],
      remote: 'pr',
      'agent:do': { provider: 'codex', model: 'gpt-4.1', effort: 'high' },
    };
    const input = assembleTaskInput(sd, resolved, { taskId: 't1', projectId: 'p1', title: 'X', project: { worldProvider: 'container' } });
    expect(input.prompt).toBe('build X');
    expect(input.base).toBe('main');
    expect(input.target).toBe('release');
    expect(input.project.repos).toEqual([path.join(os.homedir(), 'code/app')]); // ~ expanded
    expect(input.project.copyGlobs).toEqual(['.env']);
    expect(input.project.worldProvider).toBe('container');
    expect(input.project.remote).toBe('pr');
    expect(input.project.defaultBase).toBe('main'); // mirrored
    expect(input.project.defaultTarget).toBe('release');
    expect(input.agents?.do).toEqual({ provider: 'codex', model: 'gpt-4.1', effort: 'high' });
  });

  it('normalizes a legacy confirmer {mode} value into confirm layers', () => {
    const resolved = {
      prompt: 'build X',
      confirm: { mode: 'agent', provider: 'mock', prompt: 'Ensure X, Y and Z.\n{{response}}' },
    };
    const input = assembleTaskInput(sd, resolved, { taskId: 't1', projectId: 'p1', title: 'X', project: {} });
    expect(input.confirm).toEqual({ layers: [{ kind: 'agent', provider: 'mock', prompt: 'Ensure X, Y and Z.\n{{response}}' }] });
    expect(input.agents?.confirm).toBeUndefined(); // per-layer specs land on agents.confirm at turn time, in the workflow
  });

  it('carries confirm layers into input.confirm as given (auto-confirm = zero layers)', () => {
    const layers = [
      { kind: 'agent', provider: 'mock', model: 'm1', prompt: 'Check it.\n{{response}}' },
      { kind: 'human' },
    ];
    const input = assembleTaskInput(sd, { prompt: 'build X', confirm: { layers } }, { taskId: 't1', projectId: 'p1', title: 'X', project: {} });
    expect(input.confirm).toEqual({ layers: [layers[0], { kind: 'human', audience: ['@creator'] }] });
    const auto = assembleTaskInput(sd, { prompt: 'build X', confirm: { layers: [] } }, { taskId: 't2', projectId: 'p1', title: 'X', project: {} });
    expect(auto.confirm).toEqual({ layers: [] });
  });
});

describe('projectSettingsFor (lazy back-compat from ProjectConfig)', () => {
  const project: Project = {
    id: 'p1',
    name: 'P',
    createdAt: 0,
    config: { defaultBase: 'main', defaultTarget: 'prod', repos: ['/r'], openGithubPr: true },
  };

  it('derives from ProjectConfig when no settings row exists', () => {
    const s = projectSettingsFor(() => undefined, project, 'software-dev');
    expect(s.base).toBe('main');
    expect(s.target).toBe('prod');
    expect(s.repos).toEqual(['/r']);
    expect(s.remote).toBe('pr');
  });

  it('uses the stored settings row when present', () => {
    const stored = { base: 'develop', repos: ['/other'] };
    const s = projectSettingsFor(() => stored, project, 'software-dev');
    expect(s).toBe(stored);
  });

  it('globalSettingsFor returns {} when absent', () => {
    expect(globalSettingsFor(() => undefined, 'software-dev')).toEqual({});
  });

  it('never leaks legacy installation defaults into a new organization', () => {
    const get = (scope: string) => scope === 'global' ? { base: 'legacy-secret' } : undefined;
    expect(globalSettingsFor(get, 'software-dev', 'org_team')).toEqual({});
    expect(globalSettingsFor(get, 'software-dev', 'org_personal')).toEqual({ base: 'legacy-secret' });
  });
});

describe('quick-task defaults (separate overlay for the quick-add box)', () => {
  // The creation-time chain for a quick task in a project (highest → lowest):
  // task → project-quick → global-quick → project-general → global-general → default.
  const chain = (layers: {
    task?: Record<string, unknown>;
    projectQuick?: Record<string, unknown>;
    globalQuick?: Record<string, unknown>;
    project?: Record<string, unknown>;
    global?: Record<string, unknown>;
  }) => resolveParamsLayers(sd, [layers.task, layers.projectQuick, layers.globalQuick, layers.project, layers.global]);

  it('scope keys are namespaced so they never collide with general settings', () => {
    expect(quickScopeKey('global')).toBe('quick:global');
    expect(quickScopeKey('p1')).toBe('quick:p1');
    // A project id is never the literal string "global", so no ambiguity.
    expect(quickScopeKey('p1')).not.toBe('global');
  });

  it('global-quick overrides the general defaults for a quick task', () => {
    const r = chain({ globalQuick: { confirm: { mode: 'auto' } }, global: { confirm: { mode: 'human' } } });
    expect(r.confirm).toEqual({ mode: 'auto' });
  });

  it('organization-quick inherits (falls through) to the general organization default when unset', () => {
    const r = chain({ globalQuick: {}, global: { target: 'release' } });
    expect(r.target).toBe('release');
  });

  it('project-quick overrides global-quick', () => {
    const r = chain({ projectQuick: { confirm: { mode: 'human' } }, globalQuick: { confirm: { mode: 'auto' } } });
    expect(r.confirm).toEqual({ mode: 'human' });
  });

  it('project-quick inherits from global-quick before the project general default', () => {
    const r = chain({ globalQuick: { confirm: { mode: 'auto' } }, project: { confirm: { mode: 'human' } } });
    expect(r.confirm).toEqual({ mode: 'auto' }); // global-quick wins over project-general
  });

  it('project-quick falls through to the project general default when neither quick layer sets it', () => {
    const r = chain({ project: { target: 'prod' }, global: { target: 'main' } });
    expect(r.target).toBe('prod');
  });

  it('a task override still beats every default layer', () => {
    const r = chain({ task: { base: 'feature' }, projectQuick: { base: 'pq' }, globalQuick: { base: 'gq' }, project: { base: 'p' }, global: { base: 'g' } });
    expect(r.base).toBe('feature');
  });

  it('quick*SettingsFor read the namespaced rows and default to {}', () => {
    const rows: Record<string, Record<string, unknown>> = {
      'quick:global::software-dev': { confirm: { mode: 'auto' } },
      'quick:p1::software-dev': { base: 'qb' },
    };
    const get = (scopeKey: string, wf: string) => rows[`${scopeKey}::${wf}`];
    expect(quickGlobalSettingsFor(get, 'software-dev')).toEqual({ confirm: { mode: 'auto' } });
    expect(quickProjectSettingsFor(get, 'p1', 'software-dev')).toEqual({ base: 'qb' });
    expect(quickGlobalSettingsFor(() => undefined, 'software-dev')).toEqual({});
    expect(quickProjectSettingsFor(() => undefined, 'p1', 'software-dev')).toEqual({});
  });
});

describe('settingsToProjectConfig (mirror back to ProjectConfig)', () => {
  it('maps base/target to defaultBase/defaultTarget and binds workflow project fields', () => {
    const cfg = settingsToProjectConfig(sd, { base: 'main', target: 'prod', repos: ['~/r'], worldProvider: 'container' });
    expect(cfg.defaultBase).toBe('main');
    expect(cfg.defaultTarget).toBe('prod');
    expect(cfg.repos).toEqual([path.join(os.homedir(), 'r')]);
    expect(cfg.worldProvider).toBeUndefined(); // infrastructure is organization/project policy, not a workflow field
  });
});
