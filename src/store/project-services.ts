import { parse } from 'yaml';
import { ProjectService } from '../domain/types.js';

/**
 * Project services registry (PLAN-state.md §3.3). Records only — external
 * services resolve through a named project Secret; per-world services are
 * launched by the world layer (src/world/services.ts). The compose importer
 * turns the docker-compose.yml a project already has into proposals: nothing
 * about the user's layout is prescribed — their compose file IS the declaration.
 */

const KV_PREFIX = 'project-services:';

export interface ProjectServicesStore {
  kvGet(k: string): string | undefined;
  kvSet(k: string, v: string): void;
}

export class ProjectServices {
  constructor(private store: ProjectServicesStore) {}

  list(projectId: string): ProjectService[] {
    const raw = this.store.kvGet(KV_PREFIX + projectId);
    if (!raw) return [];
    try {
      return JSON.parse(raw) as ProjectService[];
    } catch {
      return [];
    }
  }

  save(projectId: string, service: ProjectService): ProjectService {
    const name = service.name?.trim();
    if (!/^[a-z0-9][a-z0-9_-]*$/i.test(name ?? '')) throw new Error('service name must be alphanumeric with - _ only');
    if (service.kind === 'external') {
      if (!service.connectionSecret?.trim()) throw new Error('an external service names the Secret holding its connection string');
    } else if (service.kind === 'per-world') {
      if (!service.image?.trim()) throw new Error('a per-world service needs a container image');
      if (service.containerPort != null && !(Number.isInteger(service.containerPort) && service.containerPort > 0 && service.containerPort < 65536))
        throw new Error('containerPort must be a port number');
      if (service.urlEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(service.urlEnv)) throw new Error('urlEnv must be env-var-shaped');
      if (service.seedObject && !service.seedContainerPath) throw new Error('a seed object needs seedContainerPath (where to mount it)');
    } else throw new Error('kind must be external or per-world');
    const rec: ProjectService = { ...service, name };
    this.store.kvSet(KV_PREFIX + projectId, JSON.stringify([...this.list(projectId).filter((s) => s.name !== name), rec]));
    return rec;
  }

  delete(projectId: string, name: string) {
    this.store.kvSet(KV_PREFIX + projectId, JSON.stringify(this.list(projectId).filter((s) => s.name !== name)));
  }
}

/** Turn a docker-compose file into per-world service proposals. Only services
 * with an image import (build-only services belong to the Environment). Known
 * database images get a ready connection template derived from the compose
 * file's own environment. */
export function composeServiceProposals(text: string): ProjectService[] {
  let doc: any;
  try {
    doc = parse(text);
  } catch (e) {
    throw new Error(`could not parse compose file: ${e instanceof Error ? e.message : e}`);
  }
  const services = doc && typeof doc === 'object' ? doc.services : undefined;
  if (!services || typeof services !== 'object') return [];
  const out: ProjectService[] = [];
  for (const [name, raw] of Object.entries(services as Record<string, any>)) {
    if (!raw || typeof raw !== 'object' || !raw.image || !/^[a-z0-9][a-z0-9_-]*$/i.test(name)) continue;
    const env = composeEnvironment(raw.environment);
    const containerPort = composeContainerPort(raw.ports) ?? knownImagePort(String(raw.image));
    const service: ProjectService = {
      name, kind: 'per-world', image: String(raw.image),
      ...(Object.keys(env).length ? { env } : {}),
      ...(containerPort ? { containerPort } : {}),
      ...connectionDefaults(String(raw.image), name, env),
    };
    out.push(service);
  }
  return out;
}

function composeEnvironment(value: unknown): Record<string, string> {
  const env: Record<string, string> = {};
  if (Array.isArray(value)) {
    for (const entry of value) {
      const m = String(entry).match(/^([^=]+)=(.*)$/);
      if (m) env[m[1]!] = m[2]!;
    }
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) if (v != null) env[k] = String(v);
  }
  return env;
}

function composeContainerPort(value: unknown): number | undefined {
  if (!Array.isArray(value) || !value.length) return undefined;
  const first = value[0];
  if (typeof first === 'object' && first && 'target' in first) return Number((first as any).target) || undefined;
  // "5432", "5432:5432", "127.0.0.1:5433:5432" — the container port is the last segment.
  const segments = String(first).split(':');
  return Number(segments[segments.length - 1]!.replace(/\/.*$/, '')) || undefined;
}

function knownImagePort(image: string): number | undefined {
  const base = image.split('/').pop()!.split(':')[0]!;
  return { postgres: 5432, mysql: 3306, mariadb: 3306, redis: 6379, mongo: 27017, valkey: 6379 }[base];
}

/** A ready {urlEnv, urlTemplate} for the common databases, honoring the
 * compose file's own credentials env; generic services get NAME_URL=tcp://. */
function connectionDefaults(image: string, name: string, env: Record<string, string>): Pick<ProjectService, 'urlEnv' | 'urlTemplate'> {
  const base = image.split('/').pop()!.split(':')[0]!;
  if (base === 'postgres') {
    const user = env.POSTGRES_USER ?? 'postgres';
    const pass = env.POSTGRES_PASSWORD ?? '';
    const db = env.POSTGRES_DB ?? user;
    return { urlEnv: 'DATABASE_URL', urlTemplate: `postgres://${user}${pass ? `:${pass}` : ''}@{host}:{port}/${db}` };
  }
  if (base === 'mysql' || base === 'mariadb') {
    const user = env.MYSQL_USER ?? 'root';
    const pass = env.MYSQL_PASSWORD ?? env.MYSQL_ROOT_PASSWORD ?? '';
    const db = env.MYSQL_DATABASE ?? '';
    return { urlEnv: 'DATABASE_URL', urlTemplate: `mysql://${user}${pass ? `:${pass}` : ''}@{host}:{port}/${db}` };
  }
  if (base === 'redis' || base === 'valkey') return { urlEnv: 'REDIS_URL', urlTemplate: 'redis://{host}:{port}' };
  if (base === 'mongo') return { urlEnv: 'MONGO_URL', urlTemplate: 'mongodb://{host}:{port}' };
  return { urlEnv: `${name.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()}_URL`, urlTemplate: 'tcp://{host}:{port}' };
}
