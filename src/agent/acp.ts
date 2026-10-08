import { workEnvironment, openCodeWorkEnvironment } from './work-environment.js';
import { currentTiming } from '../timing/index.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import {
  PROTOCOL_VERSION,
  RequestError,
  client,
  methods,
  ndJsonStream,
  type AgentCapabilities,
  type AuthMethod,
  type ContentBlock,
  type McpServer,
  type SessionConfigOption,
  type SessionUpdate,
  type ToolCall,
} from '@agentclientprotocol/sdk';
import type { AgentProfile, Provider } from '../domain/types.js';
import { platformMcpSpec, scrubbedEnv } from '../autonomy/config-homes.js';
import {
  apiKeyEnv,
  credentialAliases,
  credentialProvider,
  isAcpProvider,
  modelProviderFromModel,
  type AcpProvider,
} from './provider-registry.js';
import { messagesToDeliver, conversationToPromptText } from './history.js';
import { collectAcpImageBlocks } from './images.js';
import { activityDetail, toolActivityDetail } from './activity.js';
import { createCustodyEnv, registerAgent, unregisterAgent, killAgent } from './custody.js';
import { PLATFORM_TOOL_SCHEMAS, platformToolHandlers } from './tools.js';
import { CONTROL_SERVER_NAME, CONTROL_SOCKET_ENV, CONTROL_TOKEN_ENV, controlMcpServerSpec, remoteControlBridge,
  startControlBridge, type ControlBridge, type RemoteControlBridge } from './control-bridge.js';
import { trackProcess } from '../util/processes.js';
import { isRemoteAgentWorld, remoteAgentEnv, spawnRemoteAgentProcess, type RemoteSpawnedProcess } from './remote-process.js';
import { exportRemoteAcpSession, multiplexAcpChannel, prepareRemoteAcpTurn, remoteAcpSupported, type RemoteAcpTurn } from './remote-acp.js';
import { worldWorkingDirectory } from '../world/types.js';
import type { AdapterTurn, AgentAdapter, PlatformToolContext, TurnInput } from './types.js';
import { BRAND } from '../domain/brand.js';
import { ProviderStreamError, SandboxProviderFailure } from './limits.js';

interface HarnessSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
}

interface AcpTerminal {
  child: ChildProcess;
  custodyId: string;
  output: string;
  truncated: boolean;
  limit: number;
  exitStatus?: { exitCode?: number | null; signal?: string | null };
  exited: Promise<{ exitCode?: number | null; signal?: string | null }>;
}

/** Choose a non-interactive ACP auth method from the agent's advertised list. */
export function selectAcpAuthMethod(
  authMethods: AuthMethod[] | null | undefined,
  env: Record<string, string>,
  hasConfigHome: boolean,
): AuthMethod | undefined {
  if (!authMethods?.length) return undefined;
  const hasApiKey = Object.entries(env).some(([name, value]) => name.endsWith('_API_KEY') && !!value);
  const envReady = authMethods.find((method) =>
    (method as any).type === 'env_var'
    && ((method as any).vars ?? []).every((entry: any) => entry.optional || !!env[entry.name]),
  );
  if (envReady) return envReady;
  const byId = (pattern: RegExp) => authMethods.find((method) => pattern.test(method.id));
  if (hasApiKey) {
    const key = byId(/api[-_.]?key|xai\.api_key/i);
    if (key && (key as any).type !== 'terminal') return key;
  }
  if (hasConfigHome) {
    const cached = byId(/cached|session|oauth|token/i);
    if (cached && (cached as any).type !== 'terminal') return cached;
  }
  return authMethods.find((method) => (method as any).type !== 'terminal');
}

function appendTerminalOutput(terminal: AcpTerminal, chunk: Buffer): void {
  terminal.output += chunk.toString();
  const bytes = Buffer.from(terminal.output);
  if (bytes.length <= terminal.limit) return;
  let start = bytes.length - terminal.limit;
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++;
  terminal.output = bytes.subarray(start).toString();
  terminal.truncated = true;
}

function openCodeModel(profile: AgentProfile): string | undefined {
  if (!profile.model) return undefined;
  const provider = credentialProvider(profile);
  const prefix = modelProviderFromModel(profile.model);
  if (!prefix) return `${provider}/${profile.model}`;
  // A standard provider/model id is already complete. When the prefix is custom
  // or ambiguous and core resolved a different API-key provider from Credentials,
  // preserve the full model id as the provider-specific model suffix.
  if (credentialAliases(provider).includes(prefix) || credentialAliases(prefix).includes(provider)) return profile.model;
  return profile.modelProvider ? `${provider}/${profile.model}` : profile.model;
}

