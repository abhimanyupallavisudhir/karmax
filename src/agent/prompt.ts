import { AgentProfile, AgentRole, TaskInput } from '../domain/types.js';
import { WorldHandle } from '../world/types.js';

/**
 * Prompt assembly (SPEC §5.4). Fills the role template (owned by the profile)
 * with task bindings (owned by the workflow) plus global/project instructions,
 * then the result is snapshotted as the journaled turn input.
 *
 * `{{...}}` bindings are filled here; `[[...]]` content links would be resolved
 * from the content store (skills/memory) — represented inline for v1.
 */

const TOOLS_PREAMBLE = `You are running inside karmax, an agent-orchestration platform. Your work happens in a git world (working directory). You have these platform tools available:
- create_sub_task(title, prompt): spawn a child task the parent awaits.
- create_review_info(summary, links?, diff?, html?): attach polished review output for the human/parent at the Review stage.
- save_skill(name, content): persist a reusable skill for future tasks.
- signal_completion(summary?): structured signal that your turn's work is complete. Call this exactly when you are done — do not write a "done" sentence instead.
Do real work directly in the working directory (create/edit files, run commands). When finished, call signal_completion.`;

export const DEFAULT_ROLE_TEMPLATES: Record<string, string> = {
  do: `{{toolsPreamble}}

# Task
{{title}}

{{prompt}}

# World
Working directory: {{worldPath}} (branch {{branch}} off {{base}}).

{{instructions}}`,
  merge: `{{toolsPreamble}}

You are merging task "{{title}}". Its work is on branch {{branch}} in the worktree at {{worldPath}}.
Merge {{target}} into this branch, resolve any conflicts, ensure the build and tests pass, then the work will be merged into {{target}}.
Review context: {{reviewInfo}}
Call signal_completion when the branch is ready to merge.`,
  resolve: `{{toolsPreamble}}

The "{{stage}}" step failed for task "{{title}}".
Error: {{error}}
Worktree: {{worldPath}}
Recent transcript: {{transcript}}
Candidate resolution skills: {{skills}}
Diagnose and fix so {{stage}} can resume. If you cannot, explain why, then call signal_completion.`,
};

export interface AssembleArgs {
  profile: AgentProfile;
  role: AgentRole;
  task: TaskInput;
  world: WorldHandle;
  globalInstructions?: string;
  projectInstructions?: string;
  /** Extra bindings for non-do roles (error, stage, transcript, reviewInfo, skills). */
  bindings?: Record<string, string>;
}

export function assemblePrompt(args: AssembleArgs): string {
  const tpl =
    args.profile.promptTemplate ?? DEFAULT_ROLE_TEMPLATES[args.role] ?? DEFAULT_ROLE_TEMPLATES.do!;
  const instructions = [args.globalInstructions, args.projectInstructions].filter(Boolean).join('\n\n');
  const values: Record<string, string> = {
    toolsPreamble: TOOLS_PREAMBLE,
    title: args.task.title,
    prompt: args.task.prompt,
    worldPath: args.world.root,
    branch: args.world.branch,
    base: args.world.base,
    target: args.task.target ?? args.world.target ?? args.world.base,
    instructions,
    reviewInfo: '',
    stage: '',
    error: '',
    transcript: '',
    skills: '',
    ...(args.bindings ?? {}),
  };
  return tpl.replace(/\{\{(\w+)\}\}/g, (_, k: string) => values[k] ?? '');
}
