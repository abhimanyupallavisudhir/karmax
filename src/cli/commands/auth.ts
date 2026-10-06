import { spawn } from 'node:child_process';
import os from 'node:os';
import process from 'node:process';
import { Api, CLI_CLIENT_ID, HttpError, tokenCredential } from '../api.js';
import { Credentials } from '../config.js';
import { CliError, EXIT, interactive, table, type Output } from '../util.js';

interface DeviceCode { device_code: string; user_code: string; verification_uri: string; verification_uri_complete?: string;
  expires_in: number; interval?: number }

/** Sign in with the device flow (RFC 8628): works over SSH and without a browser here. */
export async function login(server: string, out: Output, options: { name?: string; browser: boolean }) {
  const credentials = new Credentials();
  const name = options.name ?? `tavya CLI on ${os.hostname()}`;
  const form = (fields: Record<string, string>) => ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(fields) });
  let response: Response;
  try { response = await fetch(new URL('/oauth/device', server), form({ client_id: CLI_CLIENT_ID, name })); }
  catch (error) { throw new CliError(`cannot reach ${server}: ${(error as Error & { cause?: Error }).cause?.message ?? (error as Error).message}`); }
  if (!response.ok) throw new CliError(`${server} does not offer CLI sign-in (HTTP ${response.status}); is it a tavya server?`);
  const device = await response.json() as DeviceCode;
  const link = device.verification_uri_complete ?? device.verification_uri;
  process.stderr.write(`\nOpen ${link}\nand confirm the code ${device.user_code}\n\n`);
  if (options.browser && interactive()) openBrowser(link);
  let interval = Math.max(1, device.interval ?? 5) * 1000;
  const deadline = Date.now() + device.expires_in * 1000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, interval));
    const polled = await fetch(new URL('/oauth/token', server), form({ grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: device.device_code, client_id: CLI_CLIENT_ID }));
    const body = await polled.json().catch(() => ({})) as Record<string, unknown>;
    if (polled.ok && typeof body.access_token === 'string') {
      const credential = tokenCredential(body, CLI_CLIENT_ID);
      credentials.save(server, credential);
      const api = new Api(server, credentials, undefined);
      const user = await me(api).catch(() => undefined);
      credentials.save(server, credential, user);
      credentials.setDefault(server);
      return out.result({ server, user }, `Signed in to ${server}${user?.name ? ` as ${user.name}` : ''}.`);
    }
    if (body.error === 'authorization_pending') continue;
    if (body.error === 'slow_down') { interval += 5000; continue; }
    if (body.error === 'access_denied') throw new CliError('sign-in was denied', EXIT.auth);
    if (body.error === 'expired_token') break;
    throw new CliError(`sign-in failed: ${String(body.error_description ?? body.error ?? `HTTP ${polled.status}`)}`, EXIT.auth);
  }
  throw new CliError('the code expired before it was confirmed; run `tavya login` again', EXIT.auth);
}

export async function logout(server: string, out: Output) {
  const credentials = new Credentials();
  const credential = credentials.get(server);
  if (!credential) return out.result({ server, signedIn: false }, `Not signed in to ${server}.`);
  for (const token of [credential.refreshToken, credential.accessToken].filter(Boolean) as string[])
    await fetch(new URL('/oauth/revoke', server), { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token, client_id: credential.clientId ?? CLI_CLIENT_ID }) }).catch(() => undefined);
  credentials.remove(server);
  out.result({ server, signedIn: false }, `Signed out of ${server}.`);
}

export interface Me { id?: string; name?: string; email?: string }

export async function me(api: Api): Promise<Me | undefined> {
  try { const value = await api.get<Record<string, any>>('/api/user/me'); return { id: value.id, name: value.name, email: value.email }; }
  catch (error) {
    if (!(error instanceof HttpError) || error.status !== 404) throw error;
    const session = await api.get<Record<string, any>>('/api/session');
    return session.user && typeof session.user === 'object' ? { id: session.user.id, name: session.user.name, email: session.user.email } : undefined;
  }
}

export async function whoami(api: Api, out: Output) {
  const user = await me(api);
  out.result({ server: api.server, user }, `${user?.name ?? user?.email ?? user?.id ?? 'an agent or token'} on ${api.server}`);
}

export async function token(api: Api, args: string[], out: Output, flags: { name?: string; level?: string; project?: string[];
  organization?: string; expires?: string }) {
  const [action = 'list', id] = args;
  if (action === 'create') {
    const days = Number(flags.expires ?? 30);
    if (!Number.isInteger(days) || days < 1) throw new CliError('--expires is a number of days', EXIT.usage);
    const created = await api.post<{ id: string; token: string; expiresAt: number }>('/api/user/tokens', {
      name: flags.name ?? `token ${new Date().toISOString().slice(0, 10)}`, ...(flags.level ? { level: flags.level } : {}),
      ...(flags.project?.length ? { projectIds: flags.project } : {}), ...(flags.organization ? { organizationId: flags.organization } : {}),
      expiresInDays: days });
    return out.result(created, created.token);
  }
  if (action === 'list' || action === 'ls') {
    const grants = await api.get<Array<{ id: string; name: string; kind: string; createdAt: number; lastUsedAt?: number; expiresAt?: number }>>('/api/user/app-grants');
    const date = (value?: number) => value ? new Date(value).toISOString().slice(0, 10) : '—';
    return out.result(grants, table([['ID', 'NAME', 'KIND', 'CREATED', 'LAST USED', 'EXPIRES'],
      ...grants.map((grant) => [grant.id, grant.name, grant.kind, date(grant.createdAt), date(grant.lastUsedAt), date(grant.expiresAt)])]));
  }
  if (action === 'revoke' || action === 'rm') {
    if (!id) throw new CliError('usage: tavya token revoke <id>', EXIT.usage);
    await api.request('DELETE', `/api/user/app-grants/${encodeURIComponent(id)}`);
    return out.result({ revoked: id }, `Revoked ${id}.`);
  }
  throw new CliError(`unknown token command "${action}" (create, list, revoke)`, EXIT.usage);
}

function openBrowser(url: string): void {
  const [command, args] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  try { spawn(command as string, args as string[], { stdio: 'ignore', detached: true }).on('error', () => undefined).unref(); } catch { /* print only */ }
}
