import { AgentProfile, AgentRole, TaskInput } from '../domain/types.js';
import { WorldHandle, worldRepos, worldWorkingDirectory } from '../world/types.js';
import { agentRoleDef, manifest } from '../contrib/manifests.js';
import { untrustedBlock } from '../domain/untrusted.js';
import { BRAND } from '../domain/brand.js';

/**
 * Prompt assembly (SPEC §5.4). Fills the role template (owned by the profile)
 * with task bindings (owned by the workflow) plus global/project instructions,
 * then the result is snapshotted as the journaled turn input.
 *
 * `{{...}}` bindings are filled here; `[[...]]` content links would be resolved
 * from the content store (skills/memory) — represented inline for v1.
 */

/**
 * This preamble is sent to EVERY agent regardless of provider, so it may only
 * name tools every rail actually registers — otherwise an agent is told to call
 * something that does not exist on its harness.
 *
 * Two families keep that promise:
 *   · durable platform tools (task list, wiki, vault, `platform_request`) —
 *     served by the gateway-backed `karmax` stdio MCP, or in-process as function
 *     tools on the raw-API rails;
 *   · TURN-LOCAL controls (`create_review_info`, `open_pr`, `signal_completion`,
 *     `create_sub_task`, `raise_to_parent`, `confirm_decision`, …) — they mutate
 *     the running activity's result, so each rail hosts them itself; see the rail
 *     table in `control-bridge.ts`.
 *
 * The second family is the one that silently went missing on the Codex
 * app-server / `codex exec` / ACP rails, which made the Resolve and Confirm
 * gates structurally unreachable on a Codex subscription or OpenCode while this
 * text still advertised them. `tests/agent-control-tools.test.ts` now asserts
 * every rail registers every control, so this preamble stays honest by construction —
 * if you add a rail, add it to that table-driven test rather than trimming text
 * here.
 */
