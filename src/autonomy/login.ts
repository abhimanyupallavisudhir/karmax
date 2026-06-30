import { spawn, ChildProcess } from 'node:child_process';
import { ConfigHomeManager, scrubbedEnv, isLoggedIn } from './config-homes.js';
import { Provider } from '../domain/types.js';

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
  status: 'awaiting_oauth' | 'logged_in' | 'failed';
  detail?: string;
}

/** Injectable so tests don't depend on the real CLIs / OAuth. */
export type LoginCommand = (provider: Provider, configHome: string) => { cmd: string; args: string[]; env: Record<string, string> } | undefined;

const DEFAULT_LOGIN: LoginCommand = (provider, home) => {
  const env = scrubbedEnv({ provider, configHome: home });
  if (provider === 'claude') {
    return { cmd: process.env.KARMAX_CLAUDE_LOGIN_CMD ?? 'claude', args: (process.env.KARMAX_CLAUDE_LOGIN_ARGS ?? 'setup-token').split(' ').filter(Boolean), env };
  }
  if (provider === 'codex') {
    return { cmd: process.env.KARMAX_CODEX_LOGIN_CMD ?? 'codex', args: (process.env.KARMAX_CODEX_LOGIN_ARGS ?? 'login').split(' ').filter(Boolean), env };
  }
  return undefined;
};

export class LoginManager {
  constructor(
    private homes: ConfigHomeManager,
    private loginCommand: LoginCommand = DEFAULT_LOGIN,
  ) {}

  /** Start (or report) a login for an account. Returns the device URL to open. */
  async connect(provider: Provider, account: string, opts: { urlTimeoutMs?: number } = {}): Promise<LoginResult> {
    const configHome = this.homes.ensure(provider, account);
    if (isLoggedIn(provider, configHome)) return { provider, account, configHome, status: 'logged_in' };
    const spec = this.loginCommand(provider, configHome);
    if (!spec) return { provider, account, configHome, status: 'failed', detail: `no login command for ${provider}` };

    let child: ChildProcess;
    try {
      child = spawn(spec.cmd, spec.args, { env: spec.env, stdio: ['ignore', 'pipe', 'pipe'], detached: false });
    } catch (e) {
      return { provider, account, configHome, status: 'failed', detail: `could not launch ${spec.cmd}: ${String((e as Error).message ?? e)}` };
    }
    const url = await captureUrl(child, opts.urlTimeoutMs ?? 8000);
    child.unref(); // let it keep running while the user completes OAuth
    if (url) return { provider, account, configHome, loginUrl: url, status: 'awaiting_oauth' };
    if (isLoggedIn(provider, configHome)) return { provider, account, configHome, status: 'logged_in' };
    return { provider, account, configHome, status: 'failed', detail: 'no login URL captured (is the CLI installed?)' };
  }

  status(provider: Provider, account: string): { provider: Provider; account: string; configHome: string; loggedIn: boolean } {
    const configHome = this.homes.ensure(provider, account);
    return { provider, account, configHome, loggedIn: isLoggedIn(provider, configHome) };
  }
}

/** Read child stdout/stderr until a URL appears or the timeout elapses. */
function captureUrl(child: ChildProcess, timeoutMs: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    let buf = '';
    let done = false;
    const finish = (u?: string) => {
      if (done) return;
      done = true;
      resolve(u);
    };
    const onData = (b: Buffer) => {
      buf += b.toString();
      const m = buf.match(/https?:\/\/[^\s'"]+/);
      if (m) finish(m[0]);
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.once('error', () => finish(undefined));
    child.once('exit', () => setTimeout(() => finish(undefined), 50));
    setTimeout(() => finish(undefined), timeoutMs).unref();
  });
}
