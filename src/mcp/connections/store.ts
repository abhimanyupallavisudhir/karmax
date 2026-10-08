import * as __asyncCollections from '../../util/async-collections.js';
import crypto from 'node:crypto';
import type { Store } from '../../store/db.js';
import type { CredentialBroker } from '../../autonomy/broker.js';
import { organizationScope } from '../../autonomy/vault-keys.js';
import { publicUrl } from './http.js';
import { handleRef, recordSecretRefs } from '../../autonomy/task-secrets.js';

export type McpTransport = { type: 'http' | 'sse'; url: string }
  | { type: 'stdio'; command: string; args: string[]; env?: Record<string, string> };
export interface McpConnection {
  id: string; label: string; organizationId: string; projectId?: string;
  transport: McpTransport; enabled: boolean; revision: string;
  secretNames: string[]; auth: 'none' | 'secrets' | 'oauth';
  oauthClient?: { clientId: string; tokenEndpointAuthMethod: 'none' | 'client_secret_basic' | 'client_secret_post'; hasSecret: boolean };
  registry?: { name: string; version: string }; createdAt: number;
}
export const BUILTIN_MCPS = ['browser:chrome-devtools', 'browser:playwright'] as const;
export function validateMcpSelection(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 24 || value.some((v) => typeof v !== 'string'
    || (!BUILTIN_MCPS.includes(v as any) && !/^mcp_[a-f0-9]{24}$/.test(v) && !/^composio:conn_[a-z0-9]+$/.test(v)))) throw new Error('Tools must be a list of MCP or app connection IDs');
  if (new Set(value).size !== value.length) throw new Error('Tools contains duplicate connections');
  return value;
}
function bounded(value: unknown, max: number, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw new Error(`Invalid ${label}`);
  return value;
}
export function validateTransport(input: any): McpTransport {
  if (input?.type === 'http' || input?.type === 'sse') return { type: input.type, url: publicUrl(bounded(input.url, 2048, 'server URL')).href };
  if (input?.type !== 'stdio') throw new Error('Choose HTTP, SSE or a local process');
  const command = bounded(input.command, 256, 'command');
  if (!Array.isArray(input.args) || input.args.length > 80 || input.args.some((v: any) => typeof v !== 'string' || v.length > 4096 || v.includes('\0'))) throw new Error('Arguments must be a list of strings');
  const env = validateSecrets(input.env ?? {}, true);
  return { type: 'stdio', command, args: input.args, ...(Object.keys(env).length ? { env } : {}) };
}
export function validateSecrets(input: unknown, environment = false): Record<string, string> {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length > 40) throw new Error('Expected a map of names to values');
  const out: Record<string, string> = Object.create(null);
  for (const [key, value] of Object.entries(input)) {
    if (!(environment ? /^[A-Za-z_][A-Za-z0-9_]{0,79}$/ : /^[A-Za-z][A-Za-z0-9_-]{0,79}$/).test(key)
      || /^(karmax_|node_options$|ld_|dyld_|http_proxy$|https_proxy$|all_proxy$)/i.test(key)
      || (!environment && /^(host|cookie|connection|content-length|transfer-encoding)$/i.test(key))) throw new Error(`Reserved or invalid credential name: ${key}`);
    if (typeof value !== 'string' || value.length > 16384 || /[\r\n\0]/.test(value)) throw new Error(`Invalid value for ${key}`);
    out[key] = value;
  }
  return out;
}
export class McpConnections {
  constructor(private store: Store, private broker: CredentialBroker, readonly organizationId: string) {}
  private key() { return `mcp-connections:${this.organizationId}`; }
  private async all(): Promise<McpConnection[]> { return (await this.store.getSettings(this.key(), 'mcp'))?.connections as McpConnection[] ?? []; }
  async list(projectId?: string): Promise<McpConnection[]> { return (await this.all()).filter((c) => !c.projectId || c.projectId === projectId); }
  async get(id: string, projectId?: string): Promise<McpConnection> {
    const c = (await this.list(projectId)).find((v) => v.id === id);
    if (!c) throw new Error('MCP connection not found in this scope');
    return c;
  }
  private handle(id: string) { return `mcp:${this.organizationId}:${id}`; }
  async save(input: any, projectId?: string): Promise<McpConnection> {
    return this.store.transaction(async () => {
      // The organization's connection list (and its cap) is rewritten under its vault lock.
      (await this.store.lock(`vault:${this.organizationId}`));
      if (projectId && (await this.store.getProject(projectId))?.organizationId !== this.organizationId) throw new Error('Project does not belong to this organization');
      const prior = input.id ? (await this.get(input.id, projectId)) : undefined;
      if (prior && prior.projectId !== projectId) throw new Error('Edit this connection in its owning settings');
      if (!prior && (await this.all()).length >= 200) throw new Error('Connection limit reached (200 per organization)');
      const transport = validateTransport(input.transport);
      const auth = input.auth ?? 'none';
      if (!['none', 'secrets', 'oauth'].includes(auth) || (auth === 'oauth' && transport.type === 'stdio')) throw new Error('Invalid authentication method');
      const changed = prior && (JSON.stringify(prior.transport) !== JSON.stringify(transport) || prior.auth !== auth);
      let oauthData: any;
      let oauthClient = changed ? undefined : prior?.oauthClient;
      if (input.oauthClient !== undefined) {
        if (auth !== 'oauth') throw new Error('OAuth client details require OAuth authentication');
        oauthData = {};
        oauthClient = undefined;
        if (input.oauthClient !== null) {
          const v = input.oauthClient;
          if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('Invalid OAuth client details');
          const clientId = bounded(v.clientId, 2048, 'OAuth client ID').trim();
          const method = v.tokenEndpointAuthMethod ?? 'none';
          if (!['none', 'client_secret_basic', 'client_secret_post'].includes(method)) throw new Error('Unsupported OAuth client authentication method');
          const previous = prior && !changed ? this.secret(prior).manualClient : undefined;
          const secret = v.clientSecret === undefined && previous?.client_id === clientId && previous?.token_endpoint_auth_method === method
            ? previous.client_secret : v.clientSecret;
          if (method !== 'none' && (typeof secret !== 'string' || !secret || secret.length > 16384 || /[\r\n\0]/.test(secret)))
            throw new Error('A client secret is required for this authentication method');
          oauthData.manualClient = { client_id: clientId, token_endpoint_auth_method: method,
            ...(method !== 'none' ? { client_secret: secret } : {}) };
          oauthClient = { clientId, tokenEndpointAuthMethod: method, hasSecret: method !== 'none' };
          if (previous && JSON.stringify(previous) === JSON.stringify(oauthData.manualClient)) oauthData = undefined;
        }
      }
      const connection: McpConnection = {
        id: prior?.id ?? `mcp_${crypto.randomBytes(12).toString('hex')}`,
        organizationId: this.organizationId, ...(projectId ? { projectId } : {}),
        label: bounded(input.label, 120, 'connection name'), transport, enabled: input.enabled !== false,
        ...(oauthClient ? { oauthClient } : {}),
        auth, secretNames: prior?.secretNames ?? [], revision: crypto.randomUUID(), createdAt: prior?.createdAt ?? Date.now(),
        ...(input.registry ? { registry: { name: bounded(input.registry.name, 256, 'registry name'), version: bounded(input.registry.version, 128, 'registry version') } } : {}),
      };
      let secrets: Record<string, string> | undefined;
      if (input.secrets !== undefined && auth === 'secrets') {
        secrets = validateSecrets(input.secrets, transport.type === 'stdio');
        if (input.mergeSecrets && prior && !changed && prior.auth === 'secrets') {
          const old = this.secret(prior);
          const keep = Array.isArray(input.retainSecretNames) ? input.retainSecretNames : Object.keys(old);
          secrets = validateSecrets({ ...Object.fromEntries(Object.entries(old).filter(([key]) => keep.includes(key))), ...secrets }, transport.type === 'stdio');
        }
      }
      if (changed || auth === 'none') { (await this.broker.deleteHandle(this.handle(connection.id))); connection.secretNames = []; }
      if (secrets) {
        (await this.broker.registerHandle(this.handle(connection.id), JSON.stringify(secrets), organizationScope(this.organizationId)));
        connection.secretNames = Object.keys(secrets);
      }
      const connections = (await this.all()).filter((c) => c.id !== connection.id);
      if (connections.length >= 200) throw new Error('Connection limit reached (200 per organization)');
      (await this.store.setSettings(this.key(), 'mcp', { connections: [...connections, connection] }));
      if (oauthData !== undefined) await this.setSecret(connection, oauthData);
      return connection;
    });
  }

