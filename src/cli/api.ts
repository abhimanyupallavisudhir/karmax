import process from 'node:process';
import { Credentials, DEFAULT_SERVER, normalizeServer, type StoredCredential } from './config.js';
import { CliError, EXIT } from './util.js';

export const CLI_CLIENT_ID = 'tavya-cli';

export class HttpError extends CliError {
  constructor(readonly status: number, message: string, readonly body: Record<string, unknown> = {}) {
    super(message, status === 401 ? EXIT.auth : status === 409 ? EXIT.conflict : status === 404 ? EXIT.notFound : EXIT.failed);
  }
}

/** Which server, and the token for it: flags, then the environment (inside a
 * task world `KARMAX_GATEWAY_URL` and `KARMAX_TOKEN` are already set), then
 * the stored sign-in. */
export function resolveServer(flag?: string, credentials = new Credentials()): string {
  const value = flag ?? process.env.TAVYA_URL ?? process.env.KARMAX_GATEWAY_URL ?? credentials.defaultServer() ?? DEFAULT_SERVER;
  return normalizeServer(value);
}

export class Api {
  private credential: StoredCredential | undefined;
  private readonly fromEnvironment: boolean;

  constructor(readonly server: string, private credentials = new Credentials(), token = process.env.TAVYA_TOKEN ?? process.env.KARMAX_TOKEN) {
    this.fromEnvironment = Boolean(token);
    this.credential = token ? { accessToken: token } : credentials.get(server);
  }

  get signedIn(): boolean { return Boolean(this.credential); }

  /** The bearer for a request, refreshed first when it is about to expire. */
  async token(): Promise<string> {
    if (!this.credential) throw new CliError(`not signed in to ${this.server}; run \`tavya login\``, EXIT.auth);
    if (this.credential.refreshToken && this.credential.expiresAt && this.credential.expiresAt - Date.now() < 60_000) await this.refresh();
    return this.credential.accessToken;
  }

  private async refresh(): Promise<void> {
    const refreshToken = this.credential?.refreshToken;
    if (!refreshToken) throw new CliError(`your sign-in to ${this.server} expired; run \`tavya login\``, EXIT.auth);
    const response = await fetch(new URL('/oauth/token', this.server), { method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: this.credential?.clientId ?? CLI_CLIENT_ID }) });
    const body = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok || typeof body.access_token !== 'string') {
      if (!this.fromEnvironment) this.credentials.remove(this.server);
      throw new CliError(`your sign-in to ${this.server} expired; run \`tavya login\``, EXIT.auth);
    }
    this.credential = tokenCredential(body, this.credential?.clientId ?? CLI_CLIENT_ID);
    if (!this.fromEnvironment) this.credentials.save(this.server, this.credential);
  }

  async request<T = any>(method: string, path: string, body?: unknown, options: { raw?: boolean; retried?: boolean } = {}): Promise<T> {
    const response = await this.fetch(method, path, body);
    if (response.status === 401 && !options.retried && this.credential?.refreshToken) {
      await this.refresh();
      return this.request(method, path, body, { ...options, retried: true });
    }
    if (options.raw) {
      if (!response.ok) throw await httpError(response);
      return response as T;
    }
    const text = await response.text();
    let parsed: unknown = undefined;
    try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = text; }
    if (!response.ok) throw errorFrom(response.status, parsed);
    return parsed as T;
  }

  async fetch(method: string, path: string, body?: unknown): Promise<Response> {
    const headers: Record<string, string> = { authorization: `Bearer ${await this.token()}`, accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    try {
      return await fetch(new URL(path, this.server), { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    } catch (error) {
      throw new CliError(`cannot reach ${this.server}: ${(error as Error & { cause?: Error }).cause?.message ?? (error as Error).message}`);
    }
  }

  get<T = any>(path: string): Promise<T> { return this.request<T>('GET', path); }
  post<T = any>(path: string, body: unknown = {}): Promise<T> { return this.request<T>('POST', path, body); }
}

export function tokenCredential(body: Record<string, unknown>, clientId: string): StoredCredential {
  return { accessToken: String(body.access_token),
    ...(typeof body.refresh_token === 'string' ? { refreshToken: body.refresh_token } : {}),
    ...(typeof body.expires_in === 'number' ? { expiresAt: Date.now() + body.expires_in * 1000 } : {}), clientId };
}

async function httpError(response: Response): Promise<HttpError> {
  const text = await response.text().catch(() => '');
  let parsed: unknown = text;
  try { parsed = JSON.parse(text); } catch { /* plain text */ }
  return errorFrom(response.status, parsed);
}

function errorFrom(status: number, body: unknown): HttpError {
  const record = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  const message = typeof record.error === 'string' ? record.error : typeof body === 'string' && body ? body.slice(0, 300) : `HTTP ${status}`;
  return new HttpError(status, status === 401 ? `${message}; run \`tavya login\`` : message, record);
}
