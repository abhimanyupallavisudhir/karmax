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

  it('migrates the former unified Do/Merge wire value onto the sole Do agent', () => {
    const doAgent = { provider: 'codex', model: 'do-model', resumeFrom: { taskId: 'old' } };
    const mergeAgent = { provider: 'claude', model: 'merge-model', resumeFrom: { taskId: 'merge-old' } };

    const migratedUnified = resolveParams(sd, {
      task: { separateAgents: true },
      project: { separateAgents: false, 'agent:unified': doAgent },
    });
    expect(migratedUnified['agent:do']).toEqual(doAgent);
    expect(migratedUnified['agent:merge']).toBeUndefined();

    const migratedSeparated = resolveParams(sd, {
      task: { separateAgents: false },
      project: {
        separateAgents: true,
        'agent:do': doAgent,
        'agent:merge': mergeAgent,
      },
    });
    expect(migratedSeparated['agent:do']).toEqual(doAgent);
    expect(migratedSeparated['agent:merge']).toBeUndefined();
  });

  it('migrates old Merge-only agent overrides onto the shared Agent field', () => {
    const mergeOnly = manifest('merge-only')!;
    const legacy = { provider: 'claude', model: 'legacy-merge-model' };
    const resolved = resolveParams(mergeOnly, { task: { 'agent:merge': legacy } });
    expect(resolved['agent:do']).toEqual(legacy);
    expect(resolved['agent:merge']).toBeUndefined();
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

  // The Review route is consumed by the gate it drives, not by queueing (SPEC §4.5/§5.5).
  // Its window has to reach the workflow, or the update validator has nothing to enforce.
  it('carries the Review route as an `untilUsed` window, on every workflow that has one', () => {
    const input = assembleTaskInput(sd, { prompt: 'build X' }, { taskId: 't1', projectId: 'p1', title: 'X', project: {} });
    expect(input.paramWindows?.confirm).toBe('untilUsed');
    for (const name of ['software-dev', 'just-do', 'goal', 'merge-only']) {
      const field = manifest(name)!.params.find((f) => f.type === 'confirmer')!;
      expect([name, field.mutable]).toEqual([name, 'untilUsed']);
    }
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

  it('merges shared defaults beneath workflow-specific settings', () => {
    const get = (_scope: string, workflow: string) => workflow === '__common__'
      ? { base: 'shared', target: 'main' } : workflow === 'software-dev' ? { base: 'workflow' } : undefined;
    expect(projectSettingsFor(get, project, 'software-dev')).toMatchObject({ base: 'workflow', target: 'main' });
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

describe('quick-task agent defaults (separate overlay for the quick-add box)', () => {
  // The creation-time chain for an agent field on a quick task (highest → lowest):
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

  it('global-quick overrides the regular agent defaults for a quick task', () => {
    const r = chain({ globalQuick: { 'agent:do': { provider: 'codex' } }, global: { 'agent:do': { provider: 'claude' } } });
    expect(r['agent:do']).toMatchObject({ provider: 'codex' });
  });

  it('organization-quick inherits the regular organization agent when unset', () => {
    const r = chain({ globalQuick: {}, global: { 'agent:do': { provider: 'claude' } } });
    expect(r['agent:do']).toMatchObject({ provider: 'claude' });
  });

  it('project-quick overrides global-quick', () => {
    const r = chain({ projectQuick: { 'agent:do': { provider: 'claude' } }, globalQuick: { 'agent:do': { provider: 'codex' } } });
    expect(r['agent:do']).toMatchObject({ provider: 'claude' });
  });

  it('project-quick inherits from global-quick before the project general default', () => {
    const r = chain({ globalQuick: { 'agent:do': { provider: 'codex' } }, project: { 'agent:do': { provider: 'claude' } } });
    expect(r['agent:do']).toMatchObject({ provider: 'codex' });
  });

  it('project-quick falls through to the regular project agent when neither quick layer sets it', () => {
    const r = chain({ project: { 'agent:do': { provider: 'claude' } }, global: { 'agent:do': { provider: 'codex' } } });
    expect(r['agent:do']).toMatchObject({ provider: 'claude' });
  });

  it('a task override still beats every default layer', () => {
    const r = chain({
      task: { 'agent:do': { provider: 'mock' } },
      projectQuick: { 'agent:do': { provider: 'claude' } },
      globalQuick: { 'agent:do': { provider: 'codex' } },
    });
    expect(r['agent:do']).toMatchObject({ provider: 'mock' });
  });

  it('quick*SettingsFor read the namespaced rows and default to {}', () => {
    const rows: Record<string, Record<string, unknown>> = {
      'quick:global::software-dev': { confirm: { mode: 'auto' }, 'agent:do': { provider: 'codex' } },
      'quick:p1::software-dev': { base: 'qb', 'agent:merge': { provider: 'claude' } },
    };
    const get = (scopeKey: string, wf: string) => rows[`${scopeKey}::${wf}`];
    expect(quickGlobalSettingsFor(get, 'software-dev')).toEqual({ 'agent:do': { provider: 'codex' } });
    expect(quickProjectSettingsFor(get, 'p1', 'software-dev')).toEqual({ 'agent:merge': { provider: 'claude' } });
    expect(quickGlobalSettingsFor(() => undefined, 'software-dev')).toEqual({});
    expect(quickProjectSettingsFor(() => undefined, 'p1', 'software-dev')).toEqual({});
  });

  it('can disable the shared Quick overlay without deleting its values', () => {
    const get = (_scope: string, workflow: string) => workflow === '__common__' ? { _enabled: false, 'agent:do': { provider: 'codex' } } : undefined;
    expect(quickProjectSettingsFor(get, 'p1', 'software-dev')).toEqual({});
  });
});

describe('settingsToProjectConfig (mirror back to ProjectConfig)', () => {
  it('maps base/target to defaultBase/defaultTarget and binds workflow project fields', () => {
    const cfg = settingsToProjectConfig(sd, { base: 'main', target: 'prod', repos: ['~/r'], worldProvider: 'container' });
    expect(cfg.defaultBase).toBe('main');
    expect(cfg.defaultTarget).toBe('prod');
    expect(cfg.repos).toEqual([path.join(os.homedir(), 'r')]);
    // "Agent environment" is now a task default (bind:'project'), so it mirrors back
    // to ProjectConfig.worldProvider like the other project-bound fields.
    expect(cfg.worldProvider).toBe('container');
  });
});
