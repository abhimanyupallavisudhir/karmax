import crypto from 'node:crypto';
import { auth, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { publicFetch, publicUrl } from './http.js';
import { McpConnections, type McpConnection } from './store.js';

const locks = new Map<string, Promise<unknown>>();
const waiters = new Map<string, number>();
async function exclusive<T>(key: string, run: () => Promise<T>): Promise<T> {
  if ((!locks.has(key) && locks.size >= 24) || (waiters.get(key) ?? 0) >= 8) throw new Error('Connection service is busy. Retry shortly.');
  waiters.set(key, (waiters.get(key) ?? 0) + 1);
  const old = locks.get(key) ?? Promise.resolve();
  const next = old.catch(() => {}).then(run); locks.set(key, next);
  try { return await next; } finally { const count = (waiters.get(key) ?? 1) - 1; if (count) waiters.set(key, count); else waiters.delete(key); if (locks.get(key) === next) locks.delete(key); }
}
function provider(service: McpConnections, connection: McpConnection, data: any, redirect: string,
  onRedirect: (url: string) => void): OAuthClientProvider {
  return {
    redirectUrl: redirect,
    clientMetadata: { client_name: 'Tavya', redirect_uris: [redirect], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' },
    state: () => data.pending.state,
    clientInformation: () => data.client,
    saveClientInformation: (client) => { data.client = client; service.setSecret(connection, data); },
    tokens: () => data.tokens,
    saveTokens: (tokens) => { data.tokens = { ...tokens, refresh_token: tokens.refresh_token ?? data.tokens?.refresh_token }; data.expiresAt = Date.now() + (tokens.expires_in ?? 3600) * 1000; service.setSecret(connection, data); },
    redirectToAuthorization: (url) => { onRedirect(publicUrl(url.href).href); },
    saveCodeVerifier: (verifier) => { data.pending.verifier = verifier; service.setSecret(connection, data); },
    codeVerifier: () => data.pending?.verifier ?? '',
    discoveryState: () => data.discovery,
    saveDiscoveryState: (state) => { data.discovery = state; service.setSecret(connection, data); },
  };
}
export async function beginOAuth(service: McpConnections, c: McpConnection, actor: string, redirect: string) {
  if (c.auth !== 'oauth' || c.transport.type === 'stdio') throw new Error('This connection does not use OAuth');
  return exclusive(`${c.organizationId}:${c.id}`, async () => {
    const data = service.secret(c);
    data.tokens = undefined;
    data.pending = { state: crypto.randomBytes(32).toString('hex'), actor, expires: Date.now() + 600_000, revision: c.revision };
    data.redirect = redirect;
    service.setSecret(c, data);
    let authorizationUrl = '';
    await auth(provider(service, c, data, redirect, (url) => { authorizationUrl = url; }), { serverUrl: (c.transport as any).url, fetchFn: publicFetch });
    if (!authorizationUrl) throw new Error('Server did not provide an authorization URL');
    return { authorizationUrl };
  });
}
export async function finishOAuth(service: McpConnections, c: McpConnection, actor: string, state: string, code: string) {
  return exclusive(`${c.organizationId}:${c.id}`, async () => {
    const data = service.secret(c);
    const pending = data.pending;
    if (!pending || pending.actor !== actor || pending.revision !== c.revision || pending.expires < Date.now()
      || typeof state !== 'string' || !/^[a-f0-9]{64}$/.test(state) || !crypto.timingSafeEqual(Buffer.from(state), Buffer.from(pending.state))) throw new Error('Authorization expired or belongs to another session. Connect again.');
    if (typeof code !== 'string' || !code || code.length > 4096) throw new Error('Invalid authorization code');
    // Consume before exchanging. Preserve verifier only inside this invocation.
    service.setSecret(c, { ...data, pending: undefined });
    const p = provider(service, c, data, data.redirect, () => { throw new Error('Authorization must be restarted'); });
    try {
      await auth(p, { serverUrl: (c.transport as any).url, authorizationCode: code, fetchFn: publicFetch });
    } finally { delete data.pending; service.setSecret(c, data); }
  });
}
export async function connectionHeaders(service: McpConnections, c: McpConnection, taskId?: string): Promise<Record<string, string>> {
  if (c.auth === 'none') return {};
  if (c.auth === 'secrets') return service.secret(c, taskId);
  return exclusive(`${c.organizationId}:${c.id}`, async () => {
    const data = service.secret(c, taskId);
    if (!data.tokens?.access_token) throw new Error(`Connect “${c.label}” in MCP settings before running this task`);
    if (data.expiresAt < Date.now() + 60_000) {
      await auth(provider(service, c, data, data.redirect, () => { throw new Error(`Reconnect “${c.label}” in MCP settings`); }),
        { serverUrl: (c.transport as any).url, fetchFn: publicFetch });
    }
    return { Authorization: `Bearer ${data.tokens.access_token}` };
  });
}
