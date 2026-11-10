import { FEATURE_FLAGS, ROLLOUT_STAGES, type FeatureFlag, type RolloutStage } from '../config/feature-flags.js';
import type { Store } from '../store/db.js';

/**
 * Early access instead of a beta server (wiki features/early-access): a flag
 * is off, on for the organizations that opted in ("early"), or on for
 * everyone. The stages the operator set are one installation setting; an
 * organization's opt-in is one key.
 */
const STAGES_SETTING = 'feature-flags';
const optInKey = (organizationId: string) => `early-access:organization:${organizationId}`;

export function isRolloutStage(value: unknown): value is RolloutStage {
  return typeof value === 'string' && (ROLLOUT_STAGES as readonly string[]).includes(value);
}

/** Each flag's stage: the operator's choice, else the one it shipped with. */
export async function rolloutStages(store: Store, flags: Record<string, FeatureFlag> = FEATURE_FLAGS): Promise<Record<string, RolloutStage>> {
  const chosen = ((await store.getSettings('global', STAGES_SETTING)) ?? {}) as Record<string, unknown>;
  return Object.fromEntries(Object.entries(flags).map(([name, flag]) =>
    [name, isRolloutStage(chosen[name]) ? chosen[name] : flag.stage]));
}

export async function setRolloutStage(store: Store, name: string, stage: RolloutStage,
  flags: Record<string, FeatureFlag> = FEATURE_FLAGS): Promise<void> {
  if (!flags[name]) throw new Error(`no feature flag ${name}`);
  const chosen = ((await store.getSettings('global', STAGES_SETTING)) ?? {}) as Record<string, unknown>;
  // Back at the stage it shipped with, the flag follows the code again.
  const next = Object.fromEntries(Object.entries(chosen).filter(([key]) => key !== name && flags[key]));
  if (stage !== flags[name].stage) next[name] = stage;
  (await store.setSettings('global', STAGES_SETTING, next));
}

export async function hasEarlyAccess(store: Store, organizationId: string): Promise<boolean> {
  return (await store.kvGet(optInKey(organizationId))) === 'enabled';
}

export async function setEarlyAccess(store: Store, organizationId: string, enabled: boolean): Promise<void> {
  if (enabled) (await store.kvSet(optInKey(organizationId), 'enabled'));
  else (await store.kvDelete(optInKey(organizationId)));
}

/** The flags on for this organization. */
export async function enabledFeatures(store: Store, organizationId: string | undefined,
  flags: Record<string, FeatureFlag> = FEATURE_FLAGS): Promise<string[]> {
  const stages = (await rolloutStages(store, flags));
  const early = organizationId ? (await hasEarlyAccess(store, organizationId)) : false;
  return Object.keys(flags).filter((name) => stages[name] === 'on' || (stages[name] === 'early' && early));
}

export async function featureEnabled(store: Store, organizationId: string | undefined, name: string,
  flags: Record<string, FeatureFlag> = FEATURE_FLAGS): Promise<boolean> {
  return (await enabledFeatures(store, organizationId, flags)).includes(name);
}
