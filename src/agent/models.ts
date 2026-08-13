import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { client, methods, ndJsonStream, PROTOCOL_VERSION, type SessionConfigOption } from '@agentclientprotocol/sdk';
import { CodexAppServerClient } from './codex-app-server-client.js';
import { localProviderCli } from './provider-cli.js';
import { capturedToken, claudeAccessToken, scrubbedEnv } from '../autonomy/config-homes.js';
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

/** Stable Claude selections that remain valid even when the account-aware SDK
 * picker returns a partial list. `supportedModels()` is live metadata, but it is
 * not an exhaustive registry: gated and special-context models can be absent
 * even though Claude Code accepts their exact ids. Keep discovery additive so
 * a successful partial response cannot hide a known selectable model. */
export const CLAUDE_MODEL_PRESETS: AvailableModel[] = [
  { id: 'default' },
  { id: 'opus[1m]' },
  { id: 'claude-fable-5[1m]', displayName: 'Fable 5' },
  { id: 'sonnet' },
  { id: 'haiku' },
];

export function claudeModelCatalog(discovered: AvailableModel[]): AvailableModel[] {
  return mergeModels([discovered, CLAUDE_MODEL_PRESETS]);
}

/** A credential-safe reason for provider-discovery logs. Provider exceptions can
 * contain response bodies, paths, or auth headers, none of which belong in logs. */
export function modelDiscoveryFailureReason(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  if (/timed out/i.test(message)) return 'timed out';
  const status = message.match(/\b(?:API |returned |status[=: ]+)([45]\d\d)\b/i)?.[1];
  if (status) return `provider returned ${status}`;
  if (/no available models/i.test(message)) return 'provider returned no models';
  if (/no model list/i.test(message)) return 'provider returned an invalid catalog';
  return error instanceof Error && error.name ? error.name : 'unknown error';
}

interface ClaudeModelDiscoveryDeps {
  query?: (input: any) => {
    supportedModels(): Promise<Array<{
      value: string;
      displayName?: string;
      description?: string;
      supportedEffortLevels?: string[];
    }>>;
    close(): void;
  };
  apiModels?: typeof claudeApiModels;
}

/** Ask Anthropic's account-aware models endpoint for exact model ids. Claude
 * Code's SDK picker is deliberately a short alias list (`opus[1m]`, `sonnet`,
 * etc.), so supportedModels() alone can omit a newly available exact model even
 * while the connected account can already run it. */
export async function claudeApiModels(
  configHome?: string,
  timeoutMs = 10_000,
  request: typeof fetch = fetch,
): Promise<AvailableModel[]> {
  const oauthToken = configHome
    ? claudeAccessToken(configHome) ?? capturedToken(configHome)
    : undefined;
  const apiKey = configHome ? undefined : process.env.ANTHROPIC_API_KEY;
  if (!oauthToken && !apiKey) return [];

  const baseUrl = process.env.KARMAX_ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com';
  const response = await request(`${baseUrl.replace(/\/+$/, '')}/v1/models?limit=1000`, {
    method: 'GET',
    headers: {
      ...(oauthToken ? { authorization: `Bearer ${oauthToken}`, 'anthropic-beta': 'oauth-2025-04-20' } : {}),
      ...(apiKey ? { 'x-api-key': apiKey } : {}),
      'anthropic-version': '2023-06-01',
      'user-agent': 'karmax-model-picker/1.0',
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`Anthropic models API ${response.status}`);
  const body = await response.json() as { data?: Array<{ id?: unknown; display_name?: unknown }> };
  if (!Array.isArray(body.data)) throw new Error('Anthropic models API returned no model list');
  return body.data.flatMap((model) => {
    if (typeof model.id !== 'string' || !model.id) return [];
    return [{
      id: model.id,
      ...(typeof model.display_name === 'string' && model.display_name ? { displayName: model.display_name } : {}),
    }];
  });
}

/** Ask both Claude Code and Anthropic for the models available to this login. No
 * model turn is made: the SDK streaming input stays idle while initialization
 * metadata is read, then the exact REST catalog fills in models omitted by the
 * CLI's alias-oriented picker.
 *
 * Claude Code may refresh or clear its credential file during initialization.
 * Model discovery is read-only, so run it in a throwaway config home carrying
 * only the current access token. Copying the refresh token would still be unsafe:
 * a successful refresh can rotate it and strand the canonical home with the old
 * value even if the copy is later discarded. */
export async function claudeModels(
  configHome?: string,
  timeoutMs = 10_000,
  deps: ClaudeModelDiscoveryDeps = {},
): Promise<AvailableModel[]> {
  const query = deps.query ?? (await import('@anthropic-ai/claude-agent-sdk')).query;
  async function* idleInput(): AsyncGenerator<never, void, unknown> {
    await new Promise<void>(() => undefined);
  }
  let sdkModels: AvailableModel[] = [];
  let sdkError: unknown;
  const oauthToken = configHome
    ? claudeAccessToken(configHome) ?? capturedToken(configHome)
    : undefined;
  const apiKey = configHome ? undefined : process.env.ANTHROPIC_API_KEY;
  if (oauthToken || apiKey) {
    const probeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-claude-models-'));
    fs.chmodSync(probeHome, 0o700);
    const env = scrubbedEnv({
      provider: 'claude',
      configHome: probeHome,
      extra: {
        ...(oauthToken ? { CLAUDE_CODE_OAUTH_TOKEN: oauthToken } : {}),
        ...(apiKey ? { ANTHROPIC_API_KEY: apiKey } : {}),
      },
    });
    let session: ReturnType<NonNullable<ClaudeModelDiscoveryDeps['query']>> | undefined;
    try {
      session = query({ prompt: idleInput(), options: { cwd: process.cwd(), env } });
      const models = await withTimeout(session.supportedModels(), timeoutMs);
      sdkModels = models.map((m) => ({
        id: m.value,
        displayName: m.displayName,
        description: m.description,
        ...(m.supportedEffortLevels?.length ? { effort: [...m.supportedEffortLevels] } : {}),
        ...(m.value === 'default' ? { isDefault: true } : {}),
      }));
    } catch (error) {
      sdkError = error;
    } finally {
      try { session?.close(); } finally {
        fs.rmSync(probeHome, { recursive: true, force: true });
      }
    }
  }

  let apiModels: AvailableModel[] = [];
  let apiError: unknown;
  try {
    apiModels = await (deps.apiModels ?? claudeApiModels)(configHome, timeoutMs);
  } catch (error) {
    apiError = error;
  }
  const defaults = sdkModels.filter((model) => model.isDefault);
  const aliases = sdkModels.filter((model) => !model.isDefault);
  const merged = mergeModels([defaults, apiModels, aliases]);
  if (merged.length) return merged;
  throw sdkError ?? apiError ?? new Error('Claude returned no available models');
}

/** Ask Codex app-server for its native model picker. This is account-aware and is
 * more useful than the OpenAI REST /models endpoint, which is a broad API catalog. */
export async function codexModels(configHome?: string, timeoutMs = 10_000): Promise<AvailableModel[]> {
  const cmd = process.env.KARMAX_CODEX_EXEC_CMD ?? localProviderCli('codex');
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
