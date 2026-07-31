import { execFile } from 'node:child_process';
import os from 'node:os';
import { promisify } from 'node:util';

const pexec = promisify(execFile);

export type RemoteMethod = 'tailscale' | 'none';
export type RemoteState = 'ready' | 'available' | 'needs-login' | 'unavailable' | 'conflict' | 'error';
export type RemoteSetupStage = 'install' | 'authorize' | 'login' | 'connect' | 'serve' | 'ready';

export interface RemoteAccessStatus {
  method: RemoteMethod;
  state: RemoteState;
  setupStage?: RemoteSetupStage;
  setupInProgress?: boolean;
  url?: string;
  helpUrl?: string;
  setupCommand?: string;
  fallbackCommands?: string[];
  detail: string;
  canSetup?: boolean;
  canEnable: boolean;
  canDisable: boolean;
}

export interface RemoteAccessPlan {
  method: RemoteMethod;
  command?: string;
  guidance: string;
}

interface CommandResult {
  stdout: string;
  stderr: string;
}

type Run = (args: string[]) => Promise<CommandResult>;

function commandError(error: unknown): CommandResult {
  const value = error as { stdout?: string | Buffer; stderr?: string | Buffer; message?: string; code?: string };
  return {
    stdout: String(value.stdout ?? ''),
    stderr: String(value.stderr || value.message || value.code || ''),
  };
}

function cleanDnsName(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  return value.trim().replace(/\.$/, '');
}

function urlFromText(value: string): string | undefined {
  return value.match(/https:\/\/[a-z0-9.-]+\.ts\.net(?::\d+)?/i)?.[0];
}

function localProxyPort(value: string): number | undefined {
  const raw = value.match(/https?:\/\/(?:127\.0\.0\.1|localhost):(\d+)/i)?.[1];
  if (!raw) return undefined;
  const port = Number(raw);
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : undefined;
}

function loginUrlFromText(value: string): string | undefined {
  return value.match(/https:\/\/login\.tailscale\.com\/a\/[^\s]+/)?.[0];
}

function commandText(error: unknown): string {
  const result = commandError(error);
  return `${result.stdout}\n${result.stderr}`.trim();
}

function permissionDenied(value: string): boolean {
  return /(?:access|permission) denied|serve config denied|use ['"]?sudo|set --operator|not authorized/i.test(value);
}

function noServeConfig(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || /(?:no serve config|not configured|no configuration)/i.test(trimmed)) return true;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed == null
      || (Array.isArray(parsed) && parsed.length === 0)
      || (typeof parsed === 'object' && Object.keys(parsed).length === 0);
  } catch {
    return false;
  }
}

