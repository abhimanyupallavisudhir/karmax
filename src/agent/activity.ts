import type { AgentActivity } from '../domain/types.js';

const LIMIT = 1600;
const SECRET = /token|secret|password|authorization|api[-_]?key|cookie/i;

function clean(value: unknown, depth = 0): unknown {
  if (depth > 3) return '…';
  if (Array.isArray(value)) return value.slice(0, 12).map((v) => clean(v, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 24)
        .map(([key, val]) => [key, SECRET.test(key) ? '[redacted]' : clean(val, depth + 1)]),
    );
  }
  if (typeof value === 'string') return value.length > LIMIT ? `${value.slice(0, LIMIT)}…` : value;
  return value;
}

/** A bounded, secret-conscious detail string suitable for the conversation UI. */
export function activityDetail(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const text = typeof value === 'string' ? value : JSON.stringify(clean(value), null, 2);
  const trimmed = text.trim();
  return trimmed ? (trimmed.length > LIMIT ? `${trimmed.slice(0, LIMIT)}…` : trimmed) : undefined;
}

const paths = (changes: any[]) =>
  changes
    .map((change) => change?.path ?? change?.file ?? change?.filePath ?? change?.move_path)
    .filter((path): path is string => typeof path === 'string' && !!path)
    .slice(0, 6);

/** Translate a Codex app-server ThreadItem into the stable Karmax timeline shape. */
export function codexItemActivity(item: any, phase: AgentActivity['phase']): AgentActivity | undefined {
  if (!item || typeof item.type !== 'string') return undefined;
  const id = String(item.id ?? `${item.type}-${Math.random().toString(36).slice(2)}`);
  switch (item.type) {
    case 'agentMessage':
      return item.text ? { id, kind: 'message', phase, title: String(item.text) } : undefined;
    case 'reasoning': {
      const text = [...(item.summary ?? []), ...(item.content ?? [])].filter(Boolean).join('\n');
      return { id, kind: 'reasoning', phase, title: 'Reasoning', ...(activityDetail(text) ? { detail: activityDetail(text) } : {}) };
    }
    case 'plan':
      return { id, kind: 'status', phase, title: 'Updated plan', ...(activityDetail(item.text) ? { detail: activityDetail(item.text) } : {}) };
    case 'commandExecution': {
      const failed = item.status === 'failed' || (typeof item.exitCode === 'number' && item.exitCode !== 0);
      const detail = activityDetail(item.aggregatedOutput);
      return {
        id,
        kind: 'command',
        phase: failed ? 'failed' : phase,
        title: String(item.command || 'Run command'),
        ...(detail ? { detail } : {}),
      };
    }
    case 'fileChange': {
      const files = paths(item.changes ?? []);
      const failed = item.status === 'failed' || item.status === 'declined';
      return {
        id,
        kind: 'file',
        phase: failed ? 'failed' : phase,
        title: files.length ? `Changed ${files.join(', ')}` : 'Changed files',
        ...(files.length < (item.changes?.length ?? 0) ? { detail: `${item.changes.length} files total` } : {}),
      };
    }
    case 'mcpToolCall':
    case 'dynamicToolCall': {
      const failed = item.status === 'failed' || item.success === false || !!item.error;
      const name = [item.server ?? item.namespace, item.tool].filter(Boolean).join(' · ') || 'Tool call';
      const detail = activityDetail(failed ? item.error?.message ?? item.error : item.arguments);
      return { id, kind: 'tool', phase: failed ? 'failed' : phase, title: name, ...(detail ? { detail } : {}) };
    }
    case 'collabAgentToolCall':
    case 'subAgentActivity': {
      const detail = activityDetail(item.prompt ?? item.agentsStates ?? item.agentPath);
      return { id, kind: 'subagent', phase, title: item.tool ? `Agent · ${item.tool}` : 'Sub-agent activity', ...(detail ? { detail } : {}) };
    }
    case 'webSearch': {
      const query = item.query ?? item.action?.query ?? item.action?.url;
      return { id, kind: 'search', phase, title: query ? `Search · ${query}` : 'Web search' };
    }
    case 'imageView':
      return { id, kind: 'tool', phase, title: `Viewed ${String(item.path ?? 'image')}` };
    case 'imageGeneration':
      return { id, kind: 'tool', phase, title: 'Generated image' };
    case 'contextCompaction':
      return { id, kind: 'status', phase, title: 'Compacted conversation context' };
    case 'sleep':
      return { id, kind: 'status', phase, title: `Waiting ${Math.round(Number(item.durationMs ?? 0) / 1000)}s` };
    case 'enteredReviewMode':
    case 'exitedReviewMode':
      return { id, kind: 'status', phase, title: item.type === 'enteredReviewMode' ? 'Entered review mode' : 'Exited review mode' };
    default:
      return undefined;
  }
}

/** Compact a Claude/Anthropic tool name into the same item vocabulary as Codex. */
export function claudeToolActivity(block: any, phase: AgentActivity['phase'], result?: unknown): AgentActivity {
  const name = String(block?.name ?? block?.tool_name ?? 'Tool call');
  const input = block?.input ?? block?.tool_input;
  const detail = activityDetail(result ?? input);
  const command = name === 'Bash' && typeof input?.command === 'string' ? input.command : undefined;
  const isFile = /^(Read|Write|Edit|MultiEdit|NotebookEdit)$/i.test(name);
  return {
    id: String(block?.id ?? block?.tool_use_id ?? `${name}-tool`),
    kind: command ? 'command' : isFile ? 'file' : /^(Task|Agent)$/i.test(name) ? 'subagent' : /search|fetch/i.test(name) ? 'search' : 'tool',
    phase,
    title: command ?? (isFile && typeof input?.file_path === 'string' ? `${name} ${input.file_path}` : name),
    ...(detail ? { detail } : {}),
  };
}
