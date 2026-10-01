import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { environmentArtifactName } from '../util/environment-artifact.js';
import type { Store } from './db.js';
import type { EnvironmentBuildRecord, ProjectEnvironmentSpec } from '../domain/types.js';

const KV_SPEC = 'project-environment:';
const KV_BUILDS = 'project-environment-builds:';
const recoveryKey = (projectId: string, provider: string, digest: string) =>
  `environment-build-recovery:${projectId}:${provider}:${digest}`;
export const environmentBuildRevision = (build: EnvironmentBuildRecord): string =>
  crypto.createHash('sha256').update(JSON.stringify(build)).digest('hex');

export interface ProjectEnvironmentStore {
  transaction<T>(operation: () => Promise<T>): Promise<T>;
  kvGet(key: string): (string | undefined) | Promise<string | undefined>;
  kvSet(key: string, value: string): (void) | Promise<void>;
  getProject?: Store['getProject'];
}

export class ProjectEnvironment {
  constructor(private store: ProjectEnvironmentStore) {}

  async spec(projectId: string): Promise<ProjectEnvironmentSpec | undefined> {
    const raw = (await this.store.kvGet(KV_SPEC + projectId));
    if (!raw) return undefined;
    try {
      const parsed = JSON.parse(raw) as ProjectEnvironmentSpec;
      return Object.keys(parsed).length ? parsed : undefined;
    } catch { return undefined; }
  }

  async setSpec(projectId: string, spec: ProjectEnvironmentSpec): Promise<ProjectEnvironmentSpec> {
    const installs = Object.entries(spec.install ?? {})
      .map(([name, commands]) => [name.trim(), commands.map((value) => value.trim()).filter(Boolean)] as const)
      .filter(([name, commands]) => name && commands.length);
    const install = installs.length ? Object.fromEntries(installs) : undefined;
    const clean: ProjectEnvironmentSpec = {
      ...(spec.image?.trim() ? { image: spec.image.trim() } : {}),
      ...(spec.setup?.length ? { setup: spec.setup.map((value) => value.trim()).filter(Boolean) } : {}),
      ...(install ? { install } : {}),
      ...(spec.boot?.length ? { boot: spec.boot.map((value) => value.trim()).filter(Boolean) } : {}),
      ...(spec.includeDocker ? { includeDocker: true } : {}),
    };
    (await this.store.kvSet(KV_SPEC + projectId, JSON.stringify(clean)));
    return clean;
  }

  digest(spec: ProjectEnvironmentSpec): string {
    return crypto.createHash('sha256').update(JSON.stringify({
      image: spec.image ?? '', setup: spec.setup ?? [], docker: !!spec.includeDocker,
    })).digest('hex').slice(0, 16);
  }

  async builds(projectId: string): Promise<EnvironmentBuildRecord[]> {
    const raw = await this.store.kvGet(KV_BUILDS + projectId);
    try { return JSON.parse(raw ?? '[]') as EnvironmentBuildRecord[]; }
    catch { return []; }
  }

  async recordBuild(projectId: string, value: Omit<EnvironmentBuildRecord, 'createdAt' | 'updatedAt'>): Promise<EnvironmentBuildRecord> {
    return this.store.transaction(async () => {
      const builds = await this.builds(projectId);
      const prior = builds.find((candidate) => candidate.provider === value.provider && candidate.digest === value.digest);
      const next = { ...value, createdAt: prior?.createdAt ?? Date.now(), updatedAt: Date.now() };
      // A recovered build cannot be replaced by a pre-upgrade unscoped callback.
      if (!value.buildId && await this.store.kvGet(recoveryKey(projectId, value.provider, value.digest))) return next;
      await this.store.kvSet(KV_BUILDS + projectId, JSON.stringify([
        ...builds.filter((candidate) => candidate.provider !== value.provider || candidate.digest !== value.digest), next,
      ]));
      return next;
    });
  }

