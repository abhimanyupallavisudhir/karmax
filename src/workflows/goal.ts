import { softwareDev, SoftwareDevInput } from './software-dev.js';
import { TaskInput, Stage } from './contract.js';

/**
 * goal (SPEC §4.7): like software-dev, but instead of pausing at the Review gate
 * it auto-sends "keep going" to the agent until the agent emits a structured
 * completion signal. Implemented as software-dev in goal mode (auto-confirm +
 * auto-continue) so the Setup/Merge/Resolve machinery is shared, not duplicated.
 */
export async function goal(input: TaskInput): Promise<{ stage: Stage; sha?: string }> {
  return softwareDev({ ...(input as SoftwareDevInput), goalMode: true, autoConfirm: true });
}