function serveError(error: unknown): Pick<RemoteAccessStatus, 'detail' | 'helpUrl' | 'setupCommand'> {
  const raw = commandText(error) || 'Tailscale could not enable Serve.';
  const needsPermission = /serve config denied|use ['"]?sudo tailscale serve|set --operator/i.test(raw);
  const needsApproval = /serve is not enabled/i.test(raw);
  const helpUrl = needsApproval ? raw.match(/https:\/\/login\.tailscale\.com\/f\/serve\?[^\s]+/)?.[0] : undefined;
  if (needsPermission && needsApproval) {
    return {
      detail: 'Tailscale needs two one-time setup steps: approve Serve for this tailnet and grant your Linux account permission. Complete both below, then try again.',
      ...(helpUrl ? { helpUrl } : {}),
      setupCommand: 'sudo tailscale set --operator=$USER',
    };
  }
  if (needsPermission) {
    return {
      detail: 'Tailscale needs one-time permission for your Linux account. Run this command in a terminal, then try again.',
      setupCommand: 'sudo tailscale set --operator=$USER',
    };
  }
  if (needsApproval) {
    return {
      detail: 'Tailscale Serve must be approved once for this tailnet. Continue in Tailscale, then try again.',
      ...(helpUrl ? { helpUrl } : {}),
    };
  }
  return { detail: raw };
}

/**
 * Owns the one safe local remote-access path: Tailscale Serve proxies the
 * loopback-only gateway over private HTTPS. It never opens Karmax on the LAN
 * and deliberately has no Funnel/quick-tunnel path.
 */
export class RemoteAccessController {
  private readonly run: Run;
  private readonly elevate?: Run;
  private readonly platform: NodeJS.Platform;
  private readonly username: string;
  private setupInFlight?: Promise<RemoteAccessStatus>;
  private setupOutcome?: RemoteAccessStatus;

  constructor(private readonly options: {
    port: () => number;
    run?: Run;
    elevate?: Run;
    platform?: NodeJS.Platform;
    username?: string;
  }) {
    this.platform = options.platform ?? process.platform;
    this.username = options.username ?? os.userInfo().username;
    this.run = options.run ?? (async (args) => {
      const result = await pexec('tailscale', args, { timeout: 20_000 });
      return { stdout: result.stdout, stderr: result.stderr };
    });
    this.elevate = options.elevate ?? (this.platform === 'linux' ? async (args) => {
      const result = await pexec('pkexec', ['tailscale', ...args], { timeout: 120_000 });
      return { stdout: result.stdout, stderr: result.stderr };
    } : undefined);
  }

  private local(status: RemoteAccessStatus): RemoteAccessStatus {
    // A conflicting route belongs to another local service. Suggesting the
    // normal fallback `serve` command here would invite the user to overwrite
    // that service, contradicting the controller's non-destructive behavior.
    if (status.state === 'conflict') return status;
    const target = `http://127.0.0.1:${this.options.port()}`;
    const restart = status.setupStage === 'connect' ? ['sudo systemctl restart tailscaled'] : [];
    return {
      ...status,
      fallbackCommands: [
        ...restart,
        'sudo tailscale up',
        `sudo tailscale serve --bg --yes ${target}`,
      ],
    };
  }

  private async authorizeOperator(): Promise<void> {
    if (this.platform !== 'linux') return;
    const args = ['set', `--operator=${this.username}`];
    try {
      await this.run(args);
      return;
    } catch (error) {
      if (!permissionDenied(commandText(error)) || !this.elevate) throw error;
    }
    await this.elevate(args);
  }

  async status(): Promise<RemoteAccessStatus> {
    let node: Record<string, any>;
    try {
      const result = await this.run(['status', '--json']);
      node = JSON.parse(result.stdout);
    } catch (error) {
      const result = commandError(error);
      const missing = /(?:ENOENT|not found|not recognized)/i.test(`${result.stderr}\n${result.stdout}`);
      return this.local({
        method: missing ? 'none' : 'tailscale',
        state: missing ? 'unavailable' : 'needs-login',
        setupStage: missing ? 'install' : 'login',
        detail: missing
          ? 'Install Tailscale on this computer to turn on private phone access.'
          : 'Tailscale is installed but this computer is not connected.',
        canSetup: !missing,
        canEnable: false,
        canDisable: false,
      });
    }

    if (node.BackendState !== 'Running') {
      return this.local({
        method: 'tailscale',
        state: 'needs-login',
        setupStage: 'login',
        detail: 'Tailscale is installed but this computer is not connected.',
        canSetup: true,
        canEnable: false,
        canDisable: false,
      });
    }
    if (node.Self?.Online === false) {
      return this.local({
        method: 'tailscale',
        state: 'error',
        setupStage: 'connect',
        detail: 'Tailscale is running, but this computer is offline in the tailnet. Restart Tailscale on this computer, then check again.',
        canSetup: true,
        canEnable: false,
        canDisable: false,
      });
    }

    const dnsName = cleanDnsName(node.Self?.DNSName);
    let serve: CommandResult;
    try {
      serve = await this.run(['serve', 'status', '--json']);
    } catch (error) {
      serve = commandError(error);
      // Older clients may support Serve but not JSON status.
      try {
        serve = await this.run(['serve', 'status']);
      } catch (fallbackError) {
        serve = commandError(fallbackError);
      }
    }
    const text = `${serve.stdout}\n${serve.stderr}`.trim();
    const target = `127.0.0.1:${this.options.port()}`;
    const active = text.includes(target);
    const url = urlFromText(text) ?? (dnsName ? `https://${dnsName}` : undefined);

    if (active) {
      return this.local({
        method: 'tailscale',
        state: 'ready',
        setupStage: 'ready',
        ...(url ? { url } : {}),
        detail: 'Private HTTPS access is on. Only devices allowed by your tailnet can connect.',
        canSetup: false,
        canEnable: false,
        canDisable: true,
      });
    }
    if (!noServeConfig(text)) {
      const servedPort = localProxyPort(text);
      return this.local({
        method: 'tailscale',
        state: 'conflict',
        setupStage: 'serve',
        ...(url ? { url } : {}),
        detail: servedPort
          ? `Tailscale already routes this phone address to another local service on port ${servedPort}. If that is your main Krmax, keep using the address above. To expose this Krmax instead, turn off Phone Access in the other instance first.`
          : 'Tailscale already routes this phone address to another local service. Krmax left that configuration untouched.',
        canSetup: false,
        canEnable: false,
        canDisable: false,
      });
    }
    return this.local({
      method: 'tailscale',
      state: 'available',
      setupStage: 'serve',
      detail: 'Tailscale is connected and ready to provide private HTTPS access.',
      canSetup: true,
      canEnable: true,
      canDisable: false,
    });
  }

  /**
   * Advance the guided setup by one external-consent boundary. Karmax may
   * invoke the desktop's native authorization prompt, but never reads an OS or
   * Tailscale password. Login and Serve consent remain Tailscale-owned pages.
   */
  async setup(): Promise<RemoteAccessStatus> {
    return this.startSetup();
  }

  /**
   * Start setup without tying its lifetime to an HTTP request. `tailscale up`
   * may briefly replace the route carrying that request, and native
   * authorization may take a while. The gateway acknowledges the operation
   * immediately and polls `setupStatus()` for its outcome.
   */
  startSetup(): Promise<RemoteAccessStatus> {
    if (this.setupInFlight) return this.setupInFlight;
    this.setupOutcome = undefined;
    const pending = this.advanceSetup();
    this.setupInFlight = pending;
    void pending.then(
      (outcome) => { this.setupOutcome = outcome; },
      (error) => {
        const raw = commandText(error);
        this.setupOutcome = this.local({
          method: 'tailscale',
          state: 'error',
          setupStage: 'authorize',
          detail: raw || 'Krmax could not finish Tailscale setup.',
          canSetup: true,
          canEnable: false,
          canDisable: false,
        });
      },
    ).finally(() => {
      if (this.setupInFlight === pending) this.setupInFlight = undefined;
    });
    return pending;
  }

  beginSetup(): RemoteAccessStatus {
    void this.startSetup();
    return this.setupProgress();
  }

  async setupStatus(): Promise<RemoteAccessStatus> {
    if (this.setupInFlight) return this.setupProgress();
    if (this.setupOutcome) {
      const outcome = this.setupOutcome;
      this.setupOutcome = undefined;
      return outcome;
    }
    return this.status();
  }

  private setupProgress(): RemoteAccessStatus {
    return this.local({
      method: 'tailscale',
      state: 'available',
      setupStage: 'authorize',
      setupInProgress: true,
      detail: 'Setting up Tailscale on this computer. Approve the system prompt if one appears; this page will continue automatically.',
      canSetup: false,
      canEnable: false,
      canDisable: false,
    });
  }

  private async advanceSetup(): Promise<RemoteAccessStatus> {
    let current = await this.status();
    if (current.state === 'ready' || current.state === 'unavailable' || current.state === 'conflict') {
      return current;
    }

    try {
      await this.authorizeOperator();
    } catch (error) {
      const raw = commandText(error);
      return this.local({
        method: 'tailscale',
        state: 'error',
        setupStage: 'authorize',
        detail: permissionDenied(raw)
          ? 'System authorization was not completed. Approve the prompt on this computer, or use the terminal fallback below.'
          : (raw || 'Krmax could not authorize Tailscale on this computer.'),
        canSetup: true,
        canEnable: false,
        canDisable: false,
      });
    }

    if (current.setupStage === 'login' || current.setupStage === 'connect') {
      try {
        await this.run(['up', '--timeout=4s']);
      } catch (error) {
        const raw = commandText(error);
        const helpUrl = loginUrlFromText(raw);
        current = await this.status();
        if (current.setupStage !== 'serve' && current.state !== 'ready') {
          return this.local({
            method: 'tailscale',
            state: helpUrl ? 'needs-login' : 'error',
            setupStage: 'login',
            ...(helpUrl ? { helpUrl } : {}),
            detail: helpUrl
              ? 'Finish signing in with Tailscale, then return here and continue setup.'
              : (raw || 'Tailscale could not connect this computer.'),
            canSetup: true,
            canEnable: false,
            canDisable: false,
          });
        }
      }
      current = await this.status();
      if (current.state === 'ready' || current.state === 'conflict') return current;
      if (current.setupStage !== 'serve') return current;
    }

    const target = `http://127.0.0.1:${this.options.port()}`;
    try {
      await this.run(['serve', '--bg', '--yes', target]);
    } catch (error) {
      const raw = commandText(error);
      const problem = serveError(error);
      return this.local({
        method: 'tailscale',
        state: 'error',
        setupStage: 'serve',
        ...problem,
        detail: problem.helpUrl
          ? 'Approve private HTTPS access in Tailscale, then return here and continue setup.'
          : problem.detail,
        canSetup: true,
        canEnable: true,
        canDisable: false,
        ...(loginUrlFromText(raw) ? { helpUrl: loginUrlFromText(raw) } : {}),
      });
    }
    return this.status();
  }

  async enable(): Promise<RemoteAccessStatus> {
    const before = await this.status();
    if (before.state === 'ready') return before;
    if (!before.canEnable) return before;
    const target = `http://127.0.0.1:${this.options.port()}`;
    try {
      await this.run(['serve', '--bg', target]);
    } catch (error) {
      return {
        method: 'tailscale',
        state: 'error',
        ...serveError(error),
        canEnable: true,
        canDisable: false,
      };
    }
    return this.status();
  }

  async disable(): Promise<RemoteAccessStatus> {
    const before = await this.status();
    if (!before.canDisable) return before;
    try {
      await this.run(['serve', 'off']);
    } catch (error) {
      const result = commandError(error);
      return {
        method: 'tailscale',
        state: 'error',
        detail: (result.stderr || result.stdout || 'Tailscale could not disable Serve.').trim(),
        canEnable: false,
        canDisable: true,
      };
    }
    return this.status();
  }
}

/**
 * Compact startup guidance. Setup itself is available in Settings → Phone Access;
 * this remains useful before the first browser session.
 */
export async function remoteAccessPlan(port: number, opts: {
  hasPassword: boolean;
  detect?: (bin: string) => Promise<boolean>;
} = { hasPassword: false }): Promise<RemoteAccessPlan> {
  const detect = opts.detect ?? (async () => {
    try {
      await pexec('tailscale', ['version'], { timeout: 3_000 });
      return true;
    } catch {
      return false;
    }
  });
  const authNote = opts.hasPassword ? '' : '\n  Set KARMAX_PASSWORD before sharing an older password-only installation.';
  if (await detect('tailscale')) {
    return {
      method: 'tailscale',
      command: `tailscale serve --bg http://127.0.0.1:${port}`,
      guidance:
        `Phone access: open Settings → Phone Access, or run:\n` +
        `  tailscale serve --bg http://127.0.0.1:${port}\n` +
        `  Krmax stays on localhost and is shared privately over HTTPS.${authNote}`,
    };
  }
  return {
    method: 'none',
    guidance:
      `Phone access: install Tailscale, connect this computer and your phone to the same tailnet,\n` +
      `  then open Settings → Phone Access. https://tailscale.com/download${authNote}`,
  };
}
