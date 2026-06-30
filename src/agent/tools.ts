import { PlatformToolContext } from './types.js';
import { World } from '../world/types.js';

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

/**
 * The tools every real agent gets: do real work in the world (bash/read/write)
 * plus the platform tools (SPEC §5.2). signal_completion is the structured,
 * unspoofable completion signal — never a parsed "done" string.
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
    description: 'Attach polished review output (summary, links, diff, html) shown at the Review stage.',
    parameters: {
      type: 'object',
      properties: {
        summary: { type: 'string' },
        links: { type: 'array', items: { type: 'object', properties: { label: { type: 'string' }, url: { type: 'string' } } } },
        diff: { type: 'string' },
        html: { type: 'string' },
      },
    },
  },
  {
    name: 'create_sub_task',
    description: 'Spawn a child task that the parent task awaits before continuing.',
    parameters: {
      type: 'object',
      properties: { title: { type: 'string' }, prompt: { type: 'string' } },
      required: ['title', 'prompt'],
    },
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
    name: 'signal_completion',
    description: 'Signal that your turn is complete. Call this exactly when finished — do not write a "done" message instead.',
    parameters: {
      type: 'object',
      properties: { summary: { type: 'string' } },
    },
  },
];

/** Returns name → executor for the platform tools, bound to a world + context. */
export function platformToolHandlers(
  world: World,
  ctx: PlatformToolContext,
): Record<string, (args: any) => Promise<string>> {
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
      ctx.createReviewInfo({
        summary: args?.summary,
        links: args?.links,
        diff: args?.diff,
        html: args?.html,
      });
      return 'review info recorded';
    },
    async create_sub_task(args) {
      ctx.createSubTask({ title: String(args?.title ?? 'sub-task'), prompt: String(args?.prompt ?? '') });
      return 'sub-task queued';
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
    async signal_completion(args) {
      ctx.signalCompletion(args?.summary ? String(args.summary) : undefined);
      return 'completion recorded';
    },
  };
}
