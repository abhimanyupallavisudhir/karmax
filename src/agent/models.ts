import { spawn } from 'node:child_process';
import { CodexAppServerClient } from './codex-app-server-client.js';
import { scrubbedEnv } from '../autonomy/config-homes.js';
import { withTimeout } from '../util/timeout.js';

export interface AvailableModel {
  id: string;
  displayName?: string;
  description?: string;
  effort?: string[];
  isDefault?: boolean;
}

export type ModelCatalog = Record<'claude' | 'codex', AvailableModel[]>;

/** Ask Claude Code for the picker entries available to this login. No model turn is
 * made: the streaming input is deliberately left idle while we read the SDK's
 * initialization metadata, then the session is closed. */
export async function claudeModels(configHome?: string, timeoutMs = 10_000): Promise<AvailableModel[]> {
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  async function* idleInput(): AsyncGenerator<never, void, unknown> {
    await new Promise<void>(() => undefined);
  }
  const env = configHome
    ? scrubbedEnv({ provider: 'claude', configHome })
    : { ...(process.env as Record<string, string>) };
  const session = query({ prompt: idleInput(), options: { cwd: process.cwd(), env } });
  try {
    const models = await withTimeout(session.supportedModels(), timeoutMs);
    return models.map((m) => ({
      id: m.value,
      displayName: m.displayName,
      description: m.description,
      ...(m.supportedEffortLevels?.length ? { effort: [...m.supportedEffortLevels] } : {}),
      ...(m.value === 'default' ? { isDefault: true } : {}),
    }));
  } finally {
    session.close();
  }
}

/** Ask Codex app-server for its native model picker. This is account-aware and is
 * more useful than the OpenAI REST /models endpoint, which is a broad API catalog. */
export async function codexModels(configHome?: string, timeoutMs = 10_000): Promise<AvailableModel[]> {
  const cmd = process.env.KARMAX_CODEX_EXEC_CMD ?? 'codex';
  const env = configHome
    ? scrubbedEnv({ provider: 'codex', configHome })
    : { ...(process.env as Record<string, string>) };
  const child = spawn(cmd, ['app-server'], { env, stdio: ['pipe', 'pipe', 'ignore'] });
  const client = new CodexAppServerClient(child.stdin!, child.stdout!);
  child.once('error', () => client.close());
  child.once('close', () => client.close());
  try {
    await withTimeout(client.request('initialize', {
      clientInfo: { name: 'karmax-model-picker', title: 'karmax', version: '1.0.0' },
      capabilities: null,
    }), timeoutMs);
    client.notify('initialized');

    const out: AvailableModel[] = [];
    let cursor: string | null = null;
    do {
      const page: { data?: any[]; nextCursor?: string | null } = await withTimeout(client.request('model/list', {
        cursor,
        limit: 100,
        includeHidden: false,
      }), timeoutMs);
      for (const m of page?.data ?? []) {
        out.push({
          id: String(m.model ?? m.id),
          displayName: m.displayName,
          description: m.description,
          ...(Array.isArray(m.supportedReasoningEfforts)
            ? { effort: m.supportedReasoningEfforts.map((e: any) => String(e.reasoningEffort)) }
            : {}),
          ...(m.isDefault ? { isDefault: true } : {}),
        });
      }
      cursor = page?.nextCursor ?? null;
    } while (cursor);
    return out;
  } finally {
    client.close();
    if (!child.killed) child.kill();
  }
}

export function mergeModels(groups: AvailableModel[][]): AvailableModel[] {
  const byId = new Map<string, AvailableModel>();
  for (const group of groups) {
    for (const model of group) {
      if (!model.id || byId.has(model.id)) continue;
      byId.set(model.id, model);
    }
  }
  return [...byId.values()];
}
