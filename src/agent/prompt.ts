import { AgentProfile, AgentRole, TaskInput } from '../domain/types.js';
import { WorldHandle, worldRepos } from '../world/types.js';
import { agentRoleDef, manifest } from '../contrib/manifests.js';

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
- create_review_info(caption?, actions?): optional click-to-verify affordances for the Review stage. Use only when relevant: "run" actions for verification commands or starting an app/server (set server:true + openUrls to open it), and "open" actions for human-readable outputs such as reports, documents, images, or videos. Source code is not a human-readable output. The optional caption says WHAT to verify and is limited to 280 characters. Put summaries of changes/answers in your normal response, or in a file only when requested. The changed-files list is added automatically.
- save_skill(name, content): persist a reusable skill for future tasks.
- read_wiki(scope, id, path?) and search_wiki(scope, id, query): navigate and grep the organization/project wikis (skills, memories, prompts). Your instructions include each wiki's table of contents and scope ids; read_wiki with a section path expands any [more…] fold. These run host-side, so they work from every world, including cloud sandboxes.
- find_task(projectId, number), list_agents(taskId), get_conversation(taskId, role), fork_agent(...), and message_agent(...): discover work by its human #number and robustly inspect or continue another task agent without mutating its original session.
- request_agent_action(taskId, "publish_branch", message?): ask a collaborator to publish in the background. It returns a durable request id immediately; continue other useful work and never poll. Karmax injects completion or failure into this conversation and keeps the task in Do while a request remains outstanding.
- publish_task_branch(): publish your clean committed branch for collaborators.
- import_task_branch(sourceTaskId): fetch a collaborator's published branch into a namespaced local ref, then inspect/test/cherry-pick or merge it normally.
- refresh_upstream(branch?): fetch the latest upstream branch into refs/remotes/origin before merging or rebasing.
- list_events(taskId?, since?) and describe_platform(): inspect karmax event/diagnostic context and discover the automation surface.
- platform_request(method, path, body?): call any authenticated /api operation not covered by a dedicated tool. Your task-scoped KARMAX_TOKEN is enforced by karmax for every request; this is the complete escape hatch for projects, users, authorization, credentials, payments, safe mode, settings, review actions, and future UI operations.
- signal_completion(summary?): optional structured completion summary. Provider-reported successful turn completion is authoritative; this tool is not required.
Do real work directly in the working directory (create/edit files, run commands), verify it, and report the result in your final response.
If you need the result of a long command (e.g. a test or build run), wait for it in THIS turn — run it in the foreground, or wait for your backgrounded job to finish — then fold in the result before ending your turn. Do NOT end your turn expecting to be re-notified later except for a durable request_agent_action collaboration: ordinary background jobs do not pause the task. Only leave a job running in the background if you genuinely don't need its result (e.g. a dev server).`;

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
    args.profile.promptTemplate ?? agentRoleDef(args.role)?.promptTemplate ?? agentRoleDef('do')?.promptTemplate ?? FALLBACK_TEMPLATE;
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