function openCodeConfig(profile: AgentProfile, hasApiKey: boolean, systemPrompt: string): Record<string, unknown> {
  const model = openCodeModel(profile);
  const provider = credentialProvider(profile);
  const config: Record<string, unknown> = {
    ...(model ? { model } : {}),
    // Karmax's world is the security boundary; provider-side prompts would park
    // an unattended Temporal activity with no user present to answer.
    permission: { '*': 'allow' },
    autoupdate: false,
    // OpenCode's documented agent configuration gives Karmax's role prompt real
    // system-prompt semantics and enforces the same iteration budget exposed by
    // AgentProfile.maxTurns. Both stay process-local in CONFIG_CONTENT.
    agent: {
      build: {
        prompt: systemPrompt,
        ...(profile.maxTurns ? { steps: profile.maxTurns } : {}),
      },
    },
  };
  // Kimi Code membership keys use a coding-specific endpoint, not Moonshot's
  // pay-as-you-go endpoint. Defining it as a normal OpenCode provider preserves
  // OpenCode's real User-Agent and full harness behaviour.
  if (provider === 'kimi') {
    config.provider = {
      kimi: {
        npm: '@ai-sdk/openai-compatible',
        name: 'Kimi Code',
        options: {
          baseURL: process.env.KARMAX_KIMI_BASE_URL ?? 'https://api.kimi.com/coding/v1',
          apiKey: '{env:KIMI_API_KEY}',
        },
        models: {
          k3: { name: 'Kimi K3' },
          'kimi-for-coding': { name: 'Kimi K2.7 Code' },
          'kimi-for-coding-highspeed': { name: 'Kimi K2.7 Code HighSpeed' },
        },
      },
    };
  } else if (hasApiKey) {
    // Explicit env interpolation avoids relying on each AI SDK package's
    // conventional variable name (Google alone has several). The secret remains
    // process-local and the provider implementation remains OpenCode's official one.
    config.provider = {
      [provider]: {
        options: { apiKey: `{env:${apiKeyEnv(provider)}}` },
      },
    };
  }
  return config;
}

/** Above this, OpenCode reads the system prompt from a file (`{file:…}`): an
 * environment variable such as OPENCODE_CONFIG_CONTENT is capped at 128 KiB by
 * Linux (MAX_ARG_STRLEN), and the whole spawn fails with E2BIG past it. */
const INLINE_PROMPT_BYTES = 32 * 1024;