  /** With `base`, a build made on any other provider template is not ready. */
  async readyBuild(projectId: string, provider: string, digest: string, base?: string): Promise<EnvironmentBuildRecord | undefined> {
    const record = (await this.builds(projectId)).find((candidate) =>
      candidate.provider === provider && candidate.digest === digest);
    if (!record?.buildId && await this.store.kvGet(recoveryKey(projectId, provider, digest))) return undefined;
    const generation = await this.store.kvGet(`project-transfer-current:${projectId}`);
    // Legacy unscoped builds are usable only before the first transfer. Never
    // let a late legacy callback recreate selectable source-owned artifacts.
    if (record?.organizationId) {
      if ((await this.store.getProject?.(projectId))?.organizationId !== record.organizationId
        || (generation ?? '') !== record.transferGeneration) return undefined;
    } else if (generation) return undefined;
    if (base !== undefined && record?.base !== base) return undefined;
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
async function buildTransaction<T>(store: Store, projectId: string, work: () => Promise<T>): Promise<T> {
  return store.transaction(async () => {
    if (store.db.dialect === 'postgres')
      await store.db.prepare('SELECT id FROM projects WHERE id=? FOR UPDATE').get(projectId);
    return work();
  });
}
async function sameBuildScope(store: Store, projectId: string, scope: EnvironmentBuildScope): Promise<boolean> {
  return (await store.getProject(projectId))?.organizationId === scope.organizationId
    && ((await store.kvGet(`project-transfer-current:${projectId}`)) ?? '') === scope.transferGeneration;
}

export async function beginEnvironmentBuild(store: Store, projectId: string, scope: EnvironmentBuildScope,
  provider: string, digest: string): Promise<EnvironmentBuildAttempt> {
  return buildTransaction(store, projectId, async () => {
    await store.assertProjectOrganization(projectId, scope.organizationId);
    if (!await sameBuildScope(store, projectId, scope)) throw new Error('Project moved while preparing the build. Reload and retry.');
    const environments = new ProjectEnvironment(store);
    if ((await environments.builds(projectId)).some(b => b.provider === provider && b.digest === digest && b.status === 'building'))
      throw new Error('This environment is already building. Wait for it to finish.');
    const attempt = { ...scope, projectId, provider, digest, buildId: crypto.randomUUID() };
    await environments.recordBuild(projectId, { ...scope, provider, digest, buildId: attempt.buildId,
      artifactName: environmentArtifactName(projectId, digest, attempt.buildId), buildHost: os.hostname(), status: 'building' });
    return attempt;
  });
}

/** Success and failure use the same fence. A deleted/superseded attempt cannot
 * recreate build metadata or overwrite a newer destination build. */
export async function finishEnvironmentBuild(store: Store, attempt: EnvironmentBuildAttempt,
  result: { status: 'ready'; ref: string; base?: string } | { status: 'failed'; error: string }): Promise<boolean> {
  return buildTransaction(store, attempt.projectId, async () => {
    if (!await sameBuildScope(store, attempt.projectId, attempt)) return false;
    const environments = new ProjectEnvironment(store);
    const current = (await environments.builds(attempt.projectId)).find(b => b.provider === attempt.provider && b.digest === attempt.digest);
    if (current?.status !== 'building' || current.buildId !== attempt.buildId) return false;
    const { projectId, ...record } = attempt;
    await environments.recordBuild(projectId, { ...current, ...record, ...result });
    return true;
  });
}

/** The operator must stop the provider operation and remove its artifact first.
 * Age alone is not proof of abandonment in a multi-gateway installation. The
 * revision binds their cleanup confirmation to exactly the record inspected. */
export async function recoverEnvironmentBuild(store: Store, projectId: string, scope: EnvironmentBuildScope,
  input: { provider: string; digest: string; revision: string; cleanupConfirmed: boolean; cleanupNote: string }, principal: string): Promise<void> {
  if (input.cleanupConfirmed !== true || !input.cleanupNote?.trim())
    throw new Error('Stop the builder and remove its provider artifacts, then confirm cleanup with a note.');
  await buildTransaction(store, projectId, async () => {
    await store.assertProjectOrganization(projectId, scope.organizationId);
    if (!await sameBuildScope(store, projectId, scope)) throw new Error('Project moved. Reload before recovering the build.');
    const environments = new ProjectEnvironment(store);
    const current = (await environments.builds(projectId)).find(b => b.provider === input.provider && b.digest === input.digest);
    if (current?.status === 'failed' && current.recoveredFrom === input.revision) return;
    if (current?.status !== 'building' || environmentBuildRevision(current) !== input.revision)
      throw new Error('The build changed. Reload and inspect the current attempt before recovering it.');
    // Keep a permanent fence for legacy callbacks, including after project
    // transfers. The attempt check also fences callbacks from other gateways.
    await environments.recordBuild(projectId, { ...current, buildId: current.buildId ?? crypto.randomUUID(),
      status: 'failed', ref: undefined, recoveredFrom: input.revision, error: 'Abandoned build invalidated after confirmed provider cleanup. Rebuild when ready.' });
    await store.kvSet(recoveryKey(projectId, input.provider, input.digest), input.revision);
    await store.appendAudit({ principalId: principal, action: 'project.environment-build.recovered', scopeKey: `project:${projectId}`,
      detail: { organizationId: scope.organizationId, transferGeneration: scope.transferGeneration,
        build: current, cleanupNote: input.cleanupNote.trim().slice(0, 2000) } });
  });
}

export async function environmentBuildIsActive(store: Store, attempt: EnvironmentBuildAttempt): Promise<boolean> {
  if (!await sameBuildScope(store, attempt.projectId, attempt)) return false;
  return (await new ProjectEnvironment(store).builds(attempt.projectId)).some(b => b.buildId === attempt.buildId && b.status === 'building');
}
export async function recordEnvironmentBuilder(store: Store, attempt: EnvironmentBuildAttempt, builderId: string): Promise<void> {
  await buildTransaction(store, attempt.projectId, async () => {
    if (!await environmentBuildIsActive(store, attempt)) throw new Error('Environment build was invalidated.');
    const environments = new ProjectEnvironment(store);
    const current = (await environments.builds(attempt.projectId)).find(b => b.buildId === attempt.buildId)!;
    await environments.recordBuild(attempt.projectId, { ...current, builderId });
  });
}

export interface EnvironmentProposal {
  spec: ProjectEnvironmentSpec;
  evidence: string[];
  composeFiles: string[];
}

/** Tracked files of one project repository, read from wherever it lives: a
 * local checkout or the GitHub API for hosted projects. */
export interface RepositoryFiles {
  /** World checkout name: the directory tasks see and the `install` key. */
  name: string;
  /** Top-level entries. A listing, because GitHub omits content above 1 MB. */
  files: string[];
  read(file: string): Promise<string | undefined>;
  /** Local checkout, when there is one (Compose discovery needs real paths). */
  dir?: string;
}

export function localRepositoryFiles(dir: string, name: string): RepositoryFiles {
  let files: string[] = [];
  try { files = fs.readdirSync(dir); } catch { /* an unreadable checkout proposes nothing */ }
  return { name, dir, files, read: async (file) => {
    try { return fs.readFileSync(path.join(dir, file), 'utf8'); } catch { return undefined; }
  } };
}

export async function proposeEnvironment(repos: RepositoryFiles[], options: { hasPerWorldServices?: boolean } = {}): Promise<EnvironmentProposal> {
  const proposal: EnvironmentProposal = { spec: {}, evidence: [], composeFiles: [] };
  const install: Record<string, string[]> = {};
  for (const repo of repos) {
    const commands: string[] = [];
    const add = (command: string, source: string) => {
      if (commands.includes(command)) return;
      commands.push(command);
      proposal.evidence.push(`${repo.name}: "${command}" (${source})`);
    };
    const devcontainer = await readDevcontainer(repo);
    if (devcontainer) {
      if (devcontainer.image && !proposal.spec.image) {
        proposal.spec.image = devcontainer.image;
        proposal.evidence.push(`image ${devcontainer.image} (${repo.name}/${devcontainer.source})`);
      }
      for (const command of devcontainer.commands) add(command, devcontainer.source);
      if (repo.dir) for (const compose of devcontainer.composeFiles) {
        const resolved = path.join(repo.dir, compose);
        if (fs.existsSync(resolved)) proposal.composeFiles.push(resolved);
      }
    }
    for (const [file, command] of LOCKFILES) if (repo.files.includes(file)) add(command, file);
    const browsers = await playwrightBrowserInstall(repo);
    if (browsers) add(browsers.command, browsers.source);
    if (commands.length) install[repo.name] = commands;
  }
  if (Object.keys(install).length) proposal.spec.install = install;
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

/** Playwright pins a browser build per release and downloads it separately from
 * the package, so a dependency install alone leaves its tests unable to launch.
 * The repository's own Playwright performs the download, so the browser always
 * matches the checked-out version. Chromium only: it is what nearly every
 * suite uses, and all three engines would triple the download. */
async function playwrightBrowserInstall(repo: RepositoryFiles): Promise<{ command: string; source: string } | undefined> {
  const flags = 'install --with-deps chromium';
  if (repo.files.includes('package.json')) {
    try {
      const manifest = JSON.parse(await repo.read('package.json') ?? '{}');
      const names = { ...manifest.dependencies, ...manifest.devDependencies };
      if ('playwright' in names || '@playwright/test' in names) return { command: `npx playwright ${flags}`, source: 'package.json' };
    } catch { /* malformed manifests propose nothing */ }
  }
  // pytest-playwright, playwright-stealth, … all pull in Playwright itself.
  const python = /^\s*["']?[\w.-]*playwright/m;
  if (repo.files.includes('uv.lock') && repo.files.includes('pyproject.toml') && python.test(await repo.read('pyproject.toml') ?? ''))
    return { command: `uv run playwright ${flags}`, source: 'pyproject.toml' };
  if (repo.files.includes('requirements.txt') && python.test(await repo.read('requirements.txt') ?? ''))
    return { command: `python -m playwright ${flags}`, source: 'requirements.txt' };
  return undefined;
}

export interface DevcontainerInfo {
  source: string;
  image?: string;
  /** onCreate/postCreate commands; they run in the checked-out workspace. */
  commands: string[];
  composeFiles: string[];
}

export async function readDevcontainer(repo: RepositoryFiles): Promise<DevcontainerInfo | undefined> {
  for (const candidate of ['.devcontainer/devcontainer.json', '.devcontainer.json']) {
    if (!repo.files.includes(candidate.split('/')[0]!)) continue;
    const text = await repo.read(candidate);
    if (text === undefined) continue;
    try {
      const parsed = parseDevcontainer(text);
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
    commands: [...commands(doc.onCreateCommand), ...commands(doc.postCreateCommand)],
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
