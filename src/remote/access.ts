import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const pexec = promisify(execFile);

export type RemoteMethod = 'tailscale' | 'hosted' | 'none';
export type RemoteState = 'ready' | 'available' | 'needs-login' | 'unavailable' | 'conflict' | 'error';

export interface RemoteAccessStatus {
  method: RemoteMethod;
  state: RemoteState;
  url?: string;
  helpUrl?: string;
  setupCommand?: string;
  detail: string;
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
  const result = commandError(error);
  const raw = (result.stderr || result.stdout || 'Tailscale could not enable Serve.').trim();
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

  constructor(private readonly options: {
    port: () => number;
    hosted?: boolean;
    publicUrl?: string;
    run?: Run;
  }) {
    this.run = options.run ?? (async (args) => {
      const result = await pexec('tailscale', args, { timeout: 20_000 });
      return { stdout: result.stdout, stderr: result.stderr };
    });
  }

  async status(): Promise<RemoteAccessStatus> {
    if (this.options.hosted) {
      return {
        method: 'hosted',
        state: 'ready',
        ...(this.options.publicUrl ? { url: this.options.publicUrl } : {}),
        detail: 'This hosted installation already uses authenticated HTTPS.',
        canEnable: false,
        canDisable: false,
      };
    }

    let node: Record<string, any>;
    try {
      const result = await this.run(['status', '--json']);
      node = JSON.parse(result.stdout);
    } catch (error) {
      const result = commandError(error);
      const missing = /(?:ENOENT|not found|not recognized)/i.test(`${result.stderr}\n${result.stdout}`);
      return {
        method: missing ? 'none' : 'tailscale',
        state: missing ? 'unavailable' : 'needs-login',
        detail: missing
          ? 'Install Tailscale on this computer to turn on private phone access.'
          : 'Tailscale is installed but this computer is not connected. Run “tailscale up”, then try again.',
        canEnable: false,
        canDisable: false,
      };
    }

    if (node.BackendState !== 'Running') {
      return {
        method: 'tailscale',
        state: 'needs-login',
        detail: 'Tailscale is installed but this computer is not connected. Run “tailscale up”, then try again.',
        canEnable: false,
        canDisable: false,
      };
    }
    if (node.Self?.Online === false) {
      return {
        method: 'tailscale',
        state: 'error',
        detail: 'Tailscale is running, but this computer is offline in the tailnet. Restart Tailscale on this computer, then check again.',
        setupCommand: 'sudo systemctl restart tailscaled && sudo tailscale up',
        canEnable: false,
        canDisable: false,
      };
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
      return {
        method: 'tailscale',
        state: 'ready',
        ...(url ? { url } : {}),
        detail: 'Private HTTPS access is on. Only devices allowed by your tailnet can connect.',
        canEnable: false,
        canDisable: true,
      };
    }
    if (!noServeConfig(text)) {
      return {
        method: 'tailscale',
        state: 'conflict',
        detail: 'Tailscale Serve is already routing this device to another app. Karmax left that configuration untouched.',
        canEnable: false,
        canDisable: false,
      };
    }
    return {
      method: 'tailscale',
      state: 'available',
      detail: 'Tailscale is connected and ready to provide private HTTPS access.',
      canEnable: true,
      canDisable: false,
    };
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
 * Compact startup guidance. Setup itself is available in Settings → Advanced;
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
        `Phone access: open Settings → Access, or run:\n` +
        `  tailscale serve --bg http://127.0.0.1:${port}\n` +
        `  Karmax stays on localhost and is shared privately over HTTPS.${authNote}`,
    };
  }
  return {
    method: 'none',
    guidance:
      `Phone access: install Tailscale, connect this computer and your phone to the same tailnet,\n` +
      `  then open Settings → Access. https://tailscale.com/download${authNote}`,
  };
}
