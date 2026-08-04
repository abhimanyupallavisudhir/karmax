import {
  softwareDev,
  softwareDevV1,
  softwareDevV1_2,
  softwareDevV1_3,
  softwareDevV1_4,
  softwareDevV1_5,
  softwareDevV1_6,
  softwareDevV1_7,
  softwareDevV1_8,
  softwareDevV1_9,
  softwareDevV1_10,
  softwareDevV1_11,
  softwareDevV1_12,
  softwareDevV1_13,
  softwareDevV1_14,
  softwareDevV1_15,
  softwareDevV1_16,
  softwareDevV1_17,
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

/** Resumable platform lifecycle transitions. */
export async function goalV1_5(input: TaskInput): Promise<{ stage: Stage; sha?: string }> {
  return softwareDevV1_5({ ...(input as SoftwareDevInput), goalMode: true, autoConfirm: true });
}

/** Resumable lifecycle transitions plus acknowledged provider cancellation. */
export async function goalV1_6(input: TaskInput): Promise<{ stage: Stage; sha?: string }> {
  return softwareDevV1_6({ ...(input as SoftwareDevInput), goalMode: true, autoConfirm: true });
}

/** Human holds resume from the action that supplies their input. */
export async function goalV1_7(input: TaskInput): Promise<{ stage: Stage; sha?: string }> {
  return softwareDevV1_7({ ...(input as SoftwareDevInput), goalMode: true, autoConfirm: true });
}

/** Full GitHub pull-request lifecycle under remote policy 'pr'. */
export async function goalV1_8(input: TaskInput): Promise<{ stage: Stage; sha?: string }> {
  return softwareDevV1_8({ ...(input as SoftwareDevInput), goalMode: true, autoConfirm: true });
}

/** A task parked in a merge queue no longer republishes its whole view every
 *  five seconds. */
export async function goalV1_9(input: TaskInput): Promise<{ stage: Stage; sha?: string }> {
  return softwareDevV1_9({ ...(input as SoftwareDevInput), goalMode: true, autoConfirm: true });
}

/** Bounded coordinator retries, all merge domains published, the confirm latch
 *  cleared at each Review gate, escalation woken by a follow-up (see
 *  softwareDevV1_10 for why these are 1.10.0 and not 1.9.0). */
export async function goalV1_10(input: TaskInput): Promise<{ stage: Stage; sha?: string }> {
  return softwareDevV1_10({ ...(input as SoftwareDevInput), goalMode: true, autoConfirm: true });
}

/** Prepare PR branches before opening their pull requests. */
export async function goalV1_11(input: TaskInput): Promise<{ stage: Stage; sha?: string }> {
  return softwareDevV1_11({ ...(input as SoftwareDevInput), goalMode: true, autoConfirm: true });
}

/** GitHub-authoritative human merge authorization. */
export async function goalV1_12(input: TaskInput): Promise<{ stage: Stage; sha?: string }> {
  return softwareDevV1_12({ ...(input as SoftwareDevInput), goalMode: true, autoConfirm: true });
}

/** Explicit Open PR lifecycle; the Do agent owns proposal preparation. */
export async function goalV1_13(input: TaskInput): Promise<{ stage: Stage; sha?: string }> {
  return softwareDevV1_13({ ...(input as SoftwareDevInput), goalMode: true, autoConfirm: true });
}

/** Classified GitHub policy transitions and bounded GitHub error recovery. */
export async function goalV1_14(input: TaskInput): Promise<{ stage: Stage; sha?: string }> {
  return softwareDevV1_14({ ...(input as SoftwareDevInput), goalMode: true, autoConfirm: true });
}

/** Conflict-message fallback and recovery for already-running PR tasks. */
export async function goalV1_15(input: TaskInput): Promise<{ stage: Stage; sha?: string }> {
  return softwareDevV1_15({ ...(input as SoftwareDevInput), goalMode: true, autoConfirm: true });
}

/** Intent-authorized, provider-queued landing with automated repair review. */
export async function goalV1_16(input: TaskInput): Promise<{ stage: Stage; sha?: string }> {
  return softwareDevV1_16({ ...(input as SoftwareDevInput), goalMode: true, autoConfirm: true });
}

/** Review-gated adoption of task-created durable project resources. */
export async function goalV1_17(input: TaskInput): Promise<{ stage: Stage; sha?: string }> {
  return softwareDevV1_17({ ...(input as SoftwareDevInput), goalMode: true, autoConfirm: true });
}

/** Immutable replay entry for executions pinned to goal@1.0.0. */
export async function goalV1(input: TaskInput): Promise<{ stage: Stage; sha?: string }> {
  return softwareDevV1({ ...(input as SoftwareDevInput), goalMode: true, autoConfirm: true });
}
