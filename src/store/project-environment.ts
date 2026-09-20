import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { EnvironmentBuildRecord, ProjectEnvironmentSpec } from '../domain/types.js';

const KV_SPEC = 'project-environment:';
const KV_BUILDS = 'project-environment-builds:';

export interface ProjectEnvironmentStore {
  transaction<T>(operation: () => Promise<T>): Promise<T>;
  kvGet(key: string): (string | undefined) | Promise<string | undefined>;
  kvSet(key: string, value: string): (void) | Promise<void>;
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
    const clean: ProjectEnvironmentSpec = {
      ...(spec.image?.trim() ? { image: spec.image.trim() } : {}),
      ...(spec.setup?.length ? { setup: spec.setup.map((value) => value.trim()).filter(Boolean) } : {}),
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
    try { return JSON.parse((await this.store.kvGet(KV_BUILDS + projectId)) ?? '[]') as EnvironmentBuildRecord[]; }
    catch { return []; }
  }

  async recordBuild(projectId: string, value: Omit<EnvironmentBuildRecord, 'createdAt' | 'updatedAt'>): Promise<EnvironmentBuildRecord> {
    return this.store.transaction(async () => {
      const builds = await this.builds(projectId);
      const prior = builds.find((candidate) => candidate.provider === value.provider && candidate.digest === value.digest);
      const next = { ...value, createdAt: prior?.createdAt ?? Date.now(), updatedAt: Date.now() };
      await this.store.kvSet(KV_BUILDS + projectId, JSON.stringify([
        ...builds.filter((candidate) => candidate.provider !== value.provider || candidate.digest !== value.digest), next,
      ]));
      return next;
    });
  }

  async readyBuild(projectId: string, provider: string, digest: string): Promise<EnvironmentBuildRecord | undefined> {
    const record = (await this.builds(projectId)).find((candidate) =>
      candidate.provider === provider && candidate.digest === digest);
    return record?.status === 'ready' && record.ref ? record : undefined;
  }
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
