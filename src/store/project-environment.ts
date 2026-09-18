import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Store } from './db.js';
import type { EnvironmentBuildRecord, ProjectEnvironmentSpec } from '../domain/types.js';

const KV_SPEC = 'project-environment:';
const KV_BUILDS = 'project-environment-builds:';

export interface ProjectEnvironmentStore {
  kvGet(key: string): string | undefined;
  kvSet(key: string, value: string): void;
  getProject?: Store['getProject'];
}

export class ProjectEnvironment {
  constructor(private store: ProjectEnvironmentStore) {}

  spec(projectId: string): ProjectEnvironmentSpec | undefined {
    const raw = this.store.kvGet(KV_SPEC + projectId);
    if (!raw) return undefined;
    try {
      const parsed = JSON.parse(raw) as ProjectEnvironmentSpec;
      return Object.keys(parsed).length ? parsed : undefined;
    } catch { return undefined; }
  }

  setSpec(projectId: string, spec: ProjectEnvironmentSpec): ProjectEnvironmentSpec {
    const clean: ProjectEnvironmentSpec = {
      ...(spec.image?.trim() ? { image: spec.image.trim() } : {}),
      ...(spec.setup?.length ? { setup: spec.setup.map((value) => value.trim()).filter(Boolean) } : {}),
      ...(spec.boot?.length ? { boot: spec.boot.map((value) => value.trim()).filter(Boolean) } : {}),
      ...(spec.includeDocker ? { includeDocker: true } : {}),
    };
    this.store.kvSet(KV_SPEC + projectId, JSON.stringify(clean));
    return clean;
  }

  digest(spec: ProjectEnvironmentSpec): string {
    return crypto.createHash('sha256').update(JSON.stringify({
      image: spec.image ?? '', setup: spec.setup ?? [], docker: !!spec.includeDocker,
    })).digest('hex').slice(0, 16);
  }

  builds(projectId: string): EnvironmentBuildRecord[] {
    try { return JSON.parse(this.store.kvGet(KV_BUILDS + projectId) ?? '[]') as EnvironmentBuildRecord[]; }
    catch { return []; }
  }

  recordBuild(projectId: string, value: Omit<EnvironmentBuildRecord, 'createdAt' | 'updatedAt'>): EnvironmentBuildRecord {
    const builds = this.builds(projectId);
    const prior = builds.find((candidate) => candidate.provider === value.provider && candidate.digest === value.digest);
    const next = { ...value, createdAt: prior?.createdAt ?? Date.now(), updatedAt: Date.now() };
    this.store.kvSet(KV_BUILDS + projectId, JSON.stringify([
      ...builds.filter((candidate) => candidate.provider !== value.provider || candidate.digest !== value.digest), next,
    ]));
    return next;
  }

  readyBuild(projectId: string, provider: string, digest: string): EnvironmentBuildRecord | undefined {
    const record = this.builds(projectId).find((candidate) =>
      candidate.provider === provider && candidate.digest === digest);
    const generation = this.store.kvGet(`project-transfer-current:${projectId}`);
    // Legacy unscoped builds are usable only before the first transfer. Never
    // let a late legacy callback recreate selectable source-owned artifacts.
    if (record?.organizationId) {
      if (this.store.getProject?.(projectId)?.organizationId !== record.organizationId
        || (generation ?? '') !== record.transferGeneration) return undefined;
    } else if (generation) return undefined;
    return record?.status === 'ready' && record.ref ? record : undefined;
  }
}

export interface EnvironmentBuildScope {
  organizationId: string;
  transferGeneration: string;
}
export type EnvironmentBuildAttempt = EnvironmentBuildScope & {
  projectId: string; provider: string; digest: string; buildId: string;
};

/** Serialize build admission/completion with transfer cutover across gateways.
 * No transaction is held while the provider builds the artifact. */
