import { ProjectSecret } from '../domain/types.js';
import { CredentialBroker } from './broker.js';
import { worldRelativePath } from '../world/types.js';

/**
 * Project runtime secrets (PLAN-state.md §3.1): the .env-shaped values a
 * project's OWN code reads, as a first-class vault-backed record set — the
 * replacement for copying gitignored files with `copyGlobs`.
 *
 * Exactly the git-profiles split: the registry (names + presentation shape)
 * lives in the store's kv table per project; the values live in the vault under
 * `secret:<projectId>:<name>` and are resolved JIT by the broker at the
 * injection boundary — never written to project config, never journaled.
 */

const KV_PREFIX = 'project-secrets:';

/** The vault handle for one project secret. */
export function secretHandle(projectId: string, name: string): string {
  return `secret:${projectId}:${name}`;
}

export interface ProjectSecretsStore {
  kvGet(k: string): string | undefined;
  kvSet(k: string, v: string): void;
}

/** A file-shaped secret resolved for materialization into one world. */
export interface ResolvedFileSecret {
  path: string;
  mode: number;
  value: string;
}

export class ProjectSecrets {
  constructor(
    private store: ProjectSecretsStore,
    private broker?: CredentialBroker,
  ) {}

  list(projectId: string): ProjectSecret[] {
    const raw = this.store.kvGet(KV_PREFIX + projectId);
    if (!raw) return [];
    try {
      return JSON.parse(raw) as ProjectSecret[];
    } catch {
      return [];
    }
  }

  get(projectId: string, name: string): ProjectSecret | undefined {
    return this.list(projectId).find((s) => s.name === name);
  }

  /**
   * Create/update a secret. The value is write-only: a provided non-empty
   * string goes to the vault; absent/empty keeps the stored one (shape edits
   * don't force re-pasting). A brand-new secret must bring a value.
   */
  save(projectId: string, args: { name: string; value?: string; file?: string; mode?: number }): ProjectSecret {
    const name = args.name.trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error('secret name must be env-var-shaped (letters, digits, _)');
    const prior = this.get(projectId, name);
    if (args.value?.length) this.requireBroker().registerHandle(secretHandle(projectId, name), args.value);
    else if (!prior) throw new Error(`secret ${name} has no stored value — provide one`);
    const rec: ProjectSecret = { name };
    const file = args.file?.trim();
    if (file) {
      rec.file = worldRelativePath(file);
      if (rec.file === '.') throw new Error('secret file path must name a file');
      if (args.mode != null) rec.mode = args.mode;
    }
    const rest = this.list(projectId).filter((s) => s.name !== name);
    this.store.kvSet(KV_PREFIX + projectId, JSON.stringify([...rest, rec]));
    return rec;
  }

  delete(projectId: string, name: string) {
    this.store.kvSet(KV_PREFIX + projectId, JSON.stringify(this.list(projectId).filter((s) => s.name !== name)));
    this.broker?.deleteHandle(secretHandle(projectId, name));
  }

  /** Import a pasted .env in one step (PLAN-state §3.1). Returns the names saved. */
  importEnv(projectId: string, text: string): string[] {
    const entries = parseEnv(text);
    if (!entries.length) throw new Error('no KEY=value lines found');
    return entries.map((e) => this.save(projectId, { name: e.name, value: e.value }).name);
  }

  /** JIT env for one subprocess in one of this project's worlds: every
   * env-shaped secret, resolved through the broker (audited). Values live only
   * in the spawned process environment — nothing lands in a file or the journal. */
  env(projectId: string, ctx: { taskId?: string }): Record<string, string> {
    const env: Record<string, string> = {};
    for (const s of this.list(projectId)) {
      if (s.file) continue;
      env[s.name] = this.resolveSecret(projectId, s.name, ctx);
    }
    return env;
  }

  /** Names of the env-shaped secrets (the non-secret half of the manifest). */
  envNames(projectId: string): string[] {
    return this.list(projectId).filter((s) => !s.file).map((s) => s.name);
  }

  /** File-shaped secrets resolved for materialization into a freshly created
   * world. The caller writes them 0600 + git-excluded and records the returned
   * paths on the world handle as the materialization manifest. */
  files(projectId: string, ctx: { taskId?: string }): ResolvedFileSecret[] {
    return this.list(projectId)
      .filter((s): s is ProjectSecret & { file: string } => Boolean(s.file))
      .map((s) => ({ path: s.file, mode: s.mode ?? 0o600, value: this.resolveSecret(projectId, s.name, ctx) }));
  }

  private resolveSecret(projectId: string, name: string, ctx: { taskId?: string }): string {
    return this.requireBroker().resolve(secretHandle(projectId, name), { taskId: ctx.taskId, caps: [`use-credential:secret:${projectId}:*`] });
  }

  private requireBroker(): CredentialBroker {
    if (!this.broker) throw new Error('project secrets: no credential broker configured');
    return this.broker;
  }
}

/** Parse .env text: KEY=value lines, optional `export `, quotes, # comments. */
export function parseEnv(text: string): Array<{ name: string; value: string }> {
  const out: Array<{ name: string; value: string }> = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let value = m[2]!.trim();
    if ((value.startsWith('"') && value.endsWith('"') && value.length >= 2)
      || (value.startsWith("'") && value.endsWith("'") && value.length >= 2)) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, ''); // unquoted trailing comment
    if (!value) continue; // a blank value is a template line (.env.example), not a secret
    out.push({ name: m[1]!, value });
  }
  return out;
}