  async remove(id: string, projectId?: string) {
    return this.store.transaction(async () => {
      (await this.store.lock(`vault:${this.organizationId}`));
      const c = (await this.get(id, projectId));
      if (c.projectId !== projectId) throw new Error('Remove this connection in its owning settings');
      (await this.store.setSettings(this.key(), 'mcp', { connections: (await this.all()).filter((v) => v.id !== id) }));
      (await this.broker.deleteHandle(this.handle(id)));
    });
  }

  /** Record that these connections' credentials are written into a task's
   * world, so what tavya keeps of the task is scrubbed of them (SS-3). */
  async delivered(taskId: string, connections: McpConnection[]): Promise<void> {
    (await recordSecretRefs(this.store, taskId, connections.map((c) => handleRef(this.handle(c.id)))));
  }
  secret(c: McpConnection, taskId?: string): any {
    const handle = this.handle(c.id);
    if (!this.broker.hasHandle(handle)) return {};
    return JSON.parse(this.broker.resolve(handle, { taskId, caps: [`use-credential:${handle}`] }));
  }
  async setSecret(c: McpConnection, value: unknown) {
    await this.store.transaction(async () => {
      (await this.store.lock(`vault:${this.organizationId}`));
      if ((await this.get(c.id, c.projectId)).revision !== c.revision) throw new Error('Connection changed during authorization. Connect again.');
      (await this.broker.registerHandle(this.handle(c.id), JSON.stringify(value), organizationScope(this.organizationId)));
    });
  }
  async selected(ids: string[], projectId: string): Promise<McpConnection[]> {
    validateMcpSelection(ids);
    return (await __asyncCollections.map(ids.filter((id) => !BUILTIN_MCPS.includes(id as any) && !id.startsWith('composio:')), async (id) => {
      const c = (await this.get(id, projectId));
      if (!c.enabled) throw new Error(`MCP connection “${c.label}” is disabled. Update the Agent tools selection.`);
      return c;
    }));
  }
}