function buildTransaction<T>(store: Store, projectId: string, work: () => T): T {
  store.db.exec('BEGIN IMMEDIATE');
  try {
    if (store.db.dialect === 'postgres')
      store.db.prepare('SELECT id FROM projects WHERE id=? FOR UPDATE').get(projectId);
    const result = work();
    store.db.exec('COMMIT');
    return result;
  } catch (error) { store.db.exec('ROLLBACK'); throw error; }
}
function sameBuildScope(store: Store, projectId: string, scope: EnvironmentBuildScope): boolean {
  return store.getProject(projectId)?.organizationId === scope.organizationId
    && (store.kvGet(`project-transfer-current:${projectId}`) ?? '') === scope.transferGeneration;
}

export function beginEnvironmentBuild(store: Store, projectId: string, scope: EnvironmentBuildScope,
  provider: string, digest: string): EnvironmentBuildAttempt {
  return buildTransaction(store, projectId, () => {
    store.assertProjectOrganization(projectId, scope.organizationId);
    if (!sameBuildScope(store, projectId, scope)) throw new Error('Project moved while preparing the build. Reload and retry.');
    const environments = new ProjectEnvironment(store);
    if (environments.builds(projectId).some(b => b.provider === provider && b.digest === digest && b.status === 'building'))
      throw new Error('This environment is already building. Wait for it to finish.');
    const attempt = { ...scope, projectId, provider, digest, buildId: crypto.randomUUID() };
    environments.recordBuild(projectId, { ...scope, provider, digest, buildId: attempt.buildId, status: 'building' });
    return attempt;
  });
}

/** Success and failure use the same fence. A deleted/superseded attempt cannot
 * recreate build metadata or overwrite a newer destination build. */
export function finishEnvironmentBuild(store: Store, attempt: EnvironmentBuildAttempt,
  result: { status: 'ready'; ref: string } | { status: 'failed'; error: string }): boolean {
  return buildTransaction(store, attempt.projectId, () => {
    if (!sameBuildScope(store, attempt.projectId, attempt)) return false;
    const environments = new ProjectEnvironment(store);
    const current = environments.builds(attempt.projectId).find(b => b.provider === attempt.provider && b.digest === attempt.digest);
    if (current?.status !== 'building' || current.buildId !== attempt.buildId) return false;
    const { projectId, ...record } = attempt;
    environments.recordBuild(projectId, { ...record, ...result });
    return true;
  });
}

export interface EnvironmentProposal {
  spec: ProjectEnvironmentSpec;
  evidence: string[];
  composeFiles: string[];
}

export function proposeEnvironment(dirs: string[], options: { hasPerWorldServices?: boolean } = {}): EnvironmentProposal {
  const proposal: EnvironmentProposal = { spec: {}, evidence: [], composeFiles: [] };
  const setup: string[] = [];
  for (const dir of dirs) {
    const devcontainer = readDevcontainer(dir);
    if (devcontainer) {
      if (devcontainer.image && !proposal.spec.image) {
        proposal.spec.image = devcontainer.image;
        proposal.evidence.push(`image ${devcontainer.image} (${devcontainer.source})`);
      }
      for (const command of devcontainer.setup) if (!setup.includes(command)) {
        setup.push(command);
        proposal.evidence.push(`setup "${command}" (${devcontainer.source})`);
      }
      for (const compose of devcontainer.composeFiles) {
        const resolved = path.join(dir, compose);
        if (fs.existsSync(resolved)) proposal.composeFiles.push(resolved);
      }
    }
    for (const [file, command] of LOCKFILES) if (fs.existsSync(path.join(dir, file)) && !setup.includes(command)) {
      setup.push(command);
      proposal.evidence.push(`setup "${command}" (${file})`);
    }
  }
  if (setup.length) proposal.spec.setup = setup;
  if (options.hasPerWorldServices) {
    proposal.spec.includeDocker = true;
    proposal.evidence.push('Docker baked in (per-world services discovered)');
  }
  return proposal;
}

