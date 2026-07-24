import { spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { client, methods, ndJsonStream, PROTOCOL_VERSION, type SessionConfigOption } from '@agentclientprotocol/sdk';
import { CodexAppServerClient } from './codex-app-server-client.js';
import { scrubbedEnv } from '../autonomy/config-homes.js';
import { withTimeout } from '../util/timeout.js';
import type { Provider } from '../domain/types.js';
import type { AcpProvider } from './provider-registry.js';
import { selectAcpAuthMethod } from './acp.js';

export interface AvailableModel {
  id: string;
  displayName?: string;
  description?: string;
  effort?: string[];
  isDefault?: boolean;
}

export type ModelCatalog = Record<Provider, AvailableModel[]>;

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

/** OpenCode's documented, model-agnostic catalog (`opencode models`). */
export async function opencodeModels(configHome?: string, timeoutMs = 10_000): Promise<AvailableModel[]> {
  const cmd = process.env.KARMAX_OPENCODE_CMD ?? 'opencode';
  const env = configHome
    ? scrubbedEnv({ provider: 'opencode', configHome })
    : { ...(process.env as Record<string, string>) };
  const child = spawn(cmd, ['models'], { env, stdio: ['ignore', 'pipe', 'ignore'] });
  let output = '';
  child.stdout?.on('data', (chunk) => { output += chunk; });
  await withTimeout(new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => code === 0 ? resolve() : reject(new Error(`opencode models exited ${code}`)));
  }), timeoutMs).catch((error) => {
    if (!child.killed) child.kill();
    throw error;
  });
  return [...new Set(output.split(/\r?\n/).map((line) => line.trim()).filter((line) => /^[^\s/]+\/[^\s]+$/.test(line)))]
    .map((id) => ({ id }));
}

/** Ask an ACP harness for its negotiated model picker, scoped to one login home. */
export async function acpModels(
  provider: Extract<AcpProvider, 'kimi' | 'grok'>,
  configHome?: string,
  timeoutMs = 10_000,
): Promise<AvailableModel[]> {
  const env = configHome
    ? scrubbedEnv({ provider, configHome })
    : { ...(process.env as Record<string, string>) };
  const command = provider === 'kimi'
    ? process.env.KARMAX_KIMI_CMD ?? 'kimi'
    : process.env.KARMAX_GROK_CMD ?? 'grok';
  const args = provider === 'kimi' ? ['acp'] : ['--no-auto-update', 'agent', 'stdio'];
  const child = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'ignore'] });
  const app = client({ name: 'karmax-model-picker' })
    .onRequest(methods.client.session.requestPermission, () => ({ outcome: { outcome: 'cancelled' as const } }))
    .onRequest(methods.client.fs.readTextFile, () => ({ content: '' }))
    .onRequest(methods.client.fs.writeTextFile, () => ({}));
  try {
    if (!child.stdin || !child.stdout) return [];
    const stream = ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    );
    return await withTimeout(app.connectWith(stream, async (agent) => {
      const init = await agent.request(methods.agent.initialize, {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
        clientInfo: { name: 'karmax-model-picker', version: '1.0.0' },
      });
      if (init.protocolVersion !== PROTOCOL_VERSION) return [];
      if (init.authMethods?.length) {
        const auth = selectAcpAuthMethod(init.authMethods, env, !!configHome);
        if (!auth) return [];
        await agent.request(methods.agent.authenticate, { methodId: auth.id });
      }
      const created = await agent.request(methods.agent.session.new, { cwd: process.cwd(), mcpServers: [] });
      const options = created.configOptions ?? [];
      const modelOption = options.find((o) => o.category === 'model' || o.id === 'model');
      const effortOption = options.find((o) => o.category === 'thought_level' || o.id === 'thought_level');
      const values = (option: SessionConfigOption | undefined): { value: string; name: string; description?: string }[] => {
        if (!option || option.type !== 'select') return [];
        return option.options.flatMap((entry: any) => Array.isArray(entry?.options) ? entry.options : [entry]);
      };
      const effort = values(effortOption).map((entry) => entry.value);
      return values(modelOption).map((entry) => ({
        id: entry.value,
        displayName: entry.name,
        ...(entry.description ? { description: entry.description } : {}),
        ...(effort.length ? { effort } : {}),
        ...(entry.value === (modelOption as any)?.currentValue ? { isDefault: true } : {}),
      }));
    }), timeoutMs);
  } finally {
    try { child.stdin?.end(); } catch { /* closed */ }
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
