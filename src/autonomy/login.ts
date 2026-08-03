import { spawn, ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ConfigHomeManager, scrubbedEnv, isLoggedIn, isFullyAuthed, KARMAX_TOKEN_FILE } from './config-homes.js';
import { Provider } from '../domain/types.js';
import { trackProcess } from '../util/processes.js';
import { localProviderCli } from '../agent/provider-cli.js';

/**
 * Provider account login (SPEC §7.6, §7.3). Mints an isolated config home per
 * (provider × account) and launches the provider's OWN login flow with that
 * home's env (`CLAUDE_CONFIG_DIR` / `CODEX_HOME`), capturing the device/OAuth URL
 * for the user to complete. karmax never types the user's credentials — the user
 * finishes OAuth in a browser; the provider writes the token into the home.
 *
 * This gives multiple, switchable logins per provider (each its own home), which
 * the account coordinator (§6.2) then leases to dodge token limits.
 */
export interface LoginResult {
  provider: Provider;
  account: string;
  configHome: string;
  loginUrl?: string;
  verificationCode?: string;
  /** The provider shows a code after OAuth that must be returned to its CLI. */
  requiresCode?: boolean;
  status: 'awaiting_oauth' | 'logged_in' | 'failed';
  detail?: string;
}

export interface LoginOptions {
  urlTimeoutMs?: number;
  /** OpenCode model-provider id, e.g. `openai` or `xai`. */
  modelProvider?: string;
  /** Exact OpenCode auth-method label, passed through its documented CLI flag. */
  authMethod?: string;
}

/** Injectable so tests don't depend on the real CLIs / OAuth. */
export type LoginCommand = (
  provider: Provider,
  configHome: string,
  opts: LoginOptions,
) => { cmd: string; args: string[]; env: Record<string, string> } | undefined;

export const defaultLoginCommand: LoginCommand = (provider, home, opts) => {
  const env = scrubbedEnv({ provider, configHome: home });
  if (provider === 'claude') {
    // Full OAuth login (writes a native `.credentials.json`) — pollable for usage (#6)
    // and read directly by the Agent SDK. `setup-token` remains available via override
    // (its token can't read usage). --claudeai = subscription (vs --console = metered).
    return { cmd: process.env.KARMAX_CLAUDE_LOGIN_CMD ?? localProviderCli('claude'), args: (process.env.KARMAX_CLAUDE_LOGIN_ARGS ?? 'auth login --claudeai').split(' ').filter(Boolean), env };
  }
  if (provider === 'codex') {
    // A hosted server's localhost OAuth callback points at the user's laptop,
    // not the Krmax container. Device auth is the provider's supported headless
    // flow and yields a URL + code that can safely cross the gateway.
    const defaultArgs = process.env.KARMAX_DEPLOYMENT === 'hosted' ? 'login --device-auth' : 'login';
    return { cmd: process.env.KARMAX_CODEX_LOGIN_CMD ?? localProviderCli('codex'), args: (process.env.KARMAX_CODEX_LOGIN_ARGS ?? defaultArgs).split(' ').filter(Boolean), env };
  }
  if (provider === 'opencode') {
    // OpenCode's auth command is otherwise interactive. Its official
    // --provider/--method flags make the OAuth choice deterministic and leave
    // only the browser/device-code step to the human.
    if (!opts.modelProvider || !opts.authMethod) return undefined;
    return {
      cmd: process.env.KARMAX_OPENCODE_LOGIN_CMD ?? 'opencode',
      args: ['auth', 'login', '--provider', opts.modelProvider, '--method', opts.authMethod],
      env,
    };
  }
  return undefined;
};

export class LoginManager {
  private pending = new Map<string, { child: ChildProcess; prompt?: ReturnType<typeof parseLoginPrompt> }>();

  constructor(
    private homes: ConfigHomeManager,
    private loginCommand: LoginCommand = defaultLoginCommand,
  ) {}

