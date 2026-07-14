import { PlatformToolContext } from './types.js';
import { parseTransition } from '../resolve/transitions.js';
import { World } from '../world/types.js';
import { PLATFORM_API_CATALOG } from '../platform/catalog.js';

/** Provider-neutral tool descriptor (mapped to OpenAI / MCP shapes per adapter). */
export interface ToolSchema {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

const MAX_OUTPUT = 12_000;
const truncate = (s: string) => (s.length > MAX_OUTPUT ? s.slice(0, MAX_OUTPUT) + '\n…(truncated)' : s);

/** Review captions are orientation, not a second place for the agent's final answer. */
export const MAX_REVIEW_TEXT_LENGTH = 280;

const reviewTextLength = (value: string) => [...value].length;

/**
 * The tools every real agent gets: do real work in the world (bash/read/write)
 * plus the platform tools (SPEC §5.2). signal_completion is an optional structured
 * summary; adapters establish completion from provider-native terminal events.
 */
export const TOOL_SCHEMAS: ToolSchema[] = [
  {
    name: 'bash',
    description: 'Run a shell command in the task working directory. Returns stdout/stderr and exit code.',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string', description: 'The shell command to run.' } },
      required: ['command'],
    },
  },
  {
    name: 'read_file',
    description: 'Read a UTF-8 text file relative to the working directory.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: 'Create or overwrite a UTF-8 text file relative to the working directory.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
    },
  },
  {
    name: 'create_review_info',
    description:
      "Optional. Attach click-to-verify affordances only when they are relevant: `run` actions for useful verification commands (including starting an app/server; set `server: true` and use `openUrls` to open it), and `open` actions for human-readable outputs such as reports, documents, images, or videos. Source code is not a human-readable output and must not be attached as an `open` action. `caption` is optional, at most 280 characters, and says WHAT to verify. Put summaries of changes/answers in your normal response, or in a file only when the task requests one. The changed-files list is added automatically.",
    parameters: {
      type: 'object',
      properties: {
        caption: {
          type: 'string',
          maxLength: MAX_REVIEW_TEXT_LENGTH,
          description: 'Optional, at most 280 characters: WHAT to verify (not a summary of what you did).',
        },
        actions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              kind: { type: 'string', enum: ['run', 'open'] },
              label: { type: 'string', description: 'Short button label.' },
              command: { type: 'string', description: 'run: the shell command executed in the world.' },
              server: { type: 'boolean', description: 'run: command is a long-lived server/watcher (stream logs + Stop).' },
              openUrls: { type: 'array', items: { type: 'string' }, description: 'run: URLs to open once it is up.' },
              target: { type: 'string', description: 'open: a human-readable output (not source code), as a world-relative path or absolute URL.' },
            },
            required: ['kind', 'label'],
          },
        },
      },
    },
  },
  {
    name: 'create_sub_task',
    description:
      'Delegate to a child task. It branches off your current work and merges back into YOUR branch (not main), and YOU are its confirmer: when it reaches Review or gets stuck it will raise to you (surfaced as a message) and you answer with respond_to_sub_task. You manage your children to completion before you finish.',
    parameters: {
      type: 'object',
      properties: { title: { type: 'string' }, prompt: { type: 'string' } },
      required: ['title', 'prompt'],
    },
  },
  {
    name: 'respond_to_sub_task',
    description:
      'Answer a sub-task that raised to you. action: "confirm" (approve its Review so it merges into your branch), "comment" (send it guidance/answer its question — it goes back to work), "retry" (tell a stuck/blocked child to try its failed step again), or "cancel" (abandon it). Omit child_task_id to answer all sub-tasks currently waiting on you.',
    parameters: {
      type: 'object',
      properties: {
        child_task_id: { type: 'string', description: 'The raising child; omit to respond to all waiting children.' },
        action: { type: 'string', enum: ['confirm', 'comment', 'retry', 'cancel'] },
        text: { type: 'string', description: 'For "comment": the message/answer/guidance to send down.' },
      },
      required: ['action'],
    },
  },
  {
    name: 'raise_to_parent',
    description:
      'Sub-tasks ONLY: ask your parent task for a decision and pause until it replies. type: "needs_info" (a question about your assignment), "needs_permission" (you need approval to do something), "needs_confirmation" (approve what you have), or "blocked" (you are stuck). The parent (or a human) answers; a "comment" reply resumes you with that guidance. Calling this pauses your turn.',
    parameters: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['needs_info', 'needs_permission', 'needs_confirmation', 'blocked'] },
        detail: { type: 'string', description: 'What you need from the parent (shown to it).' },
      },
      required: ['type'],
    },
  },
  {
    name: 'wait_for_subtasks',
    description:
      'Pause until your running sub-tasks finish (or one raises to you). Your sub-tasks run in the background — you can keep working instead of calling this; call it only when you have nothing to do but wait for them. You are resumed the moment a sub-task finishes or needs you.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'save_skill',
    description: 'Save a reusable skill (markdown content) for future tasks.',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string' }, content: { type: 'string' } },
      required: ['name', 'content'],
    },
  },
  {
    name: 'request_spend',
    description:
      'Request to pay for something with the project card. Amount in cents. Returns granted (charged), needs_approval, needs_funding, or denied. If not granted, stop and report — the human will fund/approve, then you can retry.',
    parameters: {
      type: 'object',
      properties: {
        amount: { type: 'number', description: 'Amount in cents.' },
        merchant: { type: 'string' },
        why: { type: 'string', description: 'Why this purchase is needed (shown to the human).' },
      },
      required: ['amount', 'why'],
    },
  },
  {
    name: 'find_task',
    description: 'Find a task by project id and human-facing project-local number (#100).',
    parameters: { type: 'object', properties: { project_id: { type: 'string' }, number: { type: 'number' } }, required: ['project_id', 'number'] },
  },
  {
    name: 'list_agents',
    description: 'Discover the agent roles/sessions attached to a task.',
    parameters: { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'] },
  },
  {
    name: 'get_conversation',
    description: 'Read one attached agent conversation (do, merge, resolve, or confirm).',
    parameters: { type: 'object', properties: { task_id: { type: 'string' }, role: { type: 'string' } }, required: ['task_id'] },
  },
  {
    name: 'fork_agent',
    description: 'Branch an attached agent into an independent new task/session. The source remains untouched.',
    parameters: { type: 'object', properties: { task_id: { type: 'string' }, role: { type: 'string' }, title: { type: 'string' }, message: { type: 'string' }, authorization_profile: { type: 'string' } }, required: ['task_id', 'message'] },
  },
  {
    name: 'message_agent',
    description: 'Send a follow-up to an original or forked task agent; it is injected live when running.',
    parameters: { type: 'object', properties: { task_id: { type: 'string' }, role: { type: 'string' }, message: { type: 'string' } }, required: ['task_id', 'message'] },
  },
  {
    name: 'list_events',
    description: 'Read durable karmax events for a task after an optional sequence number.',
    parameters: { type: 'object', properties: { task_id: { type: 'string' }, since: { type: 'number' } }, required: ['task_id'] },
  },
  {
    name: 'describe_platform',
    description: 'Describe the complete administrative API exposed by platform_request.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'platform_request',
    description: 'Call any authenticated karmax /api/* route (projects, settings, users, credentials, payments, review actions, diagnostics, safe mode, and more). Authorization is always enforced. Call describe_platform when unsure.',
    parameters: {
      type: 'object',
      properties: { method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] }, path: { type: 'string' }, body: { type: 'object' } },
      required: ['method', 'path'],
    },
  },
  {
    name: 'signal_completion',
    description: 'Optionally attach a structured completion summary. A successful provider turn already establishes completion; this tool is not required.',
    parameters: {
      type: 'object',
      properties: { summary: { type: 'string' } },
    },
  },
  {
    name: 'resolve_decision',
    description:
      'Resolve agents ONLY. Report how to get the task back on track — do NOT finish the task yourself. action: "resume" (you fixed the cause; continue the interrupted agent), "retryStage" (re-run the failed step fresh), "gotoStage" (rewind to an earlier stage, optionally editing params), "parkUntil" (wait for an event then act), or "escalate" (you cannot fix it; hand to a human with a reason). Calling this ends your turn.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['resume', 'retryStage', 'gotoStage', 'parkUntil', 'escalate'] },
        stage: { type: 'string', description: 'For gotoStage: earlier stage to return to (setup/do/review/pr/merge).' },
        reason: { type: 'string', description: 'For escalate: why a human is needed.' },
        params: { type: 'object', description: 'For gotoStage: param edits to apply on rewind, e.g. {"target":"release"}.' },
      },
      required: ['action'],
    },
  },
  {
    name: 'confirm_decision',
    description:
      'Confirm agents ONLY. You are the reviewer at the Review gate — decide whether the work is acceptable, do NOT keep building it. action: "confirm" (accept the work; it proceeds to PR/merge), "revise" (send it back to the Do agent with specific feedback in `text`), or "reject" (the work is unsalvageable; cancel the task, say why in `text`). Calling this ends your turn.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['confirm', 'revise', 'reject'] },
        text: { type: 'string', description: 'For revise: the feedback the Do agent should act on. For reject: why the work is being cancelled.' },
      },
      required: ['action'],
    },
  },
];

