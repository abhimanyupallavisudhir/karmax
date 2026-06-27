import type { Client } from '@temporalio/client';
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
  if (deps.store && deps.worlds && deps.adapters && deps.profiles) {
    Object.assign(activities, makeCoreActivities(deps as CoreActivityDeps));
  }
  if (deps.client && deps.taskQueue) {
    Object.assign(activities, makeCoordinatorActivities({ client: deps.client, taskQueue: deps.taskQueue }));
  }
  return activities;
}

export type Activities = ReturnType<typeof buildActivities>;
