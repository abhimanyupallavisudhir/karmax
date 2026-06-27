import { AgentAdapter, PlatformToolContext, TurnInput, TurnResult } from './types.js';
import { Provider, ReviewInfo } from '../domain/types.js';

export interface RunTurnDeps {
  adapters: Map<Provider, AgentAdapter>;
  /** Stream incremental output to the task's live event log. */
  onEmit?: (text: string) => void;
}

/**
 * Run exactly one agent turn (SPEC §7.2). Builds the platform-tool context the
 * agent acts through, dispatches to the provider adapter, and assembles the
 * structured TurnResult. Errors propagate so the workflow's Resolve path runs.
 */
export async function runTurn(input: TurnInput, deps: RunTurnDeps): Promise<TurnResult> {
  const adapter = deps.adapters.get(input.profile.provider);
  if (!adapter) throw new Error(`no agent adapter for provider "${input.profile.provider}"`);

  let completed = false;
  let reviewInfo: ReviewInfo | undefined;
  const subTasks: { title: string; prompt: string }[] = [];
  const skills: { name: string; content: string }[] = [];

  const ctx: PlatformToolContext = {
    signalCompletion(summary) {
      completed = true;
      if (summary && !reviewInfo?.summary) reviewInfo = { ...reviewInfo, summary };
    },
    createReviewInfo(info) {
      reviewInfo = { ...reviewInfo, ...info };
    },
    createSubTask(t) {
      subTasks.push(t);
    },
    saveSkill(s) {
      skills.push(s);
    },
    emit(text) {
      deps.onEmit?.(text);
    },
  };

  const turn = await adapter.runTurn(input, ctx);

  return {
    session: turn.session,
    completed,
    output: turn.output,
    reviewInfo,
    subTasks: subTasks.length ? subTasks : undefined,
    skills: skills.length ? skills : undefined,
    // If the agent did work but didn't signal completion and spawned no sub-tasks,
    // it is surfaced as needs-input (Review stage will show its output).
    needsInput: !completed && subTasks.length === 0,
  };
}
