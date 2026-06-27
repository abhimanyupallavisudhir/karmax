import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const pexec = promisify(execFile);

/**
 * Remote access (SPEC §12). karmax serves on localhost; a mesh or tunnel makes
 * it reachable. This is purely an access layer, orthogonal to the core. We
 * detect the available tool and print guidance — never auto-expose, and always
 * behind karmax's own auth (defense in depth; §12 non-negotiable).
 */
export type RemoteMethod = 'tailscale' | 'cloudflare' | 'ngrok' | 'none';

async function has(bin: string): Promise<boolean> {
  try {
    await pexec('bash', ['-lc', `command -v ${bin}`]);
    return true;
  } catch {
    return false;
  }
}

export interface RemoteAccessPlan {
  method: RemoteMethod;
  command?: string;
  guidance: string;
}

export async function remoteAccessPlan(port: number, opts: { hasPassword: boolean; detect?: (bin: string) => Promise<boolean> } = { hasPassword: false }): Promise<RemoteAccessPlan> {
  const detect = opts.detect ?? has;
  const authNote = opts.hasPassword
    ? ''
    : '\n  ⚠ Set KARMAX_PASSWORD before exposing karmax — it can move money and drive agents (§12).';

  if (await detect('tailscale')) {
    return {
      method: 'tailscale',
      command: `tailscale serve --bg ${port}`,
      guidance:
        `Private access (just you): your phone joins the tailnet and reaches this laptop directly.\n` +
        `  Run:  tailscale serve --bg ${port}\n` +
        `  Then open the printed https://*.ts.net URL. Nothing is exposed publicly.${authNote}`,
    };
  }
  if (await detect('cloudflared')) {
    return {
      method: 'cloudflare',
      command: `cloudflared tunnel --url http://127.0.0.1:${port}`,
      guidance:
        `Public URL with auth (business / multiple people): outbound-only tunnel, no open ports.\n` +
        `  Run:  cloudflared tunnel --url http://127.0.0.1:${port}\n` +
        `  Put Cloudflare Access (SSO/OTP) + WAF in front. Never a naked public tunnel.${authNote}`,
    };
  }
  if (await detect('ngrok')) {
    return { method: 'ngrok', command: `ngrok http ${port}`, guidance: `Quick one-off demo only:  ngrok http ${port}${authNote}` };
  }
  return {
    method: 'none',
    guidance:
      `No tunnel tool found. Install Tailscale (recommended, private) or Cloudflare Tunnel + Access (public, behind SSO).\n` +
      `  https://tailscale.com  •  https://developers.cloudflare.com/cloudflare-one/${authNote}`,
  };
}
