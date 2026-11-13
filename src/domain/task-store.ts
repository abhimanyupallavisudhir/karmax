import { BRAND } from './brand.js';
import type { EventTrigger, TaskTrigger } from './triggers.js';

/**
 * The task store (wiki features/events-and-automations): ready-made tasks.
 * There is no other noun: an ordinary one runs as a task of the project the
 * moment it is chosen; a repeatable one (an automation: a task plus its
 * trigger) installs as an ordinary series, as often as asked, which the task
 * form edits and deletes like any other. Either way `params.template`
 * remembers where it came from. They ship with the platform.
 */
export interface StoreTask {
  id: string;
  name: string;
  /** One sentence for a tooltip: what it does for you. */
  summary: string;
  task: { title: string; prompt: string; workflow?: string; params: Record<string, unknown>;
    /** The prompt on hosted installations, where some steps do not apply. */
    hostedPrompt?: string;
    /** The authorization level its agent needs in the project (default: the project's). */
    authorization?: { level: string } };
  /** What the project must have for it to do anything (default: what its triggers listen to). */
  needs?: StoreNeed[];
  /** A repeatable one's first run starts when it is installed, not at its first trigger. */
  runOnInstall?: boolean;
}

/** What a project must have for a store task to do anything. */
export type StoreNeed = 'github' | 'chat' | 'repository';

/**
 * Store tasks run unattended, so none waits for a person at Review: one that
 * changes no code confirms itself, and one that may change code is reviewed by
 * an agent (the project's default Reviewer), which hands the Review to the
 * task's people after three rounds of sending it back.
 */
export const AUTO_CONFIRM = { layers: [] } as const;
export const AGENT_REVIEW = { layers: [{ kind: 'agent', maxRevisions: 3 }] } as const;

export const REPAIR_TEMPLATE_ID = 'repair-github-workflow';

export const RECOVERY_TRIGGER: EventTrigger = {
  kind: 'event', type: 'github.workflow.failed', recurring: true,
  // A workflow that is still red while its repair is open is that repair's
  // business (#554/#555): it hears about it instead of a second repair starting.
  concurrency: { key: '{{repository}}/{{workflow}}', mode: 'tell' },
};

export const RECOVERY_TITLE = 'Repair GitHub workflow {{workflow}}';

export const RECOVERY_PROMPT = [
  'A post-merge GitHub workflow on the default branch failed, or GitHub never created its run. The event below names the repository, workflow, exact revision (`headSha`) and run (`url`).',
  '`source: deployment_monitor` with `conclusion: missing` means no run was created; its `evidence` records what was checked. `attempt` above 1 means the run failed again after a rerun, so the failure reproduces. `originatingTaskId` names the merged task whose change it followed.',
  '',
  'Inspect the complete GitHub evidence and classify it before changing code. For a missing run, check workflow schema/registration and triggers first; the evidence distinguishes direct API absence from webhook delay and records file/API permission failures. If a run exists, distinguish queued/waiting environment approval from a terminal failure. If it is a transient GitHub runner failure, rerun the exact revision once and verify it. If it is billing, permissions, protected-environment approval, secrets, or repository configuration, report the precise human action required and do not manufacture a code change. If it is a deterministic deployment or code defect, repair it through the normal reviewed pull-request workflow and verify recovery. The already-merged originating task is immutable and must remain complete.',
].join('\n');

export const PROJECT_WIKI_TEMPLATE_ID = 'project-wiki';

const projectWikiPrompt = (hosted: boolean) => [
  `## Maintain this project's wiki for agents`,
  `If ${BRAND}'s project wiki has no pages yet, set it up:`,
  `1) Migrate AGENTS.md, CLAUDE.md or any other similar agent context files to ${BRAND}'s project wiki.`,
  '2) If no such files exist, or if they are out of date, compile wiki pages containing everything essential for a new developer/agent to get up and running: memories for facts worth knowing, skills for procedures worth repeating.',
  ...(hosted ? [] : ['3) For brownfield repos, scan for hardcoded resources (e.g. ports) that would collide between worktrees and fix them.']),
  '',
  'Otherwise keep it current: read what changed in the repositories since the wiki was last updated (`git log` of each, against the wiki\'s), then fix or delete what is now wrong (paths, commands, names, issues since fixed), add what a newcomer would now need, and merge duplicates. If nothing changed that the wiki should know, change nothing.',
  '',
  'Put the "default" label on wiki pages that must appear in the context of every new agent, and only on those.',
  'Report what you changed.',
].join('\n');

