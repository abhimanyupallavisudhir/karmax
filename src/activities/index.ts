import { makeTurnPreparationActivities } from './turn-preparation.js';
import type { Client } from '@temporalio/client';
import { makeChildActivities } from './children.js';
import { pingActivities } from './ping.js';
import { makeCoreActivities, CoreActivityDeps } from './core.js';
import { makeCoordinatorActivities } from './coordinator.js';

/**
 * Dependencies activities close over. Activities are the only place side effects
 * happen (SPEC §3.1); they hold the store, world providers, agent runtime, and
 * the Temporal client (for signal-with-start into coordinators).
 */
export interface ActivityDeps extends Partial<CoreActivityDeps> {
  client?: Client;
  taskQueue?: string;
}

/** The full activity surface registered on the worker. */
export function buildActivities(deps: ActivityDeps = {}) {
  const activities: Record<string, (...args: any[]) => any> = { ...pingActivities };
  const core = deps.store && deps.worlds && deps.adapters && deps.profiles
    ? makeCoreActivities(deps as CoreActivityDeps) : undefined;
  if (core) Object.assign(activities, core);
  if (deps.client && deps.taskQueue) {
    const coordinator = makeCoordinatorActivities({
      client: deps.client,
      taskQueue: deps.taskQueue,
      ...(deps.store ? { store: deps.store } : {}),
    });
    Object.assign(activities, coordinator);
    if (core) Object.assign(activities, makeTurnPreparationActivities(core, coordinator));
  }
  if (deps.store) Object.assign(activities, makeChildActivities(deps.store));
  return activities;
}

export type Activities = ReturnType<typeof buildActivities>;