/** The world file/shell tools the Claude Agent SDK provides natively (Read/Write/Bash),
 *  so its in-process MCP server must NOT re-register them. Everything else in
 *  TOOL_SCHEMAS is a platform tool that the SDK path DOES expose. */
export const SDK_NATIVE_TOOLS = new Set(['bash', 'read_file', 'write_file']);

/** Platform (non-file/shell) tools — the SINGLE source of truth for what every agent
 *  adapter exposes. Both the Messages-API path (all of TOOL_SCHEMAS) and the Agent-SDK
 *  path (this list, minted natively for Read/Write/Bash) derive from it, so the two can
 *  never drift — the drift that hid `respond_to_sub_task` from Claude-Code agents. */
export const PLATFORM_TOOL_SCHEMAS: ToolSchema[] = TOOL_SCHEMAS.filter((t) => !SDK_NATIVE_TOOLS.has(t.name));

/** Returns name → executor for the platform tools, bound to a world + context. */
export function platformToolHandlers(
  world: World,
  ctx: PlatformToolContext,
): Record<string, (args: any) => Promise<string>> {
  const platformRequest = (method: string, requestPath: string, body?: unknown) => {
    if (!ctx.platformRequest) throw new Error('karmax gateway is unavailable to this agent');
    return ctx.platformRequest(method, requestPath, body);
  };
  return {
    async bash(args) {
      const cmd = String(args?.command ?? '');
      const r = await world.exec('bash', ['-lc', cmd], { timeoutMs: 120_000 });
      ctx.emit(`$ ${cmd}`);
      const out = `exit ${r.code}\n${r.stdout}${r.stderr}`;
      return truncate(out);
    },
    async read_file(args) {
      try {
        return truncate(await world.readFile(String(args?.path ?? '')));
      } catch (e: any) {
        return `error: ${e?.message ?? e}`;
      }
    },
    async write_file(args) {
      await world.writeFile(String(args?.path ?? ''), String(args?.content ?? ''));
      ctx.emit(`wrote ${args?.path}`);
      return `wrote ${args?.path}`;
    },
    async create_review_info(args) {
      // `summary` is no longer advertised, but validate it too for old/resumed
      // sessions which may still call the legacy shape. Both fields occupy the
      // same textual orientation slot in Review.
      for (const field of ['caption', 'summary'] as const) {
        const value = args?.[field];
        if (typeof value !== 'string') continue;
        const length = reviewTextLength(value);
        if (length > MAX_REVIEW_TEXT_LENGTH) {
          return `review info rejected: ${field} is ${length} characters; the maximum is ${MAX_REVIEW_TEXT_LENGTH}. Shorten it and retry.`;
        }
      }
      ctx.createReviewInfo({
        caption: args?.caption,
        actions: Array.isArray(args?.actions) ? args.actions : undefined,
        summary: args?.summary,
        links: args?.links,
        diff: args?.diff,
        html: args?.html,
      });
      return 'review info recorded';
    },
    async create_sub_task(args) {
      ctx.createSubTask({ title: String(args?.title ?? 'sub-task'), prompt: String(args?.prompt ?? '') });
      return 'sub-task spawned (branches off your work; you are its confirmer)';
    },
    async respond_to_sub_task(args) {
      const action = String(args?.action ?? '');
      if (!['confirm', 'comment', 'retry', 'cancel'].includes(action))
        return 'invalid action — use confirm | comment | retry | cancel';
      ctx.respondToSubTask({
        childTaskId: args?.child_task_id ? String(args.child_task_id) : undefined,
        action: action as 'confirm' | 'comment' | 'retry' | 'cancel',
        text: args?.text ? String(args.text) : undefined,
      });
      return `responded to sub-task${args?.child_task_id ? ` ${args.child_task_id}` : 's'}: ${action}`;
    },
    async raise_to_parent(args) {
      const type = String(args?.type ?? '');
      if (!['needs_info', 'needs_permission', 'needs_confirmation', 'blocked'].includes(type))
        return 'invalid type — use needs_info | needs_permission | needs_confirmation | blocked';
      ctx.raiseToParent({ type: type as 'needs_info' | 'needs_permission' | 'needs_confirmation' | 'blocked', detail: args?.detail ? String(args.detail) : undefined });
      return `raised to parent: ${type}`;
    },
    async wait_for_subtasks() {
      ctx.waitForSubtasks();
      return 'waiting for sub-tasks to finish (or raise)';
    },
    async save_skill(args) {
      ctx.saveSkill({ name: String(args?.name ?? 'skill'), content: String(args?.content ?? '') });
      return 'skill saved';
    },
    async request_spend(args) {
      const r = await ctx.requestSpend({
        amount: Number(args?.amount ?? 0),
        merchant: args?.merchant ? String(args.merchant) : undefined,
        why: args?.why ? String(args.why) : undefined,
      });
      return JSON.stringify(r);
    },
    async find_task(args) {
      return JSON.stringify(await platformRequest('GET', `/api/projects/${encodeURIComponent(String(args?.project_id ?? ''))}/tasks/by-num/${Number(args?.number)}`));
    },
    async list_agents(args) {
      return JSON.stringify(await platformRequest('GET', `/api/tasks/${encodeURIComponent(String(args?.task_id ?? ''))}/agents`));
    },
    async get_conversation(args) {
      const role = encodeURIComponent(String(args?.role ?? 'do'));
      return JSON.stringify(await platformRequest('GET', `/api/tasks/${encodeURIComponent(String(args?.task_id ?? ''))}/conversation?role=${role}`));
    },
    async fork_agent(args) {
      const taskId = encodeURIComponent(String(args?.task_id ?? ''));
      return JSON.stringify(await platformRequest('POST', `/api/tasks/${taskId}/fork-agent`, {
        role: args?.role ?? 'do', title: args?.title, message: args?.message,
        authorizationProfile: args?.authorization_profile,
      }));
    },
    async message_agent(args) {
      const taskId = encodeURIComponent(String(args?.task_id ?? ''));
      await platformRequest('POST', `/api/tasks/${taskId}/signal`, { signal: 'followUp', role: args?.role ?? 'do', text: args?.message });
      return 'message delivered';
    },
    async list_events(args) {
      return JSON.stringify(await platformRequest('GET', `/api/tasks/${encodeURIComponent(String(args?.task_id ?? ''))}/events?since=${Number(args?.since ?? 0)}`));
    },
    async describe_platform() {
      return JSON.stringify(PLATFORM_API_CATALOG);
    },
    async platform_request(args) {
      const method = String(args?.method ?? 'GET').toUpperCase();
      const requestPath = String(args?.path ?? '');
      if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return 'error: invalid method';
      if (!requestPath.startsWith('/api/') || requestPath.startsWith('/api/login') || requestPath.startsWith('/api/setup')) return 'error: authenticated /api/* path required';
      return JSON.stringify(await platformRequest(method, requestPath, args?.body));
    },
    async signal_completion(args) {
      ctx.signalCompletion(args?.summary ? String(args.summary) : undefined);
      return 'completion recorded';
    },
    async resolve_decision(args) {
      const t = parseTransition(args);
      if (!t) return 'invalid resolve decision — use action: resume | retryStage | gotoStage | parkUntil | escalate';
      ctx.resolveDecision(t);
      return `resolution recorded: ${t.do}`;
    },
    async confirm_decision(args) {
      const action = String(args?.action ?? '');
      if (!['confirm', 'revise', 'reject'].includes(action)) return 'invalid confirm decision — use action: confirm | revise | reject';
      ctx.confirmDecision({ action: action as 'confirm' | 'revise' | 'reject', text: args?.text ? String(args.text) : undefined });
      return `confirm decision recorded: ${action}`;
    },
  };
}
