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

  it('allows several branches per task unless a layer turns it off', () => {
    expect(resolveParams(sd, {}).multiPr).toBe(true);
    expect(resolveParams(sd, { project: { multiPr: false } }).multiPr).toBe(false);
    expect(resolveParams(sd, { task: { multiPr: true }, project: { multiPr: false } }).multiPr).toBe(true);
    expect(assembleTaskInput(sd, resolveParams(sd, { task: { prompt: 'x' } }),
      { taskId: 't1', projectId: 'p1', title: 'X', project: {} }).project.multiPr).toBe(true);
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

  it('layers the task\'s own Computer onto the project\'s effective execution config', () => {
    const project = { worldProvider: 'e2b', resources: { cpu: 2, memoryMb: 2048 }, environment: { flavor: 'headless' as const },
      network: { unrestricted: true }, hibernateAfterMs: 604_800_000 };
    const input = assembleTaskInput(sd, { prompt: 'x', computer: { provider: 'daytona', diskGb: 60, hibernateAfterDays: 1 } },
      { taskId: 't1', projectId: 'p1', title: 'X', project });
    expect(input.project).toMatchObject({ worldProvider: 'daytona', resources: { cpu: 2, memoryMb: 2048, diskGb: 60 },
      environment: { flavor: 'headless' }, hibernateAfterMs: 86_400_000 });
    // A running task can resize its computer, so the field is editable in flight.
    expect(input.paramWindows?.computer).toBe('always');
    // No computer of its own: the project's computer, unchanged.
    expect(assembleTaskInput(sd, { prompt: 'x' }, { taskId: 't1', projectId: 'p1', title: 'X', project }).project).toEqual(project);
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

  it('carries the single human or agent Responder into workflow input', () => {
    const human = assembleTaskInput(sd, {
      prompt: 'build X', responder: { kind: 'human', audience: ['@team:leaders'] },
    }, { taskId: 't1', projectId: 'p1', title: 'X', project: {} });
    expect(human.responder).toEqual({ kind: 'human', audience: ['@team:leaders'] });

    const agent = assembleTaskInput(sd, {
      prompt: 'build X',
      responder: { kind: 'agent', provider: 'mock', model: 'answerer', effort: 'low', prompt: 'Answer {{question}}' },
    }, { taskId: 't2', projectId: 'p1', title: 'X', project: {} });
    expect(agent.responder).toEqual({
      kind: 'agent', provider: 'mock', model: 'answerer', effort: 'low', prompt: 'Answer {{question}}',
    });
  });

  it('declares one inherited Responder on task, project, and global forms', () => {
    for (const name of ['software-dev', 'goal']) {
      const field = manifest(name)!.params.find((candidate) => candidate.name === 'responder');
      expect(field).toMatchObject({
        type: 'responder', bind: 'responder', role: 'responder',
        scopes: ['task', 'project', 'global'],
        default: { kind: 'human', audience: ['@creator'] },
        mutable: 'always',
      });
    }
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

  it('derives from ProjectConfig when no settings row exists', async () => {
    const s = (await projectSettingsFor(() => undefined, project, 'software-dev'));
    expect(s.base).toBe('main');
    expect(s.target).toBe('prod');
    expect(s.repos).toEqual(['/r']);
    expect(s.remote).toBe('pr');
  });

  it('uses the stored settings row when present', async () => {
    const stored = { base: 'develop', repos: ['/other'] };
    const s = (await projectSettingsFor(() => stored, project, 'software-dev'));
    expect(s).toBe(stored);
  });

  it('merges shared defaults beneath workflow-specific settings', async () => {
    const get = (_scope: string, workflow: string) => workflow === '__common__'
      ? { base: 'shared', target: 'main' } : workflow === 'software-dev' ? { base: 'workflow' } : undefined;
    expect((await projectSettingsFor(get, project, 'software-dev'))).toMatchObject({ base: 'workflow', target: 'main' });
  });

  it('globalSettingsFor returns {} when absent', async () => {
    expect((await globalSettingsFor(() => undefined, 'software-dev'))).toEqual({});
  });

  it('never leaks legacy installation defaults into a new organization', async () => {
    const get = (scope: string) => scope === 'global' ? { base: 'legacy-secret' } : undefined;
    expect((await globalSettingsFor(get, 'software-dev', 'org_team'))).toEqual({});
    expect((await globalSettingsFor(get, 'software-dev', 'org_personal'))).toEqual({ base: 'legacy-secret' });
  });
});

describe('one defaults chain for every task', () => {
  it('a task beats its project, which beats its organization (there is no quick-task layer)', () => {
    const r = resolveParamsLayers(sd, [{ 'agent:do': { provider: 'mock' } }, { 'agent:do': { provider: 'claude' } }, { 'agent:do': { provider: 'codex' } }]);
    expect(r['agent:do']).toMatchObject({ provider: 'mock' });
    expect(resolveParamsLayers(sd, [undefined, { 'agent:do': { provider: 'claude' } }, { 'agent:do': { provider: 'codex' } }])['agent:do']).toMatchObject({ provider: 'claude' });
  });
});

describe('settingsToProjectConfig (mirror back to ProjectConfig)', () => {
  it('maps base/target to defaultBase/defaultTarget and binds workflow project fields', () => {
    const cfg = settingsToProjectConfig(sd, { base: 'main', target: 'prod', repos: ['~/r'], computer: { provider: 'container' } });
    expect(cfg.defaultBase).toBe('main');
    expect(cfg.defaultTarget).toBe('prod');
    expect(cfg.repos).toEqual([path.join(os.homedir(), 'r')]);
    // The Computer is stored in the execution policy by its own path, never
    // copied wholesale into ProjectConfig.
    expect(cfg).not.toHaveProperty('computer');
    expect(cfg).not.toHaveProperty('worldProvider');
  });
});