  /** Start (or report) a login for an account. Returns the device URL to open. */
  async connect(provider: Provider, account: string, opts: LoginOptions = {}, organizationId = 'org_personal'): Promise<LoginResult> {
    const configHome = this.homes.ensure(provider, account, organizationId);
    if (provider === 'opencode' && opts.modelProvider) {
      this.homes.setModelProvider(configHome, opts.modelProvider);
    }
    // Skip only if fully authed with a native credential. A setup-token-only home
    // re-runs login here to UPGRADE to a full, usage-pollable credential (#6).
    if (isFullyAuthed(provider, configHome)) return { provider, account, configHome, status: 'logged_in' };
    const pendingKey = this.pendingKey(provider, account, organizationId);
    const existing = this.pending.get(pendingKey);
    if (existing && existing.child.exitCode === null && existing.prompt?.loginUrl) {
      return { provider, account, configHome, ...existing.prompt, status: 'awaiting_oauth' };
    }
    const spec = this.loginCommand(provider, configHome, opts);
    if (!spec) {
      const detail = provider === 'opencode'
        ? 'OpenCode login requires a model provider and auth method'
        : `no login command for ${provider}`;
      return { provider, account, configHome, status: 'failed', detail };
    }

    let child: ChildProcess;
    try {
      child = spawn(spec.cmd, spec.args, { env: spec.env, stdio: ['pipe', 'pipe', 'pipe'], detached: false });
    } catch (e) {
      return { provider, account, configHome, status: 'failed', detail: `could not launch ${spec.cmd}: ${String((e as Error).message ?? e)}` };
    }
    const pending: { child: ChildProcess; prompt?: ReturnType<typeof parseLoginPrompt> } = { child };
    this.pending.set(pendingKey, pending);
    const forget = () => {
      if (this.pending.get(pendingKey)?.child === child) this.pending.delete(pendingKey);
    };
    child.once('exit', forget);
    child.once('error', forget);
    // Keep reading the child after the URL: `claude auth login` / `codex login`
    // write the native credential (`.credentials.json` / `auth.json`) directly, so
    // the account reads as signed-in. If someone overrides back to `setup-token`
    // (which PRINTS a token instead), persist that too so the SDK can use it.
    if (child.pid) {
      // Task-manager registry (dashboard Processes panel): the login CLI runs
      // unsupervised until the user finishes OAuth — visible there, killable if stuck.
      child.once('exit', trackProcess({ pid: child.pid, kind: 'login', label: `${provider} login (${account})`, startedAt: Date.now() }));
    }
    persistTokenWhenPrinted(child, configHome);
    const prompt = await captureLoginPrompt(child, opts.urlTimeoutMs ?? 8000);
    pending.prompt = parseLoginPrompt(prompt.output);
    child.unref(); // let it keep running while the user completes OAuth
    if (prompt.error) {
      return {
        provider,
        account,
        configHome,
        status: 'failed',
        detail: `could not launch ${spec.cmd}: ${prompt.error.message}`,
      };
    }
    if (pending.prompt.loginUrl) {
      return {
        provider,
        account,
        configHome,
        ...pending.prompt,
        status: 'awaiting_oauth',
      };
    }
    if (isFullyAuthed(provider, configHome)) return { provider, account, configHome, status: 'logged_in' };
    return { provider, account, configHome, status: 'failed', detail: 'no login URL captured (is the CLI installed?)' };
  }

  /** Return the post-OAuth code to a provider CLI waiting on stdin (Claude). */
  async submitAuthorizationCode(
    provider: Provider,
    account: string,
    code: string,
    organizationId = 'org_personal',
  ): Promise<LoginResult> {
    const configHome = this.homes.ensure(provider, account, organizationId);
    const value = code.trim();
    if (!value || value.length > 4096 || /[\r\n\0]/.test(value))
      return { provider, account, configHome, status: 'failed', detail: 'invalid authorization code' };
    const pending = this.pending.get(this.pendingKey(provider, account, organizationId));
    if (!pending?.child.stdin?.writable)
      return { provider, account, configHome, status: 'failed', detail: 'no login is waiting for an authorization code; start it again' };
    pending.child.stdin.end(`${value}\n`);

    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && pending.child.exitCode == null && !isFullyAuthed(provider, configHome)) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (isFullyAuthed(provider, configHome)) return { provider, account, configHome, status: 'logged_in' };
    if (pending.child.exitCode != null)
      return { provider, account, configHome, status: 'failed', detail: 'the provider rejected the authorization code' };
    return { provider, account, configHome, status: 'awaiting_oauth', detail: 'authorization code submitted; waiting for the provider' };
  }

  status(provider: Provider, account: string, organizationId = 'org_personal'): { provider: Provider; account: string; configHome: string; loggedIn: boolean } {
    const configHome = this.homes.ensure(provider, account, organizationId);
    return { provider, account, configHome, loggedIn: isLoggedIn(provider, configHome) };
  }

  private pendingKey(provider: Provider, account: string, organizationId: string): string {
    return JSON.stringify([organizationId, provider, account]);
  }
}