const TOOLS_PREAMBLE = `You are running inside ${BRAND}, an agent-orchestration platform. Your work happens in a git world (working directory). You have these platform tools available:
- create_sub_task(title, prompt, params?): spawn a child task the parent awaits. It runs your agent unless params choose another, e.g. {"agent:do": {"provider": "codex"}}.
- create_review_info(caption?, actions?): optional click-to-verify affordances for the Review stage. Use only when relevant: "run" actions for verification commands or starting an app/server (set server:true + openUrls to open it), and "open" actions for human-readable outputs such as reports, documents, images, or videos. Source code is not a human-readable output. The optional caption says WHAT to verify and is limited to 280 characters. Put summaries of changes/answers in your normal response, or in a file only when requested. The changed-files list is added automatically.
- save_skill(name, content): persist a reusable skill for future tasks.
- read_wiki(scope, id, path?) and search_wiki(scope, id, query): navigate and grep the organization/project wikis (skills, memories, prompts). Your instructions include each wiki's table of contents and scope ids; read_wiki with a section path expands any [more…] fold. These run host-side, so they work from every world, including cloud sandboxes.
- find_task(projectId, number), list_agents(taskId), get_conversation(taskId, role), fork_agent(...), and message_agent(...): discover work by its human #number and robustly inspect or continue another task agent without mutating its original session.
- Prefer native MCP: use servers selected in the agent’s Tools, or request a remote MCP server by its MCP Registry name or official HTTPS URL. Use a Composio toolkit only as the fallback when no suitable remote MCP server exists.
- list_connections(), request_connection({mcp | toolkit}, why), search_connection_tools(connectionId, search), execute_connection_tool(connectionId, tool, arguments): use connected apps through the gateway. Prefer managed sign-in to asking for passwords or API keys. The user allows an account they already connected or signs in from a Connect button in the task, which then resumes automatically.
- start_job(command, cwd?, name?): run a long command (render, build, training run, large test suite) as a durable job that outlives this turn and any interruption; its output goes to a log file, and its name is what people see while you wait on it. Anything you run from your own shell stops when your turn ends.
- pause(minutes, jobs?, needs_input?): end this turn and be resumed when the listed jobs finish, when a message arrives, or after \`minutes\` — whichever comes first. Without jobs it is a timed pause. pause is for waiting, not for asking: when you need an answer to continue, use escalate_to_human or end your turn with the question. Only when you are waiting anyway and someone may answer meanwhile, set needs_input (optionally with message, audience and urgency, as for escalate_to_human): the task shows Needs input and notifies them, and you carry on without the answer once \`minutes\` pass.
- stop_job(jobs): stop durable jobs you no longer need.
- request_agent_action(taskId, "publish_branch", message?): ask a collaborator to publish in the background. It returns a durable request id immediately; continue other useful work and never poll. ${BRAND} injects completion or failure into this conversation and keeps the task in Do while a request remains outstanding.
- cancel_agent_action(requestId): withdraw one of your pending collaboration requests when its target is blocked or its result is no longer needed. This releases your Do-stage wait without cancelling the target task.
- publish_task_branch(): publish your clean committed branch for collaborators.
- import_task_branch(sourceTaskId): fetch a collaborator's published branch into a namespaced local ref, then inspect/test/cherry-pick or merge it normally.
- refresh_upstream(branch?): fetch the latest upstream branch into refs/remotes/origin before merging or rebasing.
- list_events(taskId?, since?) and describe_platform(): inspect ${BRAND} event/diagnostic context and discover the automation surface.
- platform_request(method, path, body?): call any authenticated /api operation not covered by a dedicated tool. Your task-scoped KARMAX_TOKEN is enforced by ${BRAND} for every request; this is the complete escape hatch for projects, users, authorization, credentials, payments, settings, review actions, and future UI operations.
- open_pr(): Do agents only. Open or refresh the task's pull request and send that exact committed proposal to Review. Call it only when the requested work is truly complete, the worktree is clean, intended changes are committed, and relevant tests pass. This is the final action of a completed Do turn.
- confirm_decision(action, text?): use only when the workflow explicitly asks this turn to review or verify an already-open exact candidate. A final Do-agent integration verification uses this tool instead of open_pr and must not edit the proposal in that verification turn.
- my_authorization(method?, path?): what your authorization covers, and whether one platform_request would be allowed without making it. Check it before attempting something you may lack or asking a person to do something for you: do what it covers yourself, and ask for what it lacks with request_permission(capabilities, projectIds?, reason).
- notify(to, message, urgency?): tell or call people and this task's agents without ending your turn. People are notified now; agents (agent:do, agent:responder, agent:confirm, agent:agent-<n>) are called when your turn ends. Messages from other people and agents in this task reach you labelled with who said them.
- escalate(to, note, task_id?): pass a request you received but cannot answer (as Responder, or from a sub-task) to people who can.
- escalate_to_human(audience, message, urgency?): pause for input without opening a PR. Choose a specific user/team/Avatar when appropriate; discover valid routes with platform_request(GET, "/api/agent/escalation-targets"). A normal turn ending also waits for input from the default audience.
- signal_completion(summary?): optional structured completion summary. Provider-reported successful turn completion is authoritative; this tool is not required.
Do real work directly in the working directory (create/edit files, run commands), verify it, and report the result in your final response. If you are the Do agent and the work is ready for review, call open_pr as your final action. If you need a human decision first, use escalate_to_human instead; waiting for input and opening a PR are separate decisions.`;

// Minimal fallback if a role is undeclared and there's no `do` role registered.
const FALLBACK_TEMPLATE = `{{toolsPreamble}}

# Task
{{title}}

{{prompt}}

# World
Working directory: {{worldPath}} (branch {{branch}}; recorded base {{base}}; target {{target}}).
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

const AGENT_AUTHORED_BINDINGS = ['transcript', 'reviewInfo', 'changedFiles', 'error'] as const;

export function assemblePrompt(args: AssembleArgs): string {
  // Prompt template precedence (SPEC §5.4/§7.1): an explicit profile template wins;
  // else the workflow-declared role template; else the `do` role; else a floor.
  const tpl =
    args.profile.promptTemplate ?? agentRoleDef(args.role)?.promptTemplate ?? agentRoleDef('do')?.promptTemplate ?? FALLBACK_TEMPLATE;
  const instructions = [args.globalInstructions, args.projectInstructions].filter(Boolean).join('\n\n');
  // A workflow may override the platform tools-preamble for its agents (SPEC §5.4).
  let preamble = (args.task.workflow && manifest(args.task.workflow)?.promptPreamble) || TOOLS_PREAMBLE;
  if (args.role === 'do' && args.task.responder?.kind === 'agent') {
    preamble += `