export const UPDATE_DEPENDENCIES_TEMPLATE_ID = 'update-dependencies';

const UPDATE_DEPENDENCIES_PROMPT = [
  '## Update dependencies',
  'Bring the dependencies of every repository of this project up to date, so each upgrade stays small and security fixes arrive soon.',
  `1) If an earlier run of this task is still open (\`search_tasks\` with \`store:${UPDATE_DEPENDENCIES_TEMPLATE_ID} is:run is:open\`, other than you), stop and say so: its pull request goes first, and the next run takes whatever is newer.`,
  '2) Find everything each repository depends on: package manifests and lockfiles (npm, pnpm, Yarn, pip, uv, Poetry, Cargo, Go modules, Bundler, Composer, Maven, Gradle, …), language and tool versions (`.nvmrc`, `.tool-versions`, `engines`), container base images and GitHub Actions.',
  '3) Security first: run each ecosystem\'s audit (`npm audit`, `pip-audit`, `cargo audit`, `govulncheck`, …) and take the fixed version of every advisory.',
  '4) Take every patch and minor release, refreshing the lockfiles. Take a major release only after reading its release notes and migration guide and adapting the code to it; one that needs more than a modest change stays out.',
  '5) Leave alone what is pinned on purpose: a pin whose comment gives its reason, or anything the project wiki or another task of this project says is upgraded elsewhere.',
  '6) Verify as CI would: a clean install, the build, typecheck, lint and the whole test suite. Revert an update you cannot make pass.',
  '7) If nothing is out of date, change nothing. Otherwise the pull request lists each update (from → to, majors marked), the advisories fixed, and what stayed out and why.',
].join('\n');

export const TAG_TASKS_TEMPLATE_ID = 'tag-tasks';

const TAG_TASKS_PROMPT = [
  '## Tag this project\'s tasks',
  'Tag every task of this project that has no tags yet (`search_tasks` with `is:untagged -is:draft`), so the task list can be filtered and grouped by tag.',
  '1) First read the tag catalogue (`list_tags`) and how tagged tasks already use it (`search_tasks` with `is:tagged`).',
  '2) Give each task the one to three tags that say what it is about (an area, feature or component) and, where it is clear, what kind of work it is (a bug, a feature, a chore). Its title usually says enough; read the task (`get_task`) only when it does not. A run of a repeatable task takes the tags of its series.',
  '3) Prefer the tags that exist. Add one only for a theme several tasks share that no tag covers: a short lowercase name, or an `area/part` path under a tag that exists. Never tag what the list already shows: status, stage, priority, project, dates or who it waits for.',
  '4) Only add tags (`tag_task`), never remove one: people\'s tags are theirs.',
  '5) Report how many tasks you tagged and the tags you created, then call open_pr: no repository changes, so it just ends the run.',
].join('\n');

