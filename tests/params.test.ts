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
