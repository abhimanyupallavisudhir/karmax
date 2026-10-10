import crypto from 'node:crypto';
import { auth, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { publicFetch, publicUrl } from './http.js';
import type { McpConnection } from './store.js';
import type { RefreshLeases } from '../../autonomy/refresh-lease.js';

/** Credential storage for an OAuth-authorized remote MCP server: project/organization
 * Tools connections and personal app connections share the same OAuth flow. */
export interface OAuthVault {
  secret(c: OAuthTarget, taskId?: string): Promise<any>;
  setSecret(c: OAuthTarget, value: unknown): Promise<void>;
  /** Refresh under the credential's cross-process lease (`refresh-lease.ts`):
   * `run` refreshes the stored data in place; it is written back only if the
   * stored data is still `observed`, and a refresh another process completed
   * meanwhile is returned instead of refreshing again. */
  refresh?(c: OAuthTarget, taskId: string | undefined, observed: any, run: (data: any) => Promise<any>): Promise<any>;
}

/** A leased OAuth refresh of the JSON stored under `handle`, for an `OAuthVault`. */
export async function leasedOAuthRefresh(leases: RefreshLeases, handle: string, observed: any,
  read: () => Promise<string | undefined>, write: (current: string | undefined, next: string, held: () => Promise<boolean>) => Promise<boolean>,
  run: (data: any) => Promise<any>): Promise<any> {
  const { stored } = await leases.refresh({
    credential: handle,
    since: { value: JSON.stringify(observed) },
    read,
    refresh: async (current) => current === undefined ? {} : { next: JSON.stringify(await run(JSON.parse(current))) },
    write,
  });
  return stored === undefined ? {} : JSON.parse(stored);
}
export type OAuthTarget = Pick<McpConnection, 'id' | 'organizationId' | 'label' | 'auth' | 'transport' | 'revision'>;

export const MCP_CLIENT_METADATA_PATH = '/api/mcp-client-metadata';
export function mcpClientMetadata(publicOrigin = process.env.KARMAX_PUBLIC_URL) {
  if (!publicOrigin) return undefined;
  try {
    const origin = publicUrl(publicOrigin).origin;
    return { client_id: new URL(MCP_CLIENT_METADATA_PATH, origin).href,
      client_name: 'Tavya', redirect_uris: [new URL('/mcp-callback', origin).href],
      grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' as const };
  } catch { return undefined; }
}

async function authorize(...args: Parameters<typeof auth>) {
  try { return await auth(...args); }
  catch (error) {
    // Without registration or client metadata documents, the server accepts only clients registered with it in advance.
    if (error instanceof Error && error.message.includes('does not support dynamic client registration'))
      throw new Error('This MCP server needs an OAuth app registered with it. Add it in Tools settings with that app’s client details.');
    throw new Error('MCP authorization failed. Retry sign-in, or check the server’s required OAuth client details and installation callback URL.');
  }
}

const locks = new Map<string, Promise<unknown>>();
const waiters = new Map<string, number>();
async function exclusive<T>(key: string, run: () => Promise<T>): Promise<T> {
  if ((!locks.has(key) && locks.size >= 24) || (waiters.get(key) ?? 0) >= 8) throw new Error('Connection service is busy. Retry shortly.');
  waiters.set(key, (waiters.get(key) ?? 0) + 1);
  const old = locks.get(key) ?? Promise.resolve();
  const next = old.catch(() => {}).then(run); locks.set(key, next);
  try { return await next; } finally { const count = (waiters.get(key) ?? 1) - 1; if (count) waiters.set(key, count); else waiters.delete(key); if (locks.get(key) === next) locks.delete(key); }
}
function provider(service: OAuthVault, connection: OAuthTarget, data: any, redirect: string,
  onRedirect: (url: string) => void): OAuthClientProvider {
  return {
    redirectUrl: redirect,
    clientMetadataUrl: data.clientMetadataUrl,
    clientMetadata: { client_name: 'Tavya', redirect_uris: [redirect], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: data.manualClient?.token_endpoint_auth_method ?? 'none' },
    state: () => data.pending.state,
    clientInformation: () => data.manualClient ?? data.client,
    saveClientInformation: async (client) => { data.client = client; (await service.setSecret(connection, data)); },
    tokens: () => data.tokens,
    saveTokens: async (tokens) => { data.tokens = { ...tokens, refresh_token: tokens.refresh_token ?? data.tokens?.refresh_token }; data.expiresAt = Date.now() + (tokens.expires_in ?? 3600) * 1000; (await service.setSecret(connection, data)); },
    redirectToAuthorization: (url) => { onRedirect(publicUrl(url.href).href); },
    saveCodeVerifier: async (verifier) => { data.pending.verifier = verifier; (await service.setSecret(connection, data)); },
    codeVerifier: () => data.pending?.verifier ?? '',
    discoveryState: () => data.discovery,
    saveDiscoveryState: async (state) => { data.discovery = state; (await service.setSecret(connection, data)); },
  };
}
export async function beginOAuth(service: OAuthVault, c: OAuthTarget, actor: string, redirect: string) {
  if (c.auth !== 'oauth' || c.transport.type === 'stdio') throw new Error('This connection does not use OAuth');
  return exclusive(`${c.organizationId}:${c.id}`, async () => {
    const data = await service.secret(c);
    // Dynamic registration is tied to its redirect URI. Do not reuse it after
    // the installation's public origin changes.
    if (data.redirect && data.redirect !== redirect) { delete data.client; delete data.discovery; }
    const metadata = mcpClientMetadata();
    data.clientMetadataUrl = metadata?.redirect_uris.includes(redirect) ? metadata.client_id : undefined;
    data.tokens = undefined;
    data.pending = { state: crypto.randomBytes(32).toString('hex'), actor, expires: Date.now() + 600_000, revision: c.revision };
    data.redirect = redirect;
    (await service.setSecret(c, data));
    let authorizationUrl = '';
    await authorize(provider(service, c, data, redirect, (url) => { authorizationUrl = url; }), { serverUrl: (c.transport as any).url, fetchFn: publicFetch });
    if (!authorizationUrl) throw new Error('Server did not provide an authorization URL');
    return { authorizationUrl };
  });
}
export async function finishOAuth(service: OAuthVault, c: OAuthTarget, actor: string, state: string, code: string) {
  return exclusive(`${c.organizationId}:${c.id}`, async () => {
    const data = await service.secret(c);
    const pending = data.pending;
    if (!pending || pending.actor !== actor || pending.revision !== c.revision || pending.expires < Date.now()
      || typeof state !== 'string' || !/^[a-f0-9]{64}$/.test(state) || !crypto.timingSafeEqual(Buffer.from(state), Buffer.from(pending.state))) throw new Error('Authorization expired or belongs to another session. Connect again.');
    if (typeof code !== 'string' || !code || code.length > 4096) throw new Error('Invalid authorization code');
    // Consume before exchanging. Preserve verifier only inside this invocation.
    (await service.setSecret(c, { ...data, pending: undefined }));
    const p = provider(service, c, data, data.redirect, () => { throw new Error('Authorization must be restarted'); });
    try {
      await authorize(p, { serverUrl: (c.transport as any).url, authorizationCode: code, fetchFn: publicFetch });
    } finally { delete data.pending; (await service.setSecret(c, data)); }
  });
}
export async function connectionHeaders(service: OAuthVault, c: OAuthTarget, taskId?: string): Promise<Record<string, string>> {
  if (c.auth === 'none') return {};
  if (c.auth === 'secrets') return service.secret(c, taskId);
  return exclusive(`${c.organizationId}:${c.id}`, async () => {
    let data = await service.secret(c, taskId);
    const refresh = async (current: any, store: OAuthVault) => {
      await authorize(provider(store, c, current, current.redirect, () => { throw new Error(`Reconnect “${c.label}” in MCP settings`); }),
        { serverUrl: (c.transport as any).url, fetchFn: publicFetch });
      return current;
    };
    // A refresh another process completed while this one waited may leave the
    // data changed but still stale (it saved other state); look again, briefly.
    for (let attempt = 0; attempt < 3 && data.tokens?.access_token && data.expiresAt < Date.now() + 60_000; attempt++) {
      if (!service.refresh) { await refresh(data, service); break; }
      // The SDK saves into `current` as it goes; the lease writes it back once.
      data = await service.refresh(c, taskId, data, (current) => refresh(current, { secret: async () => current, setSecret: async () => {} }));
    }
    if (!data.tokens?.access_token) throw new Error(`Connect “${c.label}” in MCP settings before running this task`);
    return { Authorization: `Bearer ${data.tokens.access_token}` };
  });
}