function harnessSpec(input: TurnInput, systemPrompt = input.systemPrompt): HarnessSpec {
  const provider = input.profile.provider;
  if (!isAcpProvider(provider)) throw new Error(`ACP does not support harness "${provider}"`);
  // The same scrub as the Claude and Codex rails: the vault key, auth secret and
  // billing keys live in this process's environment and the harness (and every
  // shell it opens through `terminal.create`) must not inherit them.
  const env = scrubbedEnv({ provider, configHome: input.resolvedAuth?.configHome, extra: input.extraEnv });
  const credentialEnv = apiKeyEnv(credentialProvider(input.profile));
  if (input.resolvedAuth?.apiKey && !credentialEnv) throw new Error('Unsupported model API-key provider');
  const ambientApiKey = input.resolvedAuth || !credentialEnv ? undefined : process.env[credentialEnv];
  for (const key of [
    'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'KIMI_API_KEY', 'MOONSHOT_API_KEY',
    'XAI_API_KEY', 'GEMINI_API_KEY', 'OPENROUTER_API_KEY', 'GROQ_API_KEY',
    'MISTRAL_API_KEY', 'DEEPSEEK_API_KEY', 'KIMI_MODEL_API_KEY',
  ]) delete env[key];
  if (input.resolvedAuth?.apiKey) env[credentialEnv] = input.resolvedAuth.apiKey;
  else if (ambientApiKey) env[credentialEnv] = ambientApiKey;

  if (provider === 'opencode') {
    env.OPENCODE_DISABLE_AUTOUPDATE = '1';
    env.OPENCODE_CONFIG_CONTENT = JSON.stringify(openCodeConfig(input.profile, !!env[credentialEnv], systemPrompt));
    return { command: process.env.KARMAX_OPENCODE_CMD ?? 'opencode', args: ['acp'], env };
  }
  if (provider === 'kimi') {
    env.KIMI_CODE_NO_AUTO_UPDATE = '1';
    // Kimi Code intentionally ignores ordinary shell API-key variables. Its
    // documented KIMI_MODEL_* channel is the JIT, non-persistent credential
    // mechanism, so vault secrets never have to be written into config.toml.
    const key = input.resolvedAuth?.apiKey ?? ambientApiKey;
    if (key) {
      env.KIMI_MODEL_NAME = (input.profile.model ?? 'kimi-for-coding').replace(/^kimi\//, '');
      env.KIMI_MODEL_API_KEY = key;
      env.KIMI_MODEL_PROVIDER_TYPE = 'kimi';
      env.KIMI_MODEL_BASE_URL = process.env.KARMAX_KIMI_BASE_URL ?? 'https://api.kimi.com/coding/v1';
      if (input.profile.effort) env.KIMI_MODEL_THINKING_EFFORT = input.profile.effort;
    }
    return { command: process.env.KARMAX_KIMI_CMD ?? 'kimi', args: ['acp'], env };
  }
  return { command: process.env.KARMAX_GROK_CMD ?? 'grok', args: ['--no-auto-update', 'agent', 'stdio'], env };
}

function executable(command: string, env: Record<string, string>): string {
  if (path.isAbsolute(command)) return command;
  for (const dir of (env.PATH ?? '').split(path.delimiter)) {
    const candidate = path.join(dir, command);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return command;
}

/**
 * The MCP servers handed to the ACP agent at `session/new` / `resume` / `fork`:
 *
 *   · `karmax`         — the durable, gateway-backed platform MCP (task list,
 *                        wiki, vault, `platform_request`), authorized by the
 *                        turn's scoped `KARMAX_TOKEN`.
 *   · `karmax_control` — the TURN-LOCAL control tools (`confirm_decision`,
 *                        `resolve_decision`, `create_review_info`, …). An ACP
 *                        harness owns its own model loop and only accepts stdio
 *                        MCP servers it spawns itself, so these reach this
 *                        activity over the per-turn socket bridge. Without it an
 *                        OpenCode agent could not produce a Resolve/Confirm
 *                        verdict at all, even though prompt.ts advertises the
 *                        tools (see control-bridge.ts).
 *   · workflow-declared `agentMcp` servers.
 */
function mcpServers(input: TurnInput, control?: ControlBridge, remote?: { turn: RemoteAcpTurn; bridge?: RemoteControlBridge }): McpServer[] {
  if (remote) {
    // In a sandbox every command is a sandbox path. The durable platform tools
    // are not a separate gateway MCP there (the host's `karmax-mcp` cannot run
    // in it): like remote Claude and Codex, they travel with the turn-local
    // controls over the agent's own channel (remote-acp.ts).
    return [
      ...(remote.bridge ? [{
        name: CONTROL_SERVER_NAME,
        command: remote.turn.control.command,
        args: remote.turn.control.args,
        env: [{ name: CONTROL_SOCKET_ENV, value: remote.turn.relay.socket }, { name: CONTROL_TOKEN_ENV, value: remote.bridge.token }],
      }] : []),
      ...(input.agentMcp ?? []).map((s) => ({ name: s.name, command: s.command, args: s.args ?? [],
        env: Object.entries(s.env ?? {}).map(([name, value]) => ({ name, value })) })),
    ];
  }
  const gateway = platformMcpSpec(process.env.KARMAX_GATEWAY_URL ?? 'http://127.0.0.1:4505');
  const declared = [
    { name: 'karmax', ...gateway },
    ...(control ? [{ name: CONTROL_SERVER_NAME, ...controlMcpServerSpec(control) }] : []),
    ...(input.agentMcp ?? []).map((s) => ({ name: s.name, command: s.command, args: s.args ?? [], env: s.env })),
  ];
  return declared.map((s) => ({
    name: s.name,
    command: executable(s.command, process.env as Record<string, string>),
    args: s.args,
    env: Object.entries({ ...(s.env ?? {}), ...(s.name === 'karmax' ? input.extraEnv ?? {} : {}) })
      .map(([name, value]) => ({ name, value })),
  }));
}

function optionValues(option: SessionConfigOption): { value: string; name: string }[] {
  if (option.type !== 'select') return [];
  return option.options.flatMap((entry: any) =>
    Array.isArray(entry?.options) ? entry.options : [entry],
  );
}

async function configureSession(
  ctx: any,
  sessionId: string,
  options: SessionConfigOption[] | null | undefined,
  profile: AgentProfile,
): Promise<void> {
  const set = async (category: string, desired: string | undefined) => {
    if (!desired) return;
    const option = options?.find((o) => o.category === category || o.id === category);
    if (!option || option.type !== 'select') return;
    const values = optionValues(option);
    const hit = values.find((v) => v.value === desired)
      ?? values.find((v) => v.value.endsWith(`/${desired}`))
      ?? values.find((v) => v.name.toLowerCase() === desired.toLowerCase());
    if (!hit || hit.value === option.currentValue) return;
    await ctx.request(methods.agent.session.setConfigOption, {
      sessionId,
      configId: option.id,
      value: hit.value,
    });
  };
  await set('model', profile.model);
  await set('thought_level', profile.effort);
}

function updateActivity(update: SessionUpdate, prior: Map<string, ToolCall>) {
  if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
    const old = prior.get(update.toolCallId);
    const tool = { ...(old ?? {}), ...update } as ToolCall;
    prior.set(update.toolCallId, tool);
    const status = tool.status ?? 'in_progress';
    const phase = status === 'failed' ? 'failed' : status === 'completed' ? 'completed' : status === 'pending' || !old ? 'started' : 'updated';
    const kind =
      tool.kind === 'execute' ? 'command'
      : ['read', 'edit', 'delete', 'move'].includes(tool.kind ?? '') ? 'file'
      : tool.kind === 'search' || tool.kind === 'fetch' ? 'search'
      : tool.kind === 'think' ? 'reasoning'
      : 'tool';
    // Credential-bearing tools publish no detail at all (see SECRET_TOOL_NAMES).
    const detail = toolActivityDetail(tool.name ?? tool.title, tool.rawOutput ?? tool.rawInput ?? tool.content);
    return {
      id: tool.toolCallId,
      kind,
      phase,
      title: tool.title || tool.name || 'Tool call',
      ...(detail ? { detail } : {}),
    } as const;
  }
  if (update.sessionUpdate === 'plan' || update.sessionUpdate === 'plan_update') {
    return { id: (update as any).planId ?? 'acp-plan', kind: 'status', phase: 'updated', title: 'Updated plan', detail: activityDetail(update) } as const;
  }
  return undefined;
}

function textOf(block: ContentBlock): string {
  return block.type === 'text' ? block.text : '';
}

/**
 * Generic ACP adapter. OpenCode is currently admitted; dormant Kimi Code and
 * Grok Build branches remain replay/backward-compatible while registry
 * admission enforces Karmax's parity requirements.
 */
export class AcpAdapter implements AgentAdapter {
  readonly provider: AcpProvider;

  constructor(provider: AcpProvider) {
    this.provider = provider;
  }

  async runTurn(input: TurnInput, ctx: PlatformToolContext): Promise<AdapterTurn> {
    // A remote world is the execution boundary: the harness must run in the
    // sandbox (remote-acp.ts), never on this host against a sandbox path.
    // Kimi Code and Grok Build have no remote implementation and are not
    // admitted (AGENT_PROVIDERS); say so rather than hang on a host spawn.
    if (isRemoteAgentWorld(input.world) && !remoteAcpSupported(this.provider))
      throw new Error(
        `the ${this.provider} agent cannot run in a remote (cloud sandbox) world — it only runs where ${BRAND} itself runs. `
        + 'Choose a Claude, Codex or OpenCode agent for this task, or give the project a local worktree world.');
    const work = await openCodeWorkEnvironment(input, !!ctx.onSecretEnvChange);
    const unsubscribe = ctx.onSecretEnvChange?.(work.update);
    try { return await this.runAcpTurn(input, ctx, work.plugin); }
    finally { unsubscribe?.(); work.cleanup(); }
  }

  private async runAcpTurn(input: TurnInput, ctx: PlatformToolContext, workPlugin?: string): Promise<AdapterTurn> {
    const remote = isRemoteAgentWorld(input.world);
    const runtimeWorld = input.world.withoutProjectEnvironment?.() ?? input.world;
    // The world's working directory is the session's, as for remote Claude and
    // Codex; a local harness keeps the world root it has always used.
    const cwd = remote ? worldWorkingDirectory(runtimeWorld.handle) : input.world.handle.root;
    const handlers = platformToolHandlers(input.world, ctx, () => workEnvironment(input));
    let remoteTurn: RemoteAcpTurn | undefined;
    let remoteBridge: RemoteControlBridge | undefined;
    let remoteProcess: RemoteSpawnedProcess | undefined;
    let remoteEnv: Record<string, string> | undefined;
    let control: ControlBridge | undefined;
    let promptDirectory: string | undefined;
    const release = async () => {
      (await control?.close());
      remoteBridge?.close();
      if (promptDirectory) fs.rmSync(promptDirectory, { recursive: true, force: true });
      await remoteTurn?.cleanup();
    };
    let spec: HarnessSpec;
    try {
      let systemPrompt = input.systemPrompt;
      if (remote) {
        // A login's home seeds the sandbox; an API-key turn uses the shared one.
        const localHome = input.resolvedAuth?.apiKey ? undefined : input.resolvedAuth?.configHome;
        remoteTurn = await prepareRemoteAcpTurn(runtimeWorld, { provider: this.provider, localHome, session: input.session,
          systemPrompt: input.systemPrompt });
        systemPrompt = `{file:${remoteTurn.promptFile}}`;
      } else if (this.provider === 'opencode' && Buffer.byteLength(input.systemPrompt) > INLINE_PROMPT_BYTES) {
        promptDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'kx-acp-prompt-'));
        fs.chmodSync(promptDirectory, 0o700);
        const file = path.join(promptDirectory, 'system-prompt.md');
        fs.writeFileSync(file, input.systemPrompt, { mode: 0o600 });
        systemPrompt = `{file:${file}}`;
      }
      spec = harnessSpec(input, systemPrompt);
      if (workPlugin) {
        const config = JSON.parse(spec.env.OPENCODE_CONFIG_CONTENT!);
        config.plugin = [...(config.plugin ?? []), workPlugin];
        spec.env.OPENCODE_CONFIG_CONTENT = JSON.stringify(config);
      }
      // Turn-local controls, served for exactly this turn and torn down in
      // `finally` below — they must never outlive the activity whose result
      // they mutate (control-bridge.ts). In a sandbox they also carry the
      // durable platform tools, as remote Claude and Codex do.
      if (remote) remoteBridge = remoteControlBridge(handlers, PLATFORM_TOOL_SCHEMAS);
      else control = await startControlBridge(handlers);
    } catch (error) {
      await release();
      throw error;
    }
    const startupEnd = (await (await currentTiming())?.start('process.acp-startup'));
    let child: ChildProcess | RemoteSpawnedProcess;
    let io: { stdin: Writable; stdout: Readable };
    let custody: ReturnType<typeof createCustodyEnv> | undefined;
    if (remote) {
      const credentialEnv = apiKeyEnv(credentialProvider(input.profile));
      remoteEnv = remoteAgentEnv(this.provider, remoteTurn!.home.absolute, {
        ...spec.env,
        KARMAX_GATEWAY_URL: process.env.KARMAX_PUBLIC_URL ?? process.env.KARMAX_GATEWAY_URL,
      }, credentialEnv ? [credentialEnv] : []);
      remoteEnv.PATH = `${remoteTurn!.home.runtimeBin}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`;
      remoteProcess = spawnRemoteAgentProcess({ world: runtimeWorld, provider: this.provider, command: this.provider,
        args: spec.args, cwd, env: remoteEnv, home: remoteTurn!.home.absolute, relay: remoteTurn!.relay,
        ...(remoteTurn!.prelude ? { prelude: remoteTurn!.prelude } : {}), signal: ctx.signal });
      remoteProcess.on('error', () => {});
      const channel = multiplexAcpChannel(remoteProcess, (frame) => remoteBridge?.serve(frame, (reply) => channel.sendControl(reply)));
      child = remoteProcess;
      io = channel;
    } else {
      custody = createCustodyEnv(spec.env);
      spec.env = custody.env as Record<string, string>;
      const local = spawn(spec.command, spec.args, {
        cwd,
        env: spec.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        detached: true,
      });
      child = local;
      io = { stdin: local.stdin!, stdout: local.stdout! };
      local.on('error', () => {});
      if (local.pid) {
        registerAgent({ pid: local.pid, cmd: path.basename(spec.command), provider: this.provider, taskId: input.world.handle.id, role: input.role, owner: process.pid, custodyId: custody.custodyId, startedAt: Date.now() });
        local.once('exit', trackProcess({
          pid: local.pid,
          kind: 'agent',
          label: `${this.provider} agent (${input.role})`,
          taskId: input.world.handle.id,
          startedAt: Date.now(),
          kill: (signal) => void killAgent(local.pid, signal === 'SIGKILL' ? 0 : 2500, custody!.custodyId),
        }));
      }
    }
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer | string) => { stderr = `${stderr}${chunk}`.slice(-4000); });
    const stopChild = async () => {
      if (remoteProcess) { await remoteProcess.stop().catch(() => undefined); return; }
      const pid = (child as ChildProcess).pid;
      if (pid) await killAgent(pid, 2500, custody?.custodyId);
    };

    let sessionId: string | undefined;
    // One turn streams many messages. The live text is the current message's
    // own: a tool call or a new message id ends it as a timeline item, and a
    // thought is recorded once, whole, not per chunk (#396 review item 6).
    const messages: string[] = [];
    let message: { id?: string; text: string } | undefined;
    let thought: { id: string; text: string } | undefined;
    let items = 0;
    const endMessage = () => {
      if (message?.text) {
        messages.push(message.text);
        ctx.emitActivity({ id: message.id ?? `acp-message-${++items}`, kind: 'message', phase: 'completed', title: message.text });
      }
      message = undefined;
    };
    const endThought = () => {
      if (thought?.text) ctx.emitActivity({ id: thought.id, kind: 'reasoning', phase: 'completed', title: 'Reasoning', detail: thought.text });
      thought = undefined;
    };
    const finalText = () => { endThought(); endMessage(); return messages.join('\n\n'); };
    let delivered = input.messages.length;
    let replayAll = false; // the stored session could not be continued (see `continued`)
    let steered = false; // a mid-turn follow-up cancelled this prompt to hand it to the next turn
    let clientContext: any;
    const tools = new Map<string, ToolCall>();
    const terminals = new Map<string, AcpTerminal>();
    let terminalSeq = 0;
    const app = client({ name: BRAND })
      .onRequest(methods.client.session.requestPermission, ({ params }) => {
        const allow = params.options.find((o) => o.kind === 'allow_always')
          ?? params.options.find((o) => o.kind === 'allow_once');
        return allow
          ? { outcome: { outcome: 'selected' as const, optionId: allow.optionId } }
          : { outcome: { outcome: 'cancelled' as const } };
      })
      .onRequest(methods.client.fs.readTextFile, async ({ params }) => {
        const source = await fs.promises.readFile(params.path, 'utf8');
        if (!params.line && !params.limit) return { content: source };
        const start = Math.max(0, (params.line ?? 1) - 1);
        return { content: source.split('\n').slice(start, params.limit ? start + params.limit : undefined).join('\n') };
      })
      .onRequest(methods.client.fs.writeTextFile, async ({ params }) => {
        await fs.promises.mkdir(path.dirname(params.path), { recursive: true });
        await fs.promises.writeFile(params.path, params.content, 'utf8');
        return {};
      })
      .onRequest(methods.client.terminal.create, ({ params }) => {
        const terminalId = `karmax-terminal-${++terminalSeq}`;
        const env = {
          ...spec.env,
          ...workEnvironment(input),
          ...Object.fromEntries((params.env ?? []).map((entry) => [entry.name, entry.value])),
        };
        const terminalCustody = createCustodyEnv(env);
        const command = spawn(params.command, params.args ?? [], {
          cwd: params.cwd ?? input.world.handle.root,
          env: terminalCustody.env,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
          detached: true,
        });
        let resolveExit!: (status: { exitCode?: number | null; signal?: string | null }) => void;
        const exited = new Promise<{ exitCode?: number | null; signal?: string | null }>((resolve) => { resolveExit = resolve; });
        const terminal: AcpTerminal = {
          child: command,
          custodyId: terminalCustody.custodyId,
          output: '',
          truncated: false,
          limit: Math.min(1024 * 1024, Math.max(1, params.outputByteLimit ?? 1024 * 1024)),
          exited,
        };
        terminals.set(terminalId, terminal);
        command.stdout?.on('data', (chunk: Buffer) => appendTerminalOutput(terminal, chunk));
        command.stderr?.on('data', (chunk: Buffer) => appendTerminalOutput(terminal, chunk));
        command.once('error', (error) => appendTerminalOutput(terminal, Buffer.from(`${error.message}\n`)));
        command.once('close', (code, signal) => {
          terminal.exitStatus = { exitCode: code, signal };
          resolveExit(terminal.exitStatus);
          if (command.pid) {
            unregisterAgent(command.pid);
          }
        });
        if (command.pid) {
          registerAgent({ pid: command.pid, cmd: path.basename(params.command), provider: `${this.provider}-terminal`, taskId: input.world.handle.id, role: input.role, owner: process.pid, custodyId: terminalCustody.custodyId, startedAt: Date.now() });
          command.once('exit', trackProcess({
            pid: command.pid,
            kind: 'terminal',
            label: `${this.provider} terminal`,
            taskId: input.world.handle.id,
            startedAt: Date.now(),
            kill: (signal) => void killAgent(command.pid, signal === 'SIGKILL' ? 0 : 2500, terminalCustody.custodyId),
          }));
        }
        return { terminalId };
      })
      .onRequest(methods.client.terminal.output, ({ params }) => {
        const terminal = terminals.get(params.terminalId);
        if (!terminal) throw new Error(`unknown ACP terminal ${params.terminalId}`);
        return { output: terminal.output, truncated: terminal.truncated, exitStatus: terminal.exitStatus };
      })
      .onRequest(methods.client.terminal.waitForExit, async ({ params }) => {
        const terminal = terminals.get(params.terminalId);
        if (!terminal) throw new Error(`unknown ACP terminal ${params.terminalId}`);
        return terminal.exitStatus ?? await terminal.exited;
      })
      .onRequest(methods.client.terminal.kill, async ({ params }) => {
        const terminal = terminals.get(params.terminalId);
        if (!terminal) throw new Error(`unknown ACP terminal ${params.terminalId}`);
        if (terminal.child.pid) await killAgent(terminal.child.pid, 2500, terminal.custodyId);
        return {};
      })
      .onRequest(methods.client.terminal.release, async ({ params }) => {
        const terminal = terminals.get(params.terminalId);
        if (!terminal) return {};
        if (terminal.child.pid) await killAgent(terminal.child.pid, 2500, terminal.custodyId);
        terminals.delete(params.terminalId);
        return {};
      })
      .onNotification(methods.client.session.update, async ({ params }) => {
        if (sessionId && params.sessionId !== sessionId) return;
        (await (await currentTiming())?.markOnce('provider.first-event'));
        const update = params.update;
        if (update.sessionUpdate === 'agent_thought_chunk') {
          const id = update.messageId ?? thought?.id ?? `acp-reasoning-${++items}`;
          if (thought && thought.id !== id) endThought();
          thought ??= { id, text: '' };
          thought.text += textOf(update.content);
          return;
        }
        endThought();
        if (update.sessionUpdate === 'tool_call') endMessage();
        if (update.sessionUpdate === 'agent_message_chunk') {
          if (message && update.messageId && message.id !== update.messageId) endMessage();
          message ??= { text: '' };
          message.id ??= update.messageId ?? undefined;
          // Chunks are deltas; the task renders each emit as the whole live
          // message, so publish the growing text (LT-5).
          message.text += textOf(update.content);
          ctx.emit(message.text, 'assistant');
        }
        const activity = updateActivity(update, tools);
        if (activity) ctx.emitActivity(activity);
      });

    const abort = () => {
      if (sessionId && clientContext) void clientContext.notify(methods.agent.session.cancel, { sessionId }).catch(() => undefined);
      if (remoteProcess) remoteProcess.kill();
      else if ((child as ChildProcess).pid) void killAgent((child as ChildProcess).pid, 2500, custody?.custodyId);
    };
    if (ctx.signal?.aborted) abort();
    ctx.signal?.addEventListener('abort', abort, { once: true });
    const heartbeat = ctx.heartbeat ? setInterval(() => { try { ctx.heartbeat!(); } catch { /* cancellation arrives through signal */ } }, 10_000) : undefined;

    try {
      if (!io.stdin || !io.stdout) throw new Error(`${this.provider} ACP process has no stdio`);
      const stream = ndJsonStream(
        Writable.toWeb(io.stdin) as WritableStream<Uint8Array>,
        Readable.toWeb(io.stdout) as ReadableStream<Uint8Array>,
      );
      const response = await app.connectWith(stream, async (agent) => {
        clientContext = agent;
        const init = await agent.request(methods.agent.initialize, {
          protocolVersion: PROTOCOL_VERSION,
          // In a sandbox the agent's own tools already run where its files are;
          // client fs/terminal requests would run on this host instead.
          clientCapabilities: remote
            ? { fs: { readTextFile: false, writeTextFile: false }, terminal: false }
            : { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
          clientInfo: { name: BRAND, version: '1.0.0' },
        });
        (await startupEnd?.());
        if (init.protocolVersion !== PROTOCOL_VERSION) {
          throw new Error(`${this.provider} ACP protocol ${init.protocolVersion} is incompatible with ${PROTOCOL_VERSION}`);
        }
        const capabilities = init.agentCapabilities ?? {} as AgentCapabilities;
        if (this.provider === 'opencode') {
          const missing = [
            !capabilities.sessionCapabilities?.fork ? 'session/fork' : undefined,
            !(capabilities.sessionCapabilities?.resume || capabilities.loadSession) ? 'session resume/load' : undefined,
            !capabilities.promptCapabilities?.image ? 'image prompts' : undefined,
          ].filter(Boolean);
          if (missing.length) {
            throw new Error(
              `OpenCode ACP is below ${BRAND}'s parity requirement (missing ${missing.join(', ')}); update OpenCode`,
            );
          }
        }
        // ACP advertises the methods an agent *can* use; their presence does not
        // mean every session must authenticate. Kimi's documented KIMI_MODEL_*
        // provider is self-authenticating, while its sole ACP auth method is the
        // unrelated Kimi Code OAuth login. Calling that method here would reject a
        // valid API-key-only session.
        const usesKimiEphemeralProvider = this.provider === 'kimi' && !!spec.env.KIMI_MODEL_API_KEY;
        if (init.authMethods?.length && !usesKimiEphemeralProvider) {
          const auth = selectAcpAuthMethod(init.authMethods, spec.env, !!input.resolvedAuth?.configHome);
          if (!auth) throw new Error(`${this.provider} ACP agent requires an interactive login; connect the account first`);
          await agent.request(methods.agent.authenticate, { methodId: auth.id });
        }
        const servers = mcpServers(input, control, remote ? { turn: remoteTurn!, ...(remoteBridge ? { bridge: remoteBridge } : {}) } : undefined);
        let configOptions: SessionConfigOption[] | null | undefined;
        // The agent refused to continue a stored session — a world that holds
        // neither it nor its export (a fork across worlds from a session the
        // host never saw, a corrupted store). Losing the turn to that would
        // repeat on every retry; a new session given the whole conversation
        // continues the work, as a non-native fork does.
        const continued = async <T,>(request: () => Promise<T>): Promise<T | undefined> => {
          try { return await request(); } catch (error) {
            if (!remote || ctx.signal?.aborted) throw error;
            ctx.emitActivity({ id: 'acp-session-recovery', kind: 'status', phase: 'completed',
              title: 'Continuing in a new session with the conversation so far',
              ...(activityDetail(error instanceof Error ? error.message : error) ? { detail: activityDetail(error instanceof Error ? error.message : error) } : {}) });
            replayAll = true;
            return undefined;
          }
        };
        if (input.session && input.fork) {
          if (!capabilities.sessionCapabilities?.fork) throw new Error(`${this.provider} ACP agent does not support native session fork`);
          const forked = await continued(() => agent.request(methods.agent.session.fork, {
            sessionId: input.session!,
            cwd,
            mcpServers: servers,
          }));
          sessionId = forked?.sessionId;
          configOptions = forked?.configOptions;
        } else if (input.session) {
          if (capabilities.sessionCapabilities?.resume) {
            const resumed = await continued(() => agent.request(methods.agent.session.resume, {
              sessionId: input.session!,
              cwd,
              mcpServers: servers,
            }));
            sessionId = resumed ? input.session : undefined;
            configOptions = resumed?.configOptions;
          } else if (capabilities.loadSession) {
            const loaded = await continued(() => agent.request(methods.agent.session.load, {
              sessionId: input.session!,
              cwd,
              mcpServers: servers,
            }));
            sessionId = loaded ? input.session : undefined;
            configOptions = loaded?.configOptions;
          } else {
            throw new Error(`${this.provider} ACP agent cannot resume sessions`);
          }
        }
        if (!sessionId) {
          const created = await agent.request(methods.agent.session.new, {
            cwd,
            mcpServers: servers,
          });
          sessionId = created.sessionId;
          configOptions = created.configOptions;
        }
        ctx.onSession?.(sessionId);
        await configureSession(agent, sessionId, configOptions, input.profile);

        const delta = (replayAll ? input.messages : messagesToDeliver(input)).filter((m) => m.role !== 'system');
        let prompt = conversationToPromptText(delta);
        if ((!input.session || input.fork || replayAll) && this.provider !== 'opencode') {
          prompt = `<${BRAND}_instructions>\n${input.systemPrompt}\n</${BRAND}_instructions>\n\n${prompt || 'Begin the task.'}`;
        }
        const promptBlocks: ContentBlock[] = [{ type: 'text', text: prompt || 'Continue.' }];
        const images = collectAcpImageBlocks(delta);
        if (images.length && !capabilities.promptCapabilities?.image) {
          throw new Error(`${this.provider} ACP agent does not advertise image prompt support`);
        }
        promptBlocks.push(...images);
        // Cancel-to-boundary steering (SPEC §7.1). ACP v1 has no in-turn steer, so
        // while the turn runs we watch for a queued follow-up; on a new one we send
        // session/cancel (the agent then returns stopReason 'cancelled') and return
        // cleanly. `delivered` is left unchanged, so the workflow loops back to Do
        // and delivers the follow-up on the next turn.
        const followPoll = ctx.pullFollowUps
          ? setInterval(() => void (async () => {
              if (steered) return;
              try {
                if ((await ctx.pullFollowUps!(delivered)).length) {
                  steered = true;
                  if (sessionId) void agent.notify(methods.agent.session.cancel, { sessionId }).catch(() => undefined);
                }
              } catch { /* a failed poll must not break the turn */ }
            })(), 1200)
          : undefined;
        let result;
        const roundEnd = (await (await currentTiming())?.start('provider.acp-roundtrip.opaque'));
        try {
          result = await agent.request(methods.agent.session.prompt, {
            sessionId,
            prompt: promptBlocks,
          }, { cancellationSignal: ctx.signal });
        } catch (error) {
          // The agent's own error answer to the prompt carries the model
          // provider's failure (a quota, a revoked key): tag it as the provider's,
          // so it parks on its reset like a Claude or Codex limit instead of
          // failing the task (live 2026-10-08: an exhausted Anthropic workspace).
          if (error instanceof RequestError && !ctx.signal?.aborted) throw new ProviderStreamError(error.message);
          throw error;
        } finally {
          (await roundEnd?.(ctx.signal?.aborted || result?.stopReason === 'cancelled' ? 'cancelled' : result?.stopReason === 'end_turn' ? 'ok' : 'failed'));
          if (followPoll) clearInterval(followPoll);
        }
        // The SDK dispatches notifications independently from request responses.
        // Let already-buffered updates ahead of the terminal response finish their
        // handlers before connectWith closes the stream.
        await new Promise<void>((resolve) => setImmediate(resolve));
        return result;
      });
      if (ctx.signal?.aborted) throw new Error(`${this.provider} ACP turn cancelled`);
      if (response.stopReason === 'cancelled') {
        if (steered) {
          (await (await currentTiming())?.mark('provider.interrupted', { operation: 'followup-steering' }));
          // Cancelled to hand a mid-turn follow-up to the next turn — a clean
          // boundary, not a failure. `delivered` is unchanged, so the workflow
          // loops back to Do and delivers the follow-up (software-dev §5.6).
          return { termination: { kind: 'success', status: 'end_turn' }, session: sessionId, output: finalText(), delivered };
        }
        throw new Error(`${this.provider} ACP turn cancelled`);
      }
      if (response.stopReason === 'max_tokens' || response.stopReason === 'max_turn_requests') {
        // The model produced valid work but hit an output/turn-count boundary.
        // Treat it as an interruption that resumes the session on retry (parity
        // with the Claude SDK's max_output_tokens handling), not a hard failure
        // that escalates to a human.
        throw new Error(`turn interrupted before completion: ${this.provider} reached ${response.stopReason}`);
      }
      if (response.stopReason !== 'end_turn') {
        throw new Error(`${this.provider} ACP turn did not complete successfully (${response.stopReason})`);
      }
      return {
        termination: { kind: 'success', status: response.stopReason },
        session: sessionId,
        output: finalText(),
        delivered,
      };
    } catch (error) {
      // A dropped sandbox stream is the cause, not the closed ACP connection
      // it produced; the retry resumes the session (task 348).
      if (remoteProcess?.lost) throw remoteProcess.lost;
      const detail = stderr.trim();
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof ProviderStreamError) {
        const failure = new ProviderStreamError(`${this.provider} ACP turn failed: ${message}`);
        // A sandbox controls the bytes of that answer: it may end this turn,
        // but only a host-side check may change a shared credential (AD-7).
        throw remote ? new SandboxProviderFailure(failure) : failure;
      }
      throw new Error(`${this.provider} ACP turn failed: ${message}${detail ? `: ${detail.slice(-800)}` : ''}`, { cause: error });
    } finally {
      (await control?.close());
      remoteBridge?.close();
      ctx.signal?.removeEventListener('abort', abort);
      try { io.stdin?.end(); } catch { /* closed */ }
      for (const terminal of terminals.values()) {
        if (terminal.child.pid) await killAgent(terminal.child.pid, 2500, terminal.custodyId);
      }
      terminals.clear();
      await stopChild();
      // Keep the session where a retry, a later turn or a fork in another
      // world can continue it — whatever this turn's outcome (remote-acp.ts).
      if (remoteTurn && sessionId && !remoteProcess?.lost) {
        const failure = await exportRemoteAcpSession(runtimeWorld, this.provider, remoteTurn.home, sessionId, { cwd, env: remoteEnv! });
        if (failure) ctx.emitActivity({ id: 'acp-session-export', kind: 'status', phase: 'failed',
          title: 'Could not save the agent session for a later turn',
          ...(activityDetail(failure.message) ? { detail: activityDetail(failure.message) } : {}) });
      }
      await release();
      // Only now: stopping a sandbox agent and exporting its session can take
      // longer than the activity's heartbeat timeout.
      if (heartbeat) clearInterval(heartbeat);
    }
  }
}
