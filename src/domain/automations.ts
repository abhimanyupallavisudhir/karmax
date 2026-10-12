import type { EventTrigger, TaskTrigger } from './triggers.js';

/**
 * Automations (wiki features/events-and-automations): ready-made repeatable
 * tasks, each a task plus its trigger. There is no other noun: installing one
 * creates an ordinary series in the project (`params.template` remembers where
 * it came from), which the task form edits and deletes like any other. The
 * built-ins below ship with the platform; an organization adds its own by
 * saving one of its series as a template.
 */
export interface AutomationTemplate {
  id: string;
  name: string;
  /** One sentence for a tooltip: what it does for you. */
  summary: string;
  task: { title: string; prompt: string; workflow?: string; params: Record<string, unknown> };
  /** What the project must have for it to do anything (default: what its triggers listen to). */
  needs?: AutomationNeed[];
  /** Set on templates an organization saved. */
  organizationId?: string;
  createdBy?: string;
  createdAt?: number;
}

/** What a project must have for an automation to do anything. */
export type AutomationNeed = 'github' | 'chat';

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

export const BUILT_IN_AUTOMATIONS: readonly AutomationTemplate[] = [
  {
    id: REPAIR_TEMPLATE_ID,
    name: 'Repair failed deploys',
    summary: 'When a GitHub workflow fails on the default branch after a merge, an agent finds out why and fixes it.',
    task: { title: RECOVERY_TITLE, prompt: RECOVERY_PROMPT, params: { repeatable: true, triggers: [RECOVERY_TRIGGER] } },
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
      params: { repeatable: true, triggers: [{ kind: 'event', type: 'github.issues.labeled', where: { 'label.name': 'planned' }, recurring: true }] },
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
      params: { repeatable: true, triggers: [{ kind: 'schedule', cron: '0 8 * * *', recurring: true }] },
    },
  },
  {
    id: 'chat-requests',
    name: 'Chat requests',
    summary: 'Each message to the project’s chat bot becomes a task. Replies in its thread reach the same task.',
    task: {
      title: '{{text}}',
      prompt: 'Do what this chat message asks. Your final message is posted back to the chat.',
      params: { repeatable: true, triggers: [{ kind: 'event', type: 'chat.mention', recurring: true }] },
    },
  },
];

/** What an automation needs, so the gallery can say what is missing. */
export function automationNeeds(template: Pick<AutomationTemplate, 'task' | 'needs'>): AutomationNeed[] {
  if (template.needs) return template.needs;
  const triggers = (template.task.params.triggers ?? []) as TaskTrigger[];
  const needs = new Set<AutomationNeed>();
  for (const trigger of triggers) {
    if (trigger.kind !== 'event') continue;
    if (trigger.type.startsWith('github.')) needs.add('github');
    if (trigger.type.startsWith('chat.') || trigger.source?.startsWith('chat:')) needs.add('chat');
  }
  return [...needs];
}

/** What a saved template keeps of a series: its definition, not its run state. */
export function templateTask(task: { title: string; workflow?: string; params: Record<string, unknown> }): AutomationTemplate['task'] {
  const { prompt, triggerState: _s, triggerLastFiredAt: _f, triggerPending: _p, draft: _d, runOf: _r, trigger: _t, template: _template,
    archived: _a, ...params } = task.params;
  return { title: task.title, prompt: typeof prompt === 'string' ? prompt : '', ...(task.workflow ? { workflow: task.workflow } : {}),
    params: { ...params, repeatable: true } };
}
