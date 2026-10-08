import { parse } from 'yaml';
import type { ProjectService } from '../domain/types.js';

const KV_PREFIX = 'project-services:';
export interface ProjectServicesStore {
  transaction<T>(operation: () => Promise<T>): Promise<T>;
  kvGet(key: string): (string | undefined) | Promise<string | undefined>;
  kvSet(key: string, value: string): (void) | Promise<void>;
  /** Store.lockProjectRow: a transfer or another edit waits for this one. */
  lockProjectRow?(projectId: string, mode: 'update'): Promise<void>;
}

export class ProjectServices {
  constructor(private store: ProjectServicesStore) {}
  async list(projectId: string): Promise<ProjectService[]> {
    try { return JSON.parse((await this.store.kvGet(KV_PREFIX + projectId)) ?? '[]') as ProjectService[]; }
    catch { return []; }
  }
  async save(projectId: string, service: ProjectService): Promise<ProjectService> {
    return this.store.transaction(async () => {
    await this.store.lockProjectRow?.(projectId, 'update');
    const name = service.name?.trim();
    if (!/^[a-z0-9][a-z0-9_-]*$/i.test(name ?? '')) throw new Error('service name must be alphanumeric with - or _');
    if (service.kind === 'external' && !service.connectionResourceId)
      throw new Error('an external service must reference a secret resource');
    if (service.kind === 'per-world') {
      if (!service.image?.trim()) throw new Error('a per-world service needs a container image');
      if (service.containerPort != null && (!Number.isInteger(service.containerPort)
        || service.containerPort < 1 || service.containerPort > 65_535)) throw new Error('invalid container port');
      if (service.urlEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(service.urlEnv)) throw new Error('invalid connection variable');
      if (service.seedResourceId && !service.seedContainerPath) throw new Error('a seed resource needs a container path');
    }
    const record = { ...service, name };
    (await this.store.kvSet(KV_PREFIX + projectId, JSON.stringify([
      ...(await this.list(projectId)).filter((candidate) => candidate.name !== name), record,
    ])));
    return record;

    });
  }
  async delete(projectId: string, name: string): Promise<void> {
    return this.store.transaction(async () => {
    await this.store.lockProjectRow?.(projectId, 'update');
    (await this.store.kvSet(KV_PREFIX + projectId, JSON.stringify(
      (await this.list(projectId)).filter((candidate) => candidate.name !== name))));

    });
  }
}

export function composeServiceProposals(text: string): ProjectService[] {
  let document: any;
  try { document = parse(text); }
  catch (error) { throw new Error(`could not parse compose file: ${error instanceof Error ? error.message : error}`); }
  if (!document?.services || typeof document.services !== 'object') return [];
  const proposals: ProjectService[] = [];
  for (const [name, raw] of Object.entries(document.services as Record<string, any>)) {
    if (!raw?.image || !/^[a-z0-9][a-z0-9_-]*$/i.test(name)) continue;
    const env = composeEnvironment(raw.environment);
    const containerPort = composePort(raw.ports) ?? knownPort(String(raw.image));
    proposals.push({ name, kind: 'per-world', image: String(raw.image),
      ...(Object.keys(env).length ? { env } : {}), ...(containerPort ? { containerPort } : {}),
      ...connectionDefaults(String(raw.image), name, env) });
  }
  return proposals;
}

function composeEnvironment(value: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  if (Array.isArray(value)) for (const entry of value) {
    const match = String(entry).match(/^([^=]+)=(.*)$/);
    if (match) result[match[1]!] = match[2]!;
  }
  else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value))
    if (item != null) result[key] = String(item);
  return result;
}
function composePort(value: unknown): number | undefined {
  if (!Array.isArray(value) || !value.length) return undefined;
  const first = value[0];
  if (first && typeof first === 'object' && 'target' in first) return Number((first as any).target) || undefined;
  return Number(String(first).split(':').pop()!.replace(/\/.*$/, '')) || undefined;
}
function knownPort(image: string): number | undefined {
  const base = image.split('/').pop()!.split(':')[0]!;
  return ({ postgres: 5432, mysql: 3306, mariadb: 3306, redis: 6379, valkey: 6379, mongo: 27017 } as Record<string, number>)[base];
}
function connectionDefaults(image: string, name: string, env: Record<string, string>): Pick<ProjectService, 'urlEnv' | 'urlTemplate'> {
  const base = image.split('/').pop()!.split(':')[0]!;
  if (base === 'postgres') {
    const user = env.POSTGRES_USER ?? 'postgres', password = env.POSTGRES_PASSWORD ?? '', database = env.POSTGRES_DB ?? user;
    return { urlEnv: 'DATABASE_URL', urlTemplate: `postgres://${user}${password ? `:${password}` : ''}@{host}:{port}/${database}` };
  }
  if (base === 'mysql' || base === 'mariadb') {
    const user = env.MYSQL_USER ?? 'root', password = env.MYSQL_PASSWORD ?? env.MYSQL_ROOT_PASSWORD ?? '';
    return { urlEnv: 'DATABASE_URL', urlTemplate: `mysql://${user}${password ? `:${password}` : ''}@{host}:{port}/${env.MYSQL_DATABASE ?? ''}` };
  }
  if (base === 'redis' || base === 'valkey') return { urlEnv: 'REDIS_URL', urlTemplate: 'redis://{host}:{port}' };
  if (base === 'mongo') return { urlEnv: 'MONGO_URL', urlTemplate: 'mongodb://{host}:{port}' };
  return { urlEnv: `${name.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()}_URL`, urlTemplate: 'tcp://{host}:{port}' };
}