export const STORE_TASKS: readonly StoreTask[] = [
  {
    id: PROJECT_WIKI_TEMPLATE_ID,
    name: 'Maintain the project wiki',
    summary: 'An agent writes what every later agent should know into the project’s wiki now, then keeps it up to date every week.',
    runOnInstall: true,
    task: { title: 'Maintain the project wiki', workflow: 'software-dev',
      prompt: projectWikiPrompt(false), hostedPrompt: projectWikiPrompt(true),
      params: { repeatable: true, confirm: AUTO_CONFIRM, triggers: [{ kind: 'schedule', cron: '0 6 * * 1', recurring: true }] } },
  },
  {
    id: REPAIR_TEMPLATE_ID,
    name: 'Repair failed deploys',
    summary: 'When a GitHub workflow fails on the default branch after a merge, an agent finds out why and fixes it.',
    task: { title: RECOVERY_TITLE, prompt: RECOVERY_PROMPT, params: { repeatable: true, confirm: AGENT_REVIEW, triggers: [RECOVERY_TRIGGER] } },
  },
  {
    id: 'build-planned-issues',
    name: 'Build planned issues',
    summary: 'Label a GitHub issue “planned” and an agent builds it. Comments on the issue reach the agent while it works.',
    task: {
      title: '#{{issue.number}} {{issue.title}}',
      prompt: [
        'Build what the GitHub issue below asks for, through the normal reviewed pull-request workflow.',
        'Read the whole issue and its comments first (`gh issue view <url> --comments`). If it is too unclear to build, ask on the issue and wait for the answer: comments on it reach you as messages.',
        'Reference the issue in the pull request (`Closes #<number>`).',
      ].join('\n'),
      params: { repeatable: true, confirm: AGENT_REVIEW, triggers: [{ kind: 'event', type: 'github.issues.labeled', where: { 'label.name': 'planned' }, recurring: true }] },
    },
  },
  {
    id: 'triage-issues',
    name: 'Triage issues daily',
    needs: ['github'],
    summary: 'Every morning an agent goes through new GitHub issues: labels them, finds duplicates and asks for what is missing.',
    task: {
      title: 'Triage GitHub issues',
      prompt: [
        'Triage the open GitHub issues of this project’s repositories that changed since the last triage (`gh issue list`, `gh issue view --comments`).',
        'For each: label it by kind and area, link and close exact duplicates, ask its author for whatever is missing to act on it (steps to reproduce, expected behaviour), and say on it how it could be solved when you can tell.',
        'Do not add the “planned” label yourself: a person decides what gets built. End with a short summary of what you did and which issues look ready to plan.',
      ].join('\n'),
      params: { repeatable: true, confirm: AUTO_CONFIRM, triggers: [{ kind: 'schedule', cron: '0 8 * * *', recurring: true }] },
    },
  },
  {
    id: UPDATE_DEPENDENCIES_TEMPLATE_ID,
    name: 'Update dependencies weekly',
    needs: ['repository'],
    summary: 'Every week an agent updates the project’s dependencies, security fixes first, and proposes them in a tested pull request.',
    task: { title: 'Update dependencies', prompt: UPDATE_DEPENDENCIES_PROMPT,
      params: { repeatable: true, confirm: AGENT_REVIEW, triggers: [{ kind: 'schedule', cron: '0 5 * * 2', recurring: true }] } },
  },
  {
    id: TAG_TASKS_TEMPLATE_ID,
    name: 'Tag tasks daily',
    summary: 'Every day an agent tags the project’s untagged tasks, so the list can be filtered and grouped by tag.',
    // Tagging other people's tasks is task:edit on the project, which a
    // Developer holds for their own tasks only.
    task: { title: 'Tag tasks', prompt: TAG_TASKS_PROMPT, authorization: { level: 'maintainer' },
      params: { repeatable: true, confirm: AUTO_CONFIRM, triggers: [{ kind: 'schedule', cron: '0 7 * * *', recurring: true }] } },
  },
  {
    id: 'chat-requests',
    name: 'Chat requests',
    summary: 'Each message to the project’s chat bot becomes a task. Replies in its thread reach the same task.',
    task: {
      title: '{{text}}',
      prompt: 'Do what this chat message asks. Your final message is posted back to the chat.',
      params: { repeatable: true, confirm: AGENT_REVIEW, triggers: [{ kind: 'event', type: 'chat.mention', recurring: true }] },
    },
  },
];

/** Whether choosing it installs a series rather than running a task. */
export function storeTaskRepeatable(template: Pick<StoreTask, 'task'>): boolean {
  return template.task.params.repeatable === true;
}

/** Whether a task is one the project took from store task `template`: a
 *  repeatable one's armed series, an ordinary one's runs. A draft is not taken
 *  yet, and a series' runs belong to their series. */
export function takenFromStore(task: { params?: Record<string, unknown> }, template: Pick<StoreTask, 'id' | 'task'>): boolean {
  const params = task.params ?? {};
  if (params.template !== template.id || params.runOf || params.draft) return false;
  return !storeTaskRepeatable(template) || params.repeatable === true;
}

/** Whether installing this series (arming it the first time) starts its first
 *  run too: its store task says so, and the person has not untied it from it. */
export function runsOnInstall(params: Record<string, unknown> | undefined): boolean {
  if (params?.repeatable !== true || params.runOf || params.draft) return false;
  return STORE_TASKS.find((template) => template.id === params.template)?.runOnInstall === true;
}

/** What a store task needs, so the store can say what is missing. */
export function storeTaskNeeds(template: Pick<StoreTask, 'task' | 'needs'>): StoreNeed[] {
  if (template.needs) return template.needs;
  const triggers = (template.task.params.triggers ?? []) as TaskTrigger[];
  const needs = new Set<StoreNeed>();
  for (const trigger of triggers) {
    if (trigger.kind !== 'event') continue;
    if (trigger.type.startsWith('github.')) needs.add('github');
    if (trigger.type.startsWith('chat.') || trigger.source?.startsWith('chat:')) needs.add('chat');
  }
  return [...needs];
}
