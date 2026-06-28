import { FieldSpec, TaskInput, AgentSpec, ProjectConfig, Project } from '../domain/types.js';
import { WorkflowManifest } from '../contrib/manifests.js';
import { expandPath } from '../util/expand.js';

/**
 * Parameter resolution + assembly (SPEC §10.4). A single declared FieldSpec
 * schema drives task forms, project/global settings, and the values that reach a
 * workflow. Effective value = task override → project setting → global setting →
 * field default (the §9 overlay model). The assembler then maps each resolved
 * value into TaskInput via the field's `bind`, so no per-workflow code is needed.
 */

export type ValueMap = Record<string, unknown>;

export function resolveParams(
  manifest: WorkflowManifest,
  layers: { task?: ValueMap; project?: ValueMap; global?: ValueMap },
): ValueMap {
  const out: ValueMap = {};
  for (const f of manifest.params) {
    const v = pick(layers.task?.[f.name], pick(layers.project?.[f.name], pick(layers.global?.[f.name], f.default)));
    if (v !== undefined) out[f.name] = v;
  }
  return out;
}

function pick<T>(a: T, fallback: T): T {
  return a === undefined || a === null || a === '' ? fallback : a;
}

/** Build a TaskInput from resolved field values, by each field's `bind`. */
export function assembleTaskInput(
  manifest: WorkflowManifest,
  resolved: ValueMap,
  ctx: { taskId: string; projectId: string; title: string; project: ProjectConfig; parentTaskId?: string; grant?: string[] },
): TaskInput {
  const input: TaskInput = {
    taskId: ctx.taskId,
    projectId: ctx.projectId,
    title: ctx.title,
    prompt: '',
    project: { ...ctx.project },
    ...(ctx.parentTaskId ? { parentTaskId: ctx.parentTaskId } : {}),
    ...(ctx.grant ? { grant: ctx.grant } : {}),
  };
  const agents: Record<string, AgentSpec> = {};

  for (const f of manifest.params) {
    const v = resolved[f.name];
    if (v === undefined) continue;
    switch (f.bind) {
      case 'prompt':
        input.prompt = String(v);
        break;
      case 'top':
        (input as any)[f.name] = f.type === 'list' ? toList(v) : v;
        break;
      case 'project':
        (input.project as any)[f.name] = f.type === 'list' ? expandList(f.name, toList(v)) : v;
        break;
      case 'profile':
        if (f.role && v && typeof v === 'object' && (v as AgentSpec).provider) agents[f.role] = v as AgentSpec;
        break;
    }
  }
  if (Object.keys(agents).length) input.agents = agents;
  // Mirror base/target into project defaults so the workflow's fallbacks are coherent.
  if (input.base) input.project.defaultBase = input.base;
  if (input.target) input.project.defaultTarget = input.target;
  return input;
}

function toList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String).filter(Boolean);
  if (typeof v === 'string') return v.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
  return [];
}

function expandList(name: string, list: string[]): string[] {
  return name === 'repos' ? list.map(expandPath) : list;
}

/**
 * Project-scope settings for a workflow: the stored row if present, else derived
 * from the project's legacy ProjectConfig (lazy back-compat — no destructive
 * migration). Saving the project-settings form writes the row going forward.
 */
export function projectSettingsFor(
  getSettings: (scopeKey: string, workflow: string) => ValueMap | undefined,
  project: Project,
  workflow: string,
): ValueMap {
  const stored = getSettings(project.id, workflow);
  if (stored) return stored;
  const c = project.config ?? {};
  const derived: ValueMap = {};
  if (c.defaultBase) derived.base = c.defaultBase;
  if (c.defaultTarget) derived.target = c.defaultTarget;
  if (c.repos?.length) derived.repos = c.repos;
  if (c.copyGlobs?.length) derived.copyGlobs = c.copyGlobs;
  if (c.worldProvider) derived.worldProvider = c.worldProvider;
  if (c.openGithubPr !== undefined) derived.openGithubPr = c.openGithubPr;
  return derived;
}

export function globalSettingsFor(
  getSettings: (scopeKey: string, workflow: string) => ValueMap | undefined,
  workflow: string,
): ValueMap {
  return getSettings('global', workflow) ?? {};
}

/** When project settings are saved, mirror bound-project fields into ProjectConfig (back-compat). */
export function settingsToProjectConfig(manifest: WorkflowManifest, values: ValueMap): Partial<ProjectConfig> {
  const cfg: Partial<ProjectConfig> = {};
  for (const f of manifest.params) {
    const v = values[f.name];
    if (v === undefined) continue;
    if (f.name === 'base') cfg.defaultBase = String(v);
    else if (f.name === 'target') cfg.defaultTarget = String(v);
    else if (f.bind === 'project') (cfg as any)[f.name] = f.type === 'list' ? expandList(f.name, toList(v)) : v;
  }
  return cfg;
}