const LOCKFILES: Array<[string, string]> = [
  ['pnpm-lock.yaml', 'corepack enable && pnpm install --frozen-lockfile'],
  ['yarn.lock', 'corepack enable && yarn install --frozen-lockfile'],
  ['package-lock.json', 'npm ci'],
  ['uv.lock', 'uv sync'],
  ['requirements.txt', 'pip install -r requirements.txt'],
  ['Cargo.lock', 'cargo fetch'],
  ['go.sum', 'go mod download'],
];

export interface DevcontainerInfo {
  source: string;
  image?: string;
  setup: string[];
  composeFiles: string[];
}

export function readDevcontainer(dir: string): DevcontainerInfo | undefined {
  for (const candidate of ['.devcontainer/devcontainer.json', '.devcontainer.json']) {
    const filename = path.join(dir, candidate);
    if (!fs.existsSync(filename)) continue;
    try {
      const parsed = parseDevcontainer(fs.readFileSync(filename, 'utf8'));
      return { ...parsed, source: candidate,
        composeFiles: parsed.composeFiles.map((value) => path.join(path.dirname(candidate), value)) };
    } catch { return undefined; }
  }
  return undefined;
}

export function parseDevcontainer(text: string): Omit<DevcontainerInfo, 'source'> {
  const doc = JSON.parse(stripJsonComments(text)) as Record<string, unknown>;
  const commands = (value: unknown): string[] => {
    if (typeof value === 'string') return [value];
    if (Array.isArray(value)) return [value.map(shellQuote).join(' ')];
    if (value && typeof value === 'object') return Object.values(value).flatMap(commands);
    return [];
  };
  const composeFiles = typeof doc.dockerComposeFile === 'string' ? [doc.dockerComposeFile]
    : Array.isArray(doc.dockerComposeFile) ? doc.dockerComposeFile.map(String) : [];
  return {
    ...(typeof doc.image === 'string' && doc.image ? { image: doc.image } : {}),
    setup: [...commands(doc.onCreateCommand), ...commands(doc.postCreateCommand)],
    composeFiles,
  };
}

/**
 * Turn JSONC (what a `devcontainer.json` actually is) into strict JSON.
 *
 * The scanner is string-aware throughout, INCLUDING the trailing-comma pass. That
 * pass used to be a single `text.replace(/,\s*([}\]])/g, '$1')` over the finished
 * document, which cannot see string boundaries: a perfectly ordinary command such
 * as `"postCreateCommand": "npm i --workspaces, [dev]"` had characters deleted
 * out of the middle of the string, and the container then ran a mangled command
 * (or the JSON silently changed meaning). Commas are now dropped only where the
 * scanner knows it is outside a string.
 */
export function stripJsonComments(text: string): string {
  let out = '';
  let inString = false;
  /** Drop a just-emitted trailing comma when a `}`/`]` closes outside a string. */
  const closeStructure = (ch: string) => {
    let end = out.length;
    while (end > 0 && /\s/.test(out[end - 1]!)) end--;
    if (end > 0 && out[end - 1] === ',') out = out.slice(0, end - 1) + out.slice(end);
    out += ch;
  };
  for (let index = 0; index < text.length; index++) {
    const pair = text.slice(index, index + 2);
    if (inString) {
      out += text[index];
      if (text[index] === '\\') { out += text[++index] ?? ''; continue; }
      if (text[index] === '"') inString = false;
    } else if (text[index] === '"') { inString = true; out += text[index]; }
    else if (pair === '//') { while (index < text.length && text[index] !== '\n') index++; out += '\n'; }
    else if (pair === '/*') { index += 2; while (index < text.length && text.slice(index, index + 2) !== '*/') index++; index++; }
    else if (text[index] === '}' || text[index] === ']') closeStructure(text[index]!);
    else out += text[index];
  }
  return out;
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:=@%^,+-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}
