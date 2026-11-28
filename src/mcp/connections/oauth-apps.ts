import type { Store } from '../../store/db.js';
import type { CredentialBroker } from '../../autonomy/broker.js';
import { INSTALLATION_SCOPE } from '../../autonomy/vault-keys.js';

/**
 * OAuth apps an installation operator registered with an authorization server
 * that registers no clients on demand (neither dynamic registration nor client
 * ID metadata documents) — Google's, behind its Workspace MCP servers
 * (gmailmcp.googleapis.com…). Every MCP sign-in through that server uses the
 * app, people's app connections and Tools connections alike, unless a Tools
 * connection names a client of its own. The secret is write-only, kept in the
 * vault; it is never copied into a connection's credentials.
 * (wiki features/service-connections § Sign-in apps)
 */
export interface OAuthAppView { server: string; clientId: string; hasSecret: boolean }
interface StoredApp { server: string; clientId: string }

const SETTINGS = ['global', 'oauth-apps'] as const;
const secretHandle = (server: string) => `oauth-app:${server}`;

/** An authorization server's key: its host and path, however it is written
 *  (`accounts.google.com`, `https://accounts.google.com/`). */
export function oauthAppServer(value: string): string {
  const text = value.trim();
  let url: URL;
  try { url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`); }
  catch { throw new Error('Name the authorization server by its URL, e.g. https://accounts.google.com'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
    throw new Error('An authorization server is an https URL without credentials, query or fragment');
  return (url.host + url.pathname).replace(/\/+$/, '').toLowerCase();
}

export class OAuthApps {
  constructor(private store: Store, private broker: CredentialBroker) {}
  private async stored(): Promise<StoredApp[]> { return ((await this.store.getSettings(...SETTINGS))?.apps as StoredApp[] | undefined) ?? []; }
  async list(): Promise<OAuthAppView[]> {
    return Promise.all((await this.stored()).map(async (app) => ({ ...app, hasSecret: await this.broker.hasHandle(secretHandle(app.server)) })));
  }
  /** Registers (or replaces) the app for a server. Without a secret, the same
   *  client keeps its secret and a different client is a public one. */
  async save(serverUrl: string, input: { clientId?: unknown; clientSecret?: unknown }): Promise<OAuthAppView> {
    const server = oauthAppServer(serverUrl);
    const clientId = typeof input.clientId === 'string' ? input.clientId.trim() : '';
    if (!clientId || clientId.length > 512) throw new Error('A client ID is required');
    if (input.clientSecret !== undefined && (typeof input.clientSecret !== 'string' || input.clientSecret.length > 4096))
      throw new Error('clientSecret must be a string');
    const secret = typeof input.clientSecret === 'string' ? input.clientSecret.trim() : '';
    return this.store.transaction(async () => {
      await this.store.lock('settings:oauth-apps');
      const apps = await this.stored();
      const prior = apps.find((app) => app.server === server);
      if (secret) await this.broker.registerHandle(secretHandle(server), secret, INSTALLATION_SCOPE);
      else if (prior?.clientId !== clientId) await this.broker.deleteHandle(secretHandle(server));
      await this.store.setSettings(...SETTINGS, { apps: [...apps.filter((app) => app.server !== server), { server, clientId }] });
      return { server, clientId, hasSecret: await this.broker.hasHandle(secretHandle(server)) };
    });
  }
  async remove(serverUrl: string): Promise<void> {
    const server = oauthAppServer(serverUrl);
    await this.store.transaction(async () => {
      await this.store.lock('settings:oauth-apps');
      await this.store.setSettings(...SETTINGS, { apps: (await this.stored()).filter((app) => app.server !== server) });
      await this.broker.deleteHandle(secretHandle(server));
    });
  }
  /** The client to sign in with at an authorization server, if one is registered. */
  async client(authorizationServer: string): Promise<{ client_id: string; client_secret?: string } | undefined> {
    let server: string;
    try { server = oauthAppServer(authorizationServer); } catch { return undefined; }
    const app = (await this.stored()).find((candidate) => candidate.server === server);
    if (!app) return undefined;
    const handle = secretHandle(server);
    return await this.broker.hasHandle(handle)
      ? { client_id: app.clientId, client_secret: await this.broker.resolve(handle, { caps: [`use-credential:${handle}`] }) }
      : { client_id: app.clientId };
  }
}
