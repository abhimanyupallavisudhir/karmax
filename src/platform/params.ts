import { FieldSpec, FieldMutable, TaskInput, AgentSpec, ConfirmConfig, ProjectConfig, Project } from '../domain/types.js';
import { confirmLayersOf } from '../domain/confirm.js';
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
  return resolveParamsLayers(manifest, [layers.task, layers.project, layers.global]);
}

/**
 * Resolve field values from an arbitrary ordered stack of overlays, highest
 * precedence first (task → … → global), falling through empty layers to the
 * field default. Generalizes the fixed task/project/global chain so the quick-task
 * defaults layers (quick-project → quick-global) can be spliced above the general
 * ones (SPEC §10.4 overlay).
 */
export function resolveParamsLayers(manifest: WorkflowManifest, layers: (ValueMap | undefined)[]): ValueMap {
  const out: ValueMap = {};
  for (const f of manifest.params) {
    let v: unknown = f.default;
    // Fold from lowest precedence up: each non-empty higher layer wins.
    for (let i = layers.length - 1; i >= 0; i--) v = pick(layers[i]?.[f.name], v);
    if (v !== undefined) out[f.name] = v;
  }
  return out;
}

function pick<T>(a: T, fallback: T): T {
  // An empty value at a layer means "don't override" — defer to the layer below.
  // Empty arrays count: a blank `repos`/`copyGlobs` list in project settings must
  // fall through to the configured value, not shadow it with `[]` (which would
  // silently strip a project's repo and drop the task into a scratch sandbox).
  const empty = a === undefined || a === null || a === '' || (Array.isArray(a) && a.length === 0);
  return empty ? fallback : a;
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
      case 'confirm': {
        // The confirmer field carries the ordered Review-gate LAYERS — each a human
        // confirmation or a Confirm-agent turn (with the same agent knobs as a
        // bind:'profile' field); [] ⇒ auto-confirm. Legacy single-gate {mode} values
        // (old stored settings/drafts) normalize to their layer equivalents, so the
        // workflow only ever sees layers. Each agent layer carries its own spec —
        // the workflow lands it on agents[role] per layer at turn time, so nothing
        // is registered here.
        if (v && typeof v === 'object') {
          const layers = confirmLayersOf(v as ConfirmConfig).map((l) =>
            l.kind === 'agent'
              ? {
                  kind: l.kind,
                  ...(l.provider ? { provider: l.provider } : {}),
                  ...(l.model ? { model: l.model } : {}),
                  ...(l.effort ? { effort: l.effort } : {}),
                  ...(l.resumeFrom ? { resumeFrom: l.resumeFrom } : {}),
                  ...(l.prompt?.trim() ? { prompt: l.prompt } : {}),
                }
              : { kind: l.kind },
          );
          input.confirm = { layers };
        }
        break;
      }
    }
  }
  if (Object.keys(agents).length) input.agents = agents;
  // Mirror base/target into project defaults so the workflow's fallbacks are coherent.
  if (input.base) input.project.defaultBase = input.base;
  if (input.target) input.project.defaultTarget = input.target;
  // Carry the in-flight editability windows into the workflow so its update
  // validator can enforce them without importing the manifest into the Temporal
  // sandbox (SPEC §4.5/§5.5). Sparse: only non-`queue` fields.
  const windows: Record<string, FieldMutable> = {};
  for (const f of manifest.params) if (f.mutable && f.mutable !== 'queue') windows[f.name] = f.mutable;
  if (Object.keys(windows).length) input.paramWindows = windows;
  return input;
}

function toList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String).filter(Boolean);
  if (typeof v === 'string') return v.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
  return [];
}

/**
 * The repo list a world will actually be built from — the resolved `repos` overlay
 * when set, else the project config's repos. Mirrors how `assembleTaskInput` fills
 * `input.project.repos` (which flows into `createWorld`), so callers can guard on
 * exactly what the world provider will see rather than on `project.config` alone
 * (those two can diverge — an empty overlay used to slip past the guard and drop a
 * repo-oriented task into a silent scratch sandbox).
 */
export function effectiveRepos(resolved: ValueMap, config: ProjectConfig): string[] {
  const raw = resolved.repos !== undefined ? toList(resolved.repos) : config.repos ?? [];
  return raw.map((s) => String(s).trim()).filter((s) => s.length > 0);
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

/**
 * Quick-task defaults (SPEC §10.4) — a separate overlay that applies ONLY to tasks
 * added from the quick-task box (not the full task form). Stored under a `quick:`
 * namespaced scope key so it never collides with the general defaults, and starts
 * empty (no legacy back-compat derivation): quick defaults are purely opt-in and
 * inherit from the general defaults until a field is set.
 *
 * Effective value for a quick task in a project (highest → lowest precedence):
 *   task override → project-quick → global-quick → project-general → global-general → field default.
 * That chain realizes the two inheritances the settings UI exposes: global-quick
 * inherits from global-general, and project-quick inherits from global-quick (its
 * natural parent) with the project-general defaults as the alternative source.
 */
export function quickScopeKey(scope: 'global' | string): string {
  return scope === 'global' ? 'quick:global' : `quick:${scope}`;
}

export function quickGlobalSettingsFor(
  getSettings: (scopeKey: string, workflow: string) => ValueMap | undefined,
  workflow: string,
): ValueMap {
  return getSettings(quickScopeKey('global'), workflow) ?? {};
}

export function quickProjectSettingsFor(
  getSettings: (scopeKey: string, workflow: string) => ValueMap | undefined,
  projectId: string,
  workflow: string,
): ValueMap {
  return getSettings(quickScopeKey(projectId), workflow) ?? {};
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
