import { AgentProfile, AgentRole, TaskInput } from '../domain/types.js';
import { WorldHandle, worldRepos } from '../world/types.js';
import { roleDef, manifest } from '../contrib/manifests.js';

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

// Minimal fallback if a role is undeclared and there's no `do` role registered.
const FALLBACK_TEMPLATE = `{{toolsPreamble}}

# Task
{{title}}

{{prompt}}

# World
Working directory: {{worldPath}} (branch {{branch}} off {{base}}).
{{worldRepos}}

{{instructions}}`;

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
  // Prompt template precedence (SPEC §5.4/§7.1): an explicit profile template wins;
  // else the workflow-declared role template; else the `do` role; else a floor.
  const tpl =
    args.profile.promptTemplate ?? roleDef(args.role)?.promptTemplate ?? roleDef('do')?.promptTemplate ?? FALLBACK_TEMPLATE;
  const instructions = [args.globalInstructions, args.projectInstructions].filter(Boolean).join('\n\n');
  // A workflow may override the platform tools-preamble for its agents (SPEC §5.4).
  const preamble = (args.task.workflow && manifest(args.task.workflow)?.promptPreamble) || TOOLS_PREAMBLE;
  const values: Record<string, string> = {
    toolsPreamble: preamble,
    title: args.task.title,
    prompt: args.task.prompt,
    worldPath: args.world.root,
    worldRepos: describeRepos(args.world),
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

/**
 * A `{{worldRepos}}` block describing a multi-repo world's layout so the agent
 * knows each repo lives in its own subdirectory of the working directory. Empty
 * for a single-repo (or scratch) world, where the working directory IS the repo.
 */
function describeRepos(world: WorldHandle): string {
  const repos = worldRepos(world);
  if (repos.length <= 1) return '';
  const lines = repos.map((r) => `- ${r.name}/ — checkout of ${r.repo}`).join('\n');
  return (
    `This world spans ${repos.length} repositories, each checked out in its own subdirectory of the working directory ` +
    `(all on branch ${world.branch}). \`cd\` into a subdirectory to run git/build commands for that repo:\n${lines}`
  );
}
