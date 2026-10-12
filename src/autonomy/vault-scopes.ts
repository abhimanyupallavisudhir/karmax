import type { Store } from '../store/db.js';
import { LOGIN_PROVIDERS, MODEL_PROVIDERS } from '../agent/provider-registry.js';
import { INSTALLATION_SCOPE, organizationScope, userScope, type VaultScope } from './vault-keys.js';

/** A row from a raw SQL read; columns are checked where they are used. */
type Row = Record<string, unknown>;

/**
 * Who owns each vault handle, for the data epoch 4 migration (SS-1): the
 * secrets written before data keys record no scope, so the database says.
 * Handles that already name their owner are read from their structure; the
 * rest from the records that point at them (vault item indexes, resource
 * attachments, cards, storage locations, provider connections, service
 * connections, tasks). Handles naming an organization that no longer exists,
 * and handles no rule covers, are left out: the vault keeps them under the
 * installation's key, marked unresolved, and reports them.
 */

/** Platform secrets: one per installation, owned by no tenant. */
const INSTALLATION_HANDLES = new Set(['github-app:private-key', 'github-app:webhook-secret', 'github-app:client-secret',
  'checkpoint:encryption-key', 'world-reference:key:v2', 'service-connections:composio:api-key', 'email:outbound:auth']);
const INSTALLATION_PREFIXES = ['platform:'];
/** Handles whose second segment (or third, for mailboxes) is the organization id. */
const ORGANIZATION_IN_HANDLE = [
  /^(?:world-provider|mcp|connector|connector-export|incoming-webhook):([^:]+):/,
  /^resource-store:key:([^:]+)$/,
  /^mailbox:[^:]+:([^:]+):auth$/,
];

export async function resolveVaultScopes(store: Store, handles: string[]): Promise<Map<string, VaultScope>> {
  const db = store.db;
  const organizations = new Set(((await db.prepare('SELECT id FROM organizations').all()) as Array<{ id: string }>).map((row) => String(row.id)));
  organizations.add('org_personal');
  const organization = (id: string | undefined | null): VaultScope | undefined => {
    if (!id || !organizations.has(String(id))) return undefined;
    try { return organizationScope(String(id)); } catch { return undefined; }
  };
  const user = (id: string): VaultScope | undefined => { try { return userScope(id); } catch { return undefined; } };

  const items = new Map<string, string>();
  for (const { key, value } of await store.kvEntries('vault:items:')) {
    const org = key.slice('vault:items:'.length);
    try { for (const item of JSON.parse(value)) if (typeof item?.id === 'string') items.set(item.id, org); } catch { /* not an index */ }
  }
  const attachments = new Map<string, string>();
  const referenced = new Map<string, Set<string>>();
  for (const row of (await db.prepare('SELECT id, organizationId, credentialHandles FROM resource_attachments').all()) as Row[]) {
    attachments.set(String(row.id), String(row.organizationId));
    try {
      for (const handle of JSON.parse(String(row.credentialHandles)))
        if (typeof handle === 'string') (referenced.get(handle) ?? referenced.set(handle, new Set()).get(handle)!).add(String(row.organizationId));
    } catch { /* malformed */ }
  }
  const credentialOwners = new Map<string, string>();
  for (const table of ['storage_locations', 'world_provider_connections'])
    for (const row of (await db.prepare(`SELECT credentialHandle, organizationId FROM ${table} WHERE credentialHandle IS NOT NULL`).all()) as Row[])
      credentialOwners.set(String(row.credentialHandle), String(row.organizationId));
  const cards = new Map<string, string>();
  for (const row of (await db.prepare(`SELECT c.id, c.scope, c.scopeId, p.organizationId AS projectOrganization FROM cards c
    LEFT JOIN projects p ON c.scope='project' AND c.scopeId=p.id`).all()) as Row[]) {
    const org = row.scope === 'organization' ? row.scopeId : row.scope === 'project' ? row.projectOrganization : 'org_personal';
    if (org) cards.set(String(row.id), String(org));
  }
  const serviceConnections = new Map<string, string>();
  for (const { key, value } of await store.kvEntries('service-connection:')) {
    try { const connection = JSON.parse(value); if (connection?.organizationId) serviceConnections.set(key.slice('service-connection:'.length), String(connection.organizationId)); }
    catch { /* not a connection */ }
  }
  const taskOrganizations = new Map<string, string | undefined>();
  const taskOrganization = async (taskId: string) => {
    if (!taskOrganizations.has(taskId)) taskOrganizations.set(taskId, ((await db.prepare(
      'SELECT p.organizationId AS organizationId FROM tasks t JOIN projects p ON p.id = t.projectId WHERE t.id = ?').get(taskId)) as Row | undefined)?.organizationId as string | undefined);
    return taskOrganizations.get(taskId);
  };
  const providers = new Set<string>([...LOGIN_PROVIDERS, ...MODEL_PROVIDERS, 'grok']);

  const owner = async (handle: string): Promise<VaultScope | undefined> => {
    if (INSTALLATION_HANDLES.has(handle) || INSTALLATION_PREFIXES.some((prefix) => handle.startsWith(prefix))) return INSTALLATION_SCOPE;
    const parts = handle.split(':');
    if (parts[0] === 'github-app' && parts[1] === 'user' && parts[2]) return user(parts[2]);
    if (parts[0] === 'git') {
      // gitHandle: git:user:<user>:<profile>:<kind>, git:<profile>:<kind> (the
      // personal organization), git:<organization>:<profile>:<kind>.
      if (parts[1] === 'user' && parts.length === 5) return user(parts[2]!);
      if (parts.length === 3) return organization('org_personal');
      if (parts.length === 4) return organization(parts[1]);
    }
    for (const pattern of ORGANIZATION_IN_HANDLE) {
      const match = pattern.exec(handle);
      if (match) return organization(match[1]);
    }
    if (parts[0] === 'item' && parts.length === 3) return organization(items.get(parts[1]!));
    if (parts[0] === 'resource' && parts[2] === 'credential' && parts.length === 3 && attachments.has(parts[1]!))
      return organization(attachments.get(parts[1]!));
    if (credentialOwners.has(handle)) return organization(credentialOwners.get(handle));
    if (parts[0] === 'payment' && parts[1] === 'card' && (parts.length === 3 || (parts.length === 4 && parts[3] === 'cvc')))
      return organization(cards.get(parts[2]!));
    if ((parts[0] === 'service-connection' || parts[0] === 'service-connection-mcp') && parts.length === 2)
      return organization(serviceConnections.get(parts[1]!));
    if (parts[0] === 'world-service' && parts[1]) return organization(await taskOrganization(parts[1]));
    // Model-provider API keys: <provider>:<account> belongs to the personal
    // organization, <provider>:<organization>:<account> to that organization.
    if (providers.has(parts[0]!)) {
      if (parts.length === 2) return organization('org_personal');
      if (parts.length === 3) return organization(parts[1]);
    }
    const referrers = referenced.get(handle);
    if (referrers?.size === 1) return organization([...referrers][0]);
    return undefined;
  };

  const scopes = new Map<string, VaultScope>();
  for (const handle of handles) {
    const scope = await owner(handle);
    if (scope) scopes.set(handle, scope);
  }
  return scopes;
}
