import {
  softwareDev,
  softwareDevV1,
  softwareDevV1_2,
  softwareDevV1_3,
  softwareDevV1_4,
  SoftwareDevInput,
} from './software-dev.js';
import { TaskInput, Stage } from './contract.js';

/**
 * goal (SPEC §4.7): like software-dev, but instead of pausing at the Review gate
 * it keeps taking turns until the agent explicitly reports verified completion,
 * then auto-confirms.
 * Implemented as software-dev in goal mode so Setup/Merge/Resolve stay shared.
 */
export async function goal(input: TaskInput): Promise<{ stage: Stage; sha?: string }> {
  return softwareDev({ ...(input as SoftwareDevInput), goalMode: true, autoConfirm: true });
}

/** v1.2 provider-terminal semantics retained for replay. */
export async function goalV1_2(input: TaskInput): Promise<{ stage: Stage; sha?: string }> {
  return softwareDevV1_2({ ...(input as SoftwareDevInput), goalMode: true, autoConfirm: true });
}

/** Current goal workflow: explicit completion, switchable back to Software Dev
 * before confirmation. */
export async function goalV1_3(input: TaskInput): Promise<{ stage: Stage; sha?: string }> {
  return softwareDevV1_3({ ...(input as SoftwareDevInput), goalMode: true, autoConfirm: true });
}

/** Durable non-blocking host admission. */
export async function goalV1_4(input: TaskInput): Promise<{ stage: Stage; sha?: string }> {
  return softwareDevV1_4({ ...(input as SoftwareDevInput), goalMode: true, autoConfirm: true });
}

/** Immutable replay entry for executions pinned to goal@1.0.0. */
export async function goalV1(input: TaskInput): Promise<{ stage: Stage; sha?: string }> {
  return softwareDevV1({ ...(input as SoftwareDevInput), goalMode: true, autoConfirm: true });
}