Input routing for this task: its ordinary Waiting-for-input Responder is an agent. When you need a decision or information that this Responder can supply, do not call escalate_to_human. End the turn without open_pr and make your final response the concrete question; ${BRAND} will send it to the Responder and return the answer to this same Do conversation. Use escalate_to_human only when the requested input is inherently human-only (for example an approval, secret, or irreversible personal decision).`;
  }
  const target = args.task.target ?? args.world.target ?? args.world.base;
  if (args.role === 'do' && (target !== args.world.base || args.task.agents?.do?.resumeFrom)) {
    preamble += `

Git ancestry for recovered, forked, or retargeted work: "recorded base" is the immutable commit this task world was provisioned from; "target" is only the branch the proposal will merge into; current HEAD is the tip you are editing. Retargeting does not rewrite the recorded base. Keep the initially provisioned task HEAD as an ancestor: do not reset, recreate, or replace the task branch with a source/target branch. Integrate the selected target into the existing task branch and apply recovered changes as descendant commits. ${BRAND} checks this before publication and refuses unrelated or reparented history.`;
  }
  const values: Record<string, string> = {
    toolsPreamble: preamble,
    title: args.task.title,
    prompt: args.task.prompt,
    worldPath: worldWorkingDirectory(args.world),
    worldRepos: [describeRepos(args.world), describeEnvironment(args.world)].filter(Boolean).join('\n'),
    branch: args.world.branch,
    base: args.world.base,
    target,
    instructions,
    reviewInfo: '',
    stage: '',
    error: '',
    transcript: '',
    skills: '',
    participant: agentRoleDef(args.role)?.label ?? args.role,
    agentInstructions: '',
    ...(args.bindings ?? {}),
  };
  // Bindings another agent authored — the Do agent's transcript, its review
  // summary and file names, a failing stage's output — are quoted as data.
  for (const key of AGENT_AUTHORED_BINDINGS) if (values[key]) values[key] = untrustedBlock(key, values[key]);
  return tpl.replace(/\{\{(\w+)\}\}/g, (_, k: string) => values[k] ?? '');
}

/** The project's install commands, which the agent runs itself, and where a
 * missing step belongs so later tasks get it. Agents used to read these as
 * already run, and not as the setting itself, so a step they had skipped came
 * back as a "missing" step to add to the very setting that listed it. */
function describeEnvironment(world: WorldHandle): string {
  if (!world.meta?.projectId) return '';
  const installs = Array.isArray(world.meta.environmentInstall)
    ? world.meta.environmentInstall as Array<{ root: string; commands: string[] }> : [];
  if (!installs.length) return 'This project has no install commands in Project Settings → Environment, so nothing beyond its '
    + 'environment image is installed for you. If every task needs a step (dependencies, browsers, CLIs), work around it, then suggest '
    + 'the exact command to add there in your final response.';
  return 'These are this project\'s install commands from Project Settings → Environment. They are not run for you: '
    + 'before building or running tests, run all of them yourself, once per task: '
    + installs.map((entry) => `in ${entry.root} run \`${entry.commands.join(' && ')}\``).join('; ') + '. '
    + 'When something is missing (a dependency, browser or CLI), first check whether a command above covers it and you skipped or '
    + 'shortened it; if so, run it. Only a step that every task needs and these commands lack belongs in your final response, '
    + 'as the exact command to add to Project Settings → Environment.';
}

/**
 * A `{{worldRepos}}` block describing a multi-repo world's layout so the agent
 * knows each repo lives in its own subdirectory of the working directory. Empty
 * for a single-repo (or scratch) world, where the working directory IS the repo.
 */
function describeRepos(world: WorldHandle): string {
  const repos = worldRepos(world);
  if (repos.length <= 1) return '';
  const lines = repos.map((r) => `- ${r.root}/ — checkout of ${r.repo}${r.role === 'project-wiki' ? ' (project wiki)' : ''}`).join('\n');
  return (
    `This world spans ${repos.length} repositories inside the world boundary ${world.root} ` +
    `(all on branch ${world.branch}). Use these checkout paths for repository-specific work:\n${lines}`
  );
}
