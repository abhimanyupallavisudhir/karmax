import { softwareDev, softwareDevV1, softwareDevV1_2, SoftwareDevInput } from './software-dev.js';
import { TaskInput, Stage } from './contract.js';

/**
 * goal (SPEC §4.7): like software-dev, but instead of pausing at the Review gate
 * it auto-confirms after the provider emits a verified successful terminal event.
 * Implemented as software-dev in goal mode so Setup/Merge/Resolve stay shared.
 */
export async function goal(input: TaskInput): Promise<{ stage: Stage; sha?: string }> {
  return softwareDev({ ...(input as SoftwareDevInput), goalMode: true, autoConfirm: true });
}

/** Current goal semantics: a verified successful provider turn completes the goal;
 * signal_completion is optional. */
export async function goalV1_2(input: TaskInput): Promise<{ stage: Stage; sha?: string }> {
  return softwareDevV1_2({ ...(input as SoftwareDevInput), goalMode: true, autoConfirm: true });
}

/** Immutable replay entry for executions pinned to goal@1.0.0. */
export async function goalV1(input: TaskInput): Promise<{ stage: Stage; sha?: string }> {
  return softwareDevV1({ ...(input as SoftwareDevInput), goalMode: true, autoConfirm: true });
}
