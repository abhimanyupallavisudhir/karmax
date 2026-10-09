import fs from 'node:fs';
import path from 'node:path';
import { CliError, EXIT } from './util.js';

/** What the server describes (GET /api/{projects,tasks}/:id/workspace). */
export interface Manifest {
  version: 1;
  organization: { id: string; name: string; slug?: string };
  project: { id: string; name: string };
  task?: { id: string; number?: number; title: string; status?: string; waitingFor?: string };
  directory: string;
  workdir: string;
  repositories: Array<{ name: string; role: 'development' | 'project-wiki'; sshUrl: string; branch: string; base?: string; target?: string }>;
  resources: Array<{ id: string; name: string; driver: string; path: string; shape: 'file' | 'directory'; access: 'read' | 'write';
    revisionId?: string; bytes?: number; files?: number; transferable: boolean }>;
  secrets: Array<{ id: string; name: string; variable?: string; file?: string; dotenv?: string; configured: boolean }>;
  install: Array<{ repository: string; commands: string[] }>;
}

/** Each file's size and mtime when a resource was last pulled or pushed:
 * how `status` sees local edits without the network (restic's own test). */
export type Fingerprint = Record<string, [number, number]>;

export interface ResourceState { revisionId?: string; snapshot?: string; fingerprint?: Fingerprint }

interface State {
  version: 1;
  server: string;
  manifest: Manifest;
  resources: Record<string, ResourceState>;
  /** Secret files written by `pull`, by path, with what was written (sha256). */
  secretFiles: Record<string, string>;
  /** Git reaches GitHub through `tavya git-credential` (clone --git-via-tavya). */
  gitViaTavya?: boolean;
}

const DIR = '.tavya';

/** A local world: `<root>/.tavya/workspace.json`, never inside a repository. */
export class Workspace {
  private constructor(readonly root: string, private state: State) {}

  static find(from = process.cwd()): Workspace | undefined {
    let dir = path.resolve(from);
    for (;;) {
      const file = path.join(dir, DIR, 'workspace.json');
      if (fs.existsSync(file)) {
        const state = JSON.parse(fs.readFileSync(file, 'utf8')) as State;
        return new Workspace(dir, state);
      }
      const parent = path.dirname(dir);
      if (parent === dir) return undefined;
      dir = parent;
    }
  }

  static require(from?: string): Workspace {
    const found = Workspace.find(from);
    if (!found) throw new CliError('not in a tavya workspace; run `tavya clone <organization>/<project>` first', EXIT.usage);
    return found;
  }

  static create(root: string, server: string, manifest: Manifest): Workspace {
    fs.mkdirSync(path.join(root, DIR), { recursive: true });
    fs.writeFileSync(path.join(root, DIR, '.gitignore'), '*\n');
    const workspace = new Workspace(root, { version: 1, server, manifest, resources: {}, secretFiles: {} });
    workspace.save();
    return workspace;
  }

  get server(): string { return this.state.server; }
  get manifest(): Manifest { return this.state.manifest; }
  set manifest(value: Manifest) { this.state.manifest = value; }
  get workdir(): string { return path.join(this.root, this.state.manifest.workdir); }

  get gitViaTavya(): boolean { return Boolean(this.state.gitViaTavya); }
  set gitViaTavya(value: boolean) { this.state.gitViaTavya = value; this.save(); }

  resource(id: string): ResourceState { return this.state.resources[id] ?? {}; }
  setResource(id: string, value: ResourceState): void { this.state.resources[id] = value; this.save(); }
  secretFiles(): Record<string, string> { return this.state.secretFiles; }
  setSecretFile(relative: string, digest: string | undefined): void {
    if (digest) this.state.secretFiles[relative] = digest; else delete this.state.secretFiles[relative];
    this.save();
  }

  /** Where the manifest names a path (relative to the root, `/`-separated). */
  path(relative: string): string { return path.join(this.root, ...relative.split('/')); }

  /** The repository a path lies in, if any. */
  repositoryOf(relative: string): Manifest['repositories'][number] | undefined {
    const first = relative.split('/')[0];
    return this.state.manifest.repositories.find((repository) => repository.name === first);
  }

  save(): void {
    const file = path.join(this.root, DIR, 'workspace.json');
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(this.state, null, 2)}\n`);
    fs.renameSync(temporary, file);
  }

  /** A scratch directory inside the workspace (same filesystem as targets). */
  scratch(name: string): string {
    const dir = path.join(this.root, DIR, 'tmp', `${name}-${process.pid}-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** The API path of the workspace's project or task. */
  get apiBase(): string {
    return this.state.manifest.task ? `/api/tasks/${encodeURIComponent(this.state.manifest.task.id)}`
      : `/api/projects/${encodeURIComponent(this.state.manifest.project.id)}`;
  }
}

/** Every file under `target` (or `target` itself), by `/`-path relative to it. */
export function fingerprint(target: string): Fingerprint {
  const result: Fingerprint = {};
  let stat: fs.Stats;
  try { stat = fs.statSync(target); } catch { return result; }
  if (stat.isFile()) { result['.'] = [stat.size, Math.floor(stat.mtimeMs)]; return result; }
  const walk = (dir: string, prefix: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!prefix && (entry.name === '.git' || entry.name === '.karmax-injection')) continue;
      const full = path.join(dir, entry.name);
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(full, relative);
      else if (entry.isFile() || entry.isSymbolicLink()) {
        const info = fs.statSync(full, { throwIfNoEntry: false });
        if (info) result[relative] = [info.size, Math.floor(info.mtimeMs)];
      }
    }
  };
  walk(target, '');
  return result;
}

/** Files added, changed and deleted between two fingerprints. */
export function compareFingerprints(before: Fingerprint, after: Fingerprint): { added: string[]; modified: string[]; deleted: string[] } {
  const added: string[] = []; const modified: string[] = []; const deleted: string[] = [];
  for (const [file, value] of Object.entries(after)) {
    const old = before[file];
    if (!old) added.push(file);
    else if (old[0] !== value[0] || old[1] !== value[1]) modified.push(file);
  }
  for (const file of Object.keys(before)) if (!after[file]) deleted.push(file);
  return { added, modified, deleted };
}