/** A provider-issued long-lived token (e.g. Claude setup-token output). */
const TOKEN_RE = /\b(sk-ant-[A-Za-z0-9_-]{20,}|[A-Za-z0-9_-]{40,}\.[A-Za-z0-9_-]{20,})\b/;

/** Watch the login process output for a printed token and persist it to the home. */
function persistTokenWhenPrinted(child: ChildProcess, home: string): void {
  let buf = '';
  let written = false;
  const onData = (b: Buffer) => {
    if (written) return;
    buf += b.toString();
    const m = buf.match(TOKEN_RE);
    if (m) {
      written = true;
      try {
        // Owner-only: this file holds a plaintext provider credential. The
        // chmod also covers rotation, where the file already exists.
        const file = path.join(home, KARMAX_TOKEN_FILE);
        fs.writeFileSync(file, JSON.stringify({ token: m[1] }), { mode: 0o600 });
        fs.chmodSync(file, 0o600);
      } catch {
        /* home vanished — ignore */
      }
    }
  };
  child.stdout?.on('data', onData);
  child.stderr?.on('data', onData);
}

/** Read child output until its browser URL and optional device code appear. */
function captureLoginPrompt(
  child: ChildProcess,
  timeoutMs: number,
): Promise<{ output: string; error?: Error }> {
  return new Promise((resolve) => {
    let buf = '';
    let done = false;
    let spawnError: Error | undefined;
    let settleTimer: NodeJS.Timeout | undefined;
    const result = () => {
      return {
        output: buf,
        ...(spawnError ? { error: spawnError } : {}),
      };
    };
    const finish = () => {
      if (done) return;
      done = true;
      if (settleTimer) clearTimeout(settleTimer);
      resolve(result());
    };
    const onData = (b: Buffer) => {
      buf += b.toString();
      if (parseLoginPrompt(buf).loginUrl && !settleTimer) {
        // A device code may be printed immediately after the URL in another
        // chunk. Briefly settle so the browser receives both.
        settleTimer = setTimeout(finish, 150);
        settleTimer.unref();
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.once('error', (error) => {
      spawnError = error;
      finish();
    });
    child.once('exit', () => setTimeout(finish, 50));
    setTimeout(finish, timeoutMs).unref();
  });
}

/** Parse ANSI-decorated provider prompts without coupling the UI to CLI output. */
export function parseLoginPrompt(output: string): Pick<LoginResult, 'loginUrl' | 'verificationCode' | 'requiresCode'> {
  const text = output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
  const loginUrl = text.match(/https?:\/\/[^\s'"]+/)?.[0];
  const directCode = text.match(/(?:enter|user(?:_| )?)\s*code\s*[:=]\s*([A-Z0-9][A-Z0-9-]{3,})/i)?.[1];
  const deviceCode = text.match(/(?:one-time|verification|device)\s+code[\s\S]{0,160}?\b([A-Z0-9]{4,}(?:-[A-Z0-9]{3,})+)\b/i)?.[1];
  const verificationCode = directCode ?? deviceCode;
  return {
    ...(loginUrl ? { loginUrl } : {}),
    ...(verificationCode ? { verificationCode } : {}),
    ...(/paste (?:the )?(?:authorization )?code|paste code here/i.test(text) ? { requiresCode: true } : {}),
  };
}
