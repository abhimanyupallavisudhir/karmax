/**
 * Features that roll out in stages (wiki features/early-access). A
 * user-facing change ships behind a flag here: first to the organizations that
 * asked for early access, then to everyone, then the flag and its `off` path
 * are deleted. The operator moves a flag between stages in Installation →
 * Early access; `stage` is where it starts.
 *
 * Workflow code never reads a flag (replay must not depend on mutable
 * settings): read it in the gateway or an activity, and pass the answer into
 * a workflow as input if one needs it.
 */
export type RolloutStage = 'off' | 'early' | 'on';
export const ROLLOUT_STAGES: readonly RolloutStage[] = ['off', 'early', 'on'];

export interface FeatureFlag {
  /** What it is, as people who opted in see it. */
  title: string;
  /** One sentence: what changes for them. */
  description: string;
  /** The stage it ships in, until the operator moves it. */
  stage: RolloutStage;
}

export const FEATURE_FLAGS: Record<string, FeatureFlag> = {};
