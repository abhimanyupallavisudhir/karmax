import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { EnvironmentBuildRecord, ProjectEnvironmentSpec } from '../domain/types.js';

/**
 * The environment registry (PLAN-cloud "prepare an environment once, not on
 * every task"): the spec is the project's derivation recipe; builds are the
 * immutable per-provider artifacts realized from it (src/world/
 * environment-build.ts). Proposals come from what the repo already declares —
 * devcontainer.json, lockfiles, docker-compose — never from a questionnaire.
 */

const KV_SPEC = 'project-environment:';
const KV_BUILDS = 'project-environment-builds:';

export interface ProjectEnvironmentStore {
  kvGet(k: string): string | undefined;
  kvSet(k: string, v: string): void;
}

export class ProjectEnvironment {
  constructor(private store: ProjectEnvironmentStore) {}

  spec(projectId: string): ProjectEnvironmentSpec | undefined {
    const raw = this.store.kvGet(KV_SPEC + projectId);
    if (!raw) return undefined;
    try {
      const parsed = JSON.parse(raw) as ProjectEnvironmentSpec;
      return Object.keys(parsed).length ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  setSpec(projectId: string, spec: ProjectEnvironmentSpec): ProjectEnvironmentSpec {
    const clean: ProjectEnvironmentSpec = {
      ...(spec.image?.trim() ? { image: spec.image.trim() } : {}),
      ...(spec.setup?.length ? { setup: spec.setup.map((c) => c.trim()).filter(Boolean) } : {}),
      ...(spec.boot?.length ? { boot: spec.boot.map((c) => c.trim()).filter(Boolean) } : {}),
      ...(spec.includeDocker ? { includeDocker: true } : {}),
    };
    this.store.kvSet(KV_SPEC + projectId, JSON.stringify(clean));
    return clean;
  }

  /** Digest of the build-relevant half; `boot` runs per world and never
   * invalidates a build. */
  digest(spec: ProjectEnvironmentSpec): string {
    return crypto.createHash('sha256')
      .update(JSON.stringify({ image: spec.image ?? '', setup: spec.setup ?? [], docker: !!spec.includeDocker }))
      .digest('hex').slice(0, 16);
  }

  builds(projectId: string): EnvironmentBuildRecord[] {
    const raw = this.store.kvGet(KV_BUILDS + projectId);
    if (!raw) return [];
    try {
      return JSON.parse(raw) as EnvironmentBuildRecord[];
    } catch {
      return [];
    }
  }

  /** Upsert the (provider, digest) build slot — one artifact per pair. */
  recordBuild(projectId: string, record: Omit<EnvironmentBuildRecord, 'createdAt' | 'updatedAt'>): EnvironmentBuildRecord {
    const existing = this.builds(projectId);
    const prior = existing.find((b) => b.provider === record.provider && b.digest === record.digest);
    const next: EnvironmentBuildRecord = { ...record, createdAt: prior?.createdAt ?? Date.now(), updatedAt: Date.now() };
    this.store.kvSet(KV_BUILDS + projectId, JSON.stringify([
      ...existing.filter((b) => !(b.provider === record.provider && b.digest === record.digest)), next]));
    return next;
  }

  build(projectId: string, provider: string, digest: string): EnvironmentBuildRecord | undefined {
    return this.builds(projectId).find((b) => b.provider === provider && b.digest === digest);
  }

  /** The artifact worlds of this provider should boot from right now, if any. */
  readyBuild(projectId: string, provider: string, digest: string): EnvironmentBuildRecord | undefined {
    const build = this.build(projectId, provider, digest);
    return build?.status === 'ready' && build.ref ? build : undefined;
  }
}

// ---------------------------------------------------------------------------
// Proposals: read what the repo already declares.

export interface EnvironmentProposal {
  spec: ProjectEnvironmentSpec;
  /** Where each piece came from, for the approval card. */
  evidence: string[];
  /** Compose files a devcontainer points at (feed the services importer). */
  composeFiles: string[];
}

/** Inspect checkouts and propose an environment: devcontainer.json wins for
 * the image and post-create setup; lockfiles supply dependency-install
 * commands; declared per-world services flip `includeDocker`. */
export function proposeEnvironment(dirs: string[], opts: { hasPerWorldServices?: boolean } = {}): EnvironmentProposal {
  const proposal: EnvironmentProposal = { spec: {}, evidence: [], composeFiles: [] };
  const setup: string[] = [];
  for (const dir of dirs) {
    const devcontainer = readDevcontainer(dir);
    if (devcontainer) {
      if (devcontainer.image && !proposal.spec.image) {
        proposal.spec.image = devcontainer.image;
        proposal.evidence.push(`image ${devcontainer.image} (${devcontainer.source})`);
      }
      for (const cmd of devcontainer.setup) {
        if (!setup.includes(cmd)) {
          setup.push(cmd);
          proposal.evidence.push(`setup "${cmd}" (${devcontainer.source} postCreateCommand)`);
        }
      }
      for (const compose of devcontainer.composeFiles) {
        const resolved = path.join(dir, compose);
        if (fs.existsSync(resolved)) proposal.composeFiles.push(resolved);
      }
    }
    for (const [file, cmd] of LOCKFILE_SETUP) {
      if (fs.existsSync(path.join(dir, file)) && !setup.includes(cmd)) {
        setup.push(cmd);
        proposal.evidence.push(`setup "${cmd}" (${file})`);
      }
    }
  }
  if (setup.length) proposal.spec.setup = setup;
  if (opts.hasPerWorldServices) {
    proposal.spec.includeDocker = true;
    proposal.evidence.push('Docker baked in (this project declares per-world services)');
  }
  return proposal;
}

const LOCKFILE_SETUP: Array<[string, string]> = [
  ['pnpm-lock.yaml', 'corepack enable && pnpm install --frozen-lockfile'],
  ['yarn.lock', 'corepack enable && yarn install --frozen-lockfile'],
  ['package-lock.json', 'npm ci'],
  ['uv.lock', 'uv sync'],
  ['requirements.txt', 'pip install -r requirements.txt'],
  ['Cargo.lock', 'cargo fetch'],
  ['go.sum', 'go mod download'],
];

// ---------------------------------------------------------------------------
// devcontainer.json (JSON-with-comments, both canonical locations).

export interface DevcontainerInfo {
  source: string;
  image?: string;
  setup: string[];
  composeFiles: string[];
}

export function readDevcontainer(dir: string): DevcontainerInfo | undefined {
  for (const candidate of ['.devcontainer/devcontainer.json', '.devcontainer.json']) {
    const file = path.join(dir, candidate);
    if (!fs.existsSync(file)) continue;
    try {
      const parsed = parseDevcontainer(fs.readFileSync(file, 'utf8'));
      return { ...parsed, source: candidate,
        // dockerComposeFile paths are relative to the devcontainer file itself.
        composeFiles: parsed.composeFiles.map((c) => path.join(path.dirname(candidate), c)) };
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function parseDevcontainer(text: string): Omit<DevcontainerInfo, 'source'> {
  const doc = JSON.parse(stripJsonComments(text)) as Record<string, unknown>;
  const setup: string[] = [];
  // postCreateCommand: string | string[] (argv) | { name: string | string[] }.
  const commands = (value: unknown): string[] => {
    if (typeof value === 'string') return [value];
    if (Array.isArray(value)) return [value.map(shellQuote).join(' ')];
    if (value && typeof value === 'object') return Object.values(value).flatMap(commands);
    return [];
  };
  for (const key of ['onCreateCommand', 'postCreateCommand']) setup.push(...commands(doc[key]));
  const composeFiles = typeof doc.dockerComposeFile === 'string' ? [doc.dockerComposeFile]
    : Array.isArray(doc.dockerComposeFile) ? doc.dockerComposeFile.map(String) : [];
  return {
    ...(typeof doc.image === 'string' && doc.image ? { image: doc.image } : {}),
    setup,
    composeFiles,
  };
}

/** Strip // and block comments plus trailing commas — outside strings only. */
export function stripJsonComments(text: string): string {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const two = text.slice(i, i + 2);
    if (inString) {
      out += text[i];
      if (text[i] === '\\') { out += text[i + 1] ?? ''; i++; continue; }
      if (text[i] === '"') inString = false;
      continue;
    }
    if (text[i] === '"') { inString = true; out += text[i]; continue; }
    if (two === '//') { while (i < text.length && text[i] !== '\n') i++; out += '\n'; continue; }
    if (two === '/*') { i += 2; while (i < text.length && text.slice(i, i + 2) !== '*/') i++; i++; continue; }
    out += text[i];
  }
  return out.replace(/,\s*([}\]])/g, '$1');
}

function shellQuote(part: string): string {
  return /^[A-Za-z0-9_./:=@%^,+-]+$/.test(part) ? part : `'${part.replace(/'/g, `'\\''`)}'`;
}
