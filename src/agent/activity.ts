import type { AgentActivity } from '../domain/types.js';

const LIMIT = 1600;
/**
 * Field names whose VALUE must never be archived. `value` is here because
 * `/api/vault/resolve` returns an approved reveal as `{status:'granted', itemId,
 * field, value}` — the plaintext lives under the blandest key in the payload.
 * `credential`/`passphrase`/`privateKey`/`totp` cover the other vault shapes.
 * Over-redaction (a benign `{"value": 42}`) is the deliberate trade: an activity
 * detail is a convenience, a durably archived secret is a breach.
 */
const SECRET =
  /notes?|token|secret|password|passphrase|authorization|api[-_]?key|cookie|credential|priv(?:ate)?[-_]?key|totp|(?:^|[^a-z])value(?:[^a-z]|$)/i;

/** Textual `key: value` / `key=value` pairs in a non-JSON string payload. */
const SECRET_PAIR = new RegExp(
  '("?)([A-Za-z0-9_.-]*(?:notes?|token|secret|password|passphrase|authorization|api[-_]?key|cookie|credential|priv(?:ate)?[-_]?key|totp|value)[A-Za-z0-9_.-]*)\\1\\s*([:=])\\s*("(?:[^"\\\\]|\\\\.)*"|[^\\s,;&}]+)',
  'gi',
);

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
  if (typeof value === 'string') return redactString(value);
  return value;
}

/**
 * Redact a raw string payload. Several rails hand a tool result through as a
 * plain string (the Messages API passes the platform tool's JSON verbatim), and
 * the old `typeof value === 'string'` short-circuit in `activityDetail` meant NO
 * redaction ran at all on exactly those payloads — so an approved, one-time
 * `get_credential` reveal was archived verbatim in SQLite and rendered in the
 * conversation UI. Re-parse JSON so the key rules apply; otherwise scrub
 * `key: value` / `key=value` pairs textually.
 */
function redactString(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object') return JSON.stringify(clean(parsed), null, 2);
    } catch {
      /* not JSON after all — fall through to the textual scrub */
    }
  }
  const scrubbed = text.replace(SECRET_PAIR, (_m, quote, key, sep) => `${quote}${key}${quote}${sep} "[redacted]"`);
  return scrubbed.length > LIMIT ? `${scrubbed.slice(0, LIMIT)}…` : scrubbed;
}

/**
 * Tools whose arguments OR results carry plaintext secrets end-to-end. Their
 * `detail` is suppressed outright rather than trusted to key-based redaction:
 * a *correctly approved* reveal must not be durably archived where the item's
 * reveal policy has no further say, and provider rails disagree about whether
 * the payload arrives as a string, `{text}`, or `{value}` — none of which a key
 * denylist can see through. The tool NAME is the one thing every rail agrees on.
 */
export const SECRET_TOOL_NAMES = new Set([
  // Generic requests can return mail bodies or secret-bearing connector data.
  'platform_request',
  'get_credential',
  'check_agent_mail',
  'use_passkey',
  'fill_credential',
  'store_credential',
  'fill_payment_card',
]);

/** Does this (possibly MCP-namespaced, e.g. `mcp__karmax__get_credential`) tool
 *  name belong to the credential-bearing denylist? */
export function isSecretTool(name: string | undefined): boolean {
  if (!name) return false;
  const bare = String(name).split(/__|[.·\s]+/).filter(Boolean).pop() ?? String(name);
  return SECRET_TOOL_NAMES.has(bare) || SECRET_TOOL_NAMES.has(String(name));
}

/** A bounded, secret-conscious detail string suitable for the conversation UI. */
export function activityDetail(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const text = typeof value === 'string' ? redactString(value) : JSON.stringify(clean(value), null, 2);
  const trimmed = text.trim();
  return trimmed ? (trimmed.length > LIMIT ? `${trimmed.slice(0, LIMIT)}…` : trimmed) : undefined;
}

/** `activityDetail`, but suppressed entirely for a credential-bearing tool. */
export function toolActivityDetail(name: string | undefined, value: unknown): string | undefined {
  return isSecretTool(name) ? undefined : activityDetail(value);
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
      // Suppress the detail entirely for credential-bearing tools (see SECRET_TOOL_NAMES).
      const detail = toolActivityDetail(item.tool ?? name, failed ? item.error?.message ?? item.error : item.arguments);
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
  // Suppress the detail entirely for credential-bearing tools (see SECRET_TOOL_NAMES).
  const detail = toolActivityDetail(name, result ?? input);
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
