import { FieldSpec, FieldMutable, TaskInput, AgentSpec, ConfirmConfig, ProjectConfig, Project } from '../domain/types.js';
import { confirmLayersOf } from '../domain/confirm.js';
import { WorkflowManifest } from '../contrib/manifests.js';
import { expandPath } from '../util/expand.js';
import { RESOLVE_AGENT_ENABLED } from '../config/features.js';

/**
 * Parameter resolution + assembly (SPEC §10.4). A single declared FieldSpec
 * schema drives task forms, project/global settings, and the values that reach a
 * workflow. Effective value = task override → project setting → global setting →
 * field default (the §9 overlay model). The assembler then maps each resolved
 * value into TaskInput via the field's `bind`, so no per-workflow code is needed.
 */

export type ValueMap = Record<string, unknown>;
/** Shared settings are declared once and consumed by every workflow that has a
 * field with the same name. Workflow rows now contain only genuinely unique
 * settings; the merge keeps historical per-workflow rows working. */
export const COMMON_SETTINGS_WORKFLOW = '__common__';

function withCommon(
  getSettings: (scopeKey: string, workflow: string) => ValueMap | undefined,
  scopeKey: string,
  workflow: string,
): ValueMap | undefined {
  const common = getSettings(scopeKey, COMMON_SETTINGS_WORKFLOW);
  const specific = getSettings(scopeKey, workflow);
  if (common === specific) return specific;
  return common || specific ? { ...(common ?? {}), ...(specific ?? {}) } : undefined;
}

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
  resolveAgentGroup(manifest, layers, out);
  return out;
}

const AGENT_GROUP_ROLES: readonly string[] = ['do', 'merge', ...(RESOLVE_AGENT_ENABLED ? ['resolve'] : [])];

/**
 * Do/Merge have a compact, unified editor by default. The editor shape is
 * itself an inherited setting: a unified child inherits only its parent's Do
 * agent and applies that identity to both roles; a separated child inherits
 * each corresponding parent role. Fork/session state is deliberately copied only
 * to Do when a unified value fans out.
 *
 * Older rows predate `separateAgents`; infer their old separate form when they
 * contain any role override so existing settings retain their meaning.
 */
function resolveAgentGroup(manifest: WorkflowManifest, layers: (ValueMap | undefined)[], out: ValueMap): void {
  const names = new Set(manifest.params.filter((f) => f.type === 'agent' && f.role).map((f) => f.role));
  if (!AGENT_GROUP_ROLES.every((role) => names.has(role))) return;

  const resolved: Record<string, unknown> = {};
  let topSeparate = false;
  let sawLayer = false;
  for (let i = layers.length - 1; i >= 0; i--) {
    const layer = layers[i];
    if (!layer) continue;
    sawLayer = true;
    const separate = layer.separateAgents === true ||
      (layer.separateAgents === undefined && AGENT_GROUP_ROLES.some((role) => layer[`agent:${role}`] !== undefined));
    topSeparate = separate;
    if (separate) {
      for (const role of AGENT_GROUP_ROLES) resolved[role] = pick(layer[`agent:${role}`], resolved[role]);
      continue;
    }
    const unified = pick(layer['agent:unified'], pick(layer['agent:do'], resolved.do));
    if (unified !== undefined) {
      resolved.do = unified;
      resolved.merge = withoutResume(unified);
      if (RESOLVE_AGENT_ENABLED) resolved.resolve = withoutResume(unified);
    }
  }
  for (const role of AGENT_GROUP_ROLES) {
    if (resolved[role] !== undefined) out[`agent:${role}`] = resolved[role];
  }
  if (sawLayer) out.separateAgents = topSeparate;
  if (resolved.do !== undefined) out['agent:unified'] = resolved.do;
}

function withoutResume(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const { resumeFrom: _resumeFrom, ...rest } = value as Record<string, unknown>;
  return rest;
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
              : { kind: l.kind, audience: l.audience?.length ? [...l.audience] : ['@creator'] },
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
  const stored = withCommon(getSettings, project.id, workflow);
  if (stored) return stored;
  const c = project.config ?? {};
  const derived: ValueMap = {};
  if (c.defaultBase) derived.base = c.defaultBase;
  if (c.defaultTarget) derived.target = c.defaultTarget;
  if (c.repos?.length) derived.repos = c.repos;
  if (c.copyGlobs?.length) derived.copyGlobs = c.copyGlobs;
  if (c.worldProvider) derived.worldProvider = c.worldProvider;
  // The deprecated openGithubPr flag surfaces as its successor (PLAN-git-config §5).
  if (c.remote ?? c.openGithubPr) derived.remote = c.remote ?? 'pr';
  if (c.gitProfile) derived.gitProfile = c.gitProfile;
  return derived;
}

export function globalSettingsFor(
  getSettings: (scopeKey: string, workflow: string) => ValueMap | undefined,
  workflow: string,
  organizationId?: string,
): ValueMap {
  if (organizationId) {
    return withCommon(getSettings, `organization:${organizationId}`, workflow)
      // Only the migration-created personal tenant may read historical global
      // rows. A newly-created organization must never inherit another tenant's
      // old installation settings.
      ?? (organizationId === 'org_personal' ? withCommon(getSettings, 'global', workflow) : undefined)
      ?? {};
  }
  return withCommon(getSettings, 'global', workflow) ?? {};
}

/**
 * Quick-task agent defaults (SPEC §10.4) — a separate, agent-only overlay that
 * applies ONLY to tasks added from the quick-task box (not the full task form).
 * It starts empty and is opt-in. Filtering on read also prevents historical
 * non-agent values in these rows from changing branch, review, or remote policy.
 *
 * Effective value for a quick task in a project (highest → lowest precedence):
 *   task override → project-quick → global-quick → project-general → global-general → field default.
 * The chain applies to agent fields only: global-quick inherits from
 * global-general, while project-quick inherits from global-quick and then the
 * project's regular agent defaults.
 */
export function quickScopeKey(scope: 'global' | string): string {
  return scope === 'global' ? 'quick:global' : `quick:${scope}`;
}

function quickAgentsOnly(values: ValueMap | undefined): ValueMap | undefined {
  if (!values) return undefined;
  return Object.fromEntries(Object.entries(values).filter(([name]) => name === '_enabled' || name === 'separateAgents' || name.startsWith('agent:')));
}

export function quickGlobalSettingsFor(
  getSettings: (scopeKey: string, workflow: string) => ValueMap | undefined,
  workflow: string,
  organizationId?: string,
): ValueMap {
  if (organizationId) {
    const key = `quick:organization:${organizationId}`;
    const common = getSettings(key, COMMON_SETTINGS_WORKFLOW);
    if (common?._enabled === false) return {};
    return quickAgentsOnly(withCommon(getSettings, key, workflow)
      ?? (organizationId === 'org_personal' ? withCommon(getSettings, quickScopeKey('global'), workflow) : undefined))
      ?? {};
  }
  const key = quickScopeKey('global');
  if (getSettings(key, COMMON_SETTINGS_WORKFLOW)?._enabled === false) return {};
  return quickAgentsOnly(withCommon(getSettings, key, workflow)) ?? {};
}

export function quickProjectSettingsFor(
  getSettings: (scopeKey: string, workflow: string) => ValueMap | undefined,
  projectId: string,
  workflow: string,
): ValueMap {
  const key = quickScopeKey(projectId);
  if (getSettings(key, COMMON_SETTINGS_WORKFLOW)?._enabled === false) return {};
  return quickAgentsOnly(withCommon(getSettings, key, workflow)) ?? {};
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
