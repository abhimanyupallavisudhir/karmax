import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { manifest } from '../src/contrib/manifests.js';
import {
  resolveParams,
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
      global: { target: 'main', worldProvider: 'container' },
    });
    expect(r.prompt).toBe('do it');
    expect(r.base).toBe('feature'); // task wins
    expect(r.target).toBe('develop'); // project wins over global
    expect(r.worldProvider).toBe('container'); // global used (no task/project)
    expect(r.openGithubPr).toBe(false); // field default
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
      worldProvider: 'container',
      openGithubPr: true,
      'agent:do': { provider: 'codex', model: 'gpt-4.1', effort: 'high' },
    };
    const input = assembleTaskInput(sd, resolved, { taskId: 't1', projectId: 'p1', title: 'X', project: {} });
    expect(input.prompt).toBe('build X');
    expect(input.base).toBe('main');
    expect(input.target).toBe('release');
    expect(input.project.repos).toEqual([path.join(os.homedir(), 'code/app')]); // ~ expanded
    expect(input.project.copyGlobs).toEqual(['.env']);
    expect(input.project.worldProvider).toBe('container');
    expect(input.project.openGithubPr).toBe(true);
    expect(input.project.defaultBase).toBe('main'); // mirrored
    expect(input.project.defaultTarget).toBe('release');
    expect(input.agents?.do).toEqual({ provider: 'codex', model: 'gpt-4.1', effort: 'high' });
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
    expect(s.openGithubPr).toBe(true);
  });

  it('uses the stored settings row when present', () => {
    const stored = { base: 'develop', repos: ['/other'] };
    const s = projectSettingsFor(() => stored, project, 'software-dev');
    expect(s).toBe(stored);
  });

  it('globalSettingsFor returns {} when absent', () => {
    expect(globalSettingsFor(() => undefined, 'software-dev')).toEqual({});
  });
});

describe('settingsToProjectConfig (mirror back to ProjectConfig)', () => {
  it('maps base/target to defaultBase/defaultTarget and binds project fields', () => {
    const cfg = settingsToProjectConfig(sd, { base: 'main', target: 'prod', repos: ['~/r'], worldProvider: 'container' });
    expect(cfg.defaultBase).toBe('main');
    expect(cfg.defaultTarget).toBe('prod');
    expect(cfg.repos).toEqual([path.join(os.homedir(), 'r')]);
    expect(cfg.worldProvider).toBe('container');
  });
});
