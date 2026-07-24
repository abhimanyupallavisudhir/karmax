import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

/**
 * The data home. SPEC §1: `~/.karmax/` holds workflow repos, agent config
 * homes, prompt/skill content, and local state. Overridable via KARMAX_HOME
 * (tests point this at a temp dir).
 */
export function karmaxHome(): string {
  return process.env.KARMAX_HOME ?? path.join(os.homedir(), '.karmax');
}

export interface KarmaxPaths {
  home: string;
  workflows: string; // ~/.karmax/workflows/<name>/  (git repos)
  worlds: string; // worktrees / scratch repos
  localCheckouts: string; // durable human checkouts materialized from cloud task branches
  configHomes: string; // per-(account×profile) CODEX_HOME/CLAUDE_CONFIG_DIR
  content: string; // prompts/skills/memory content store
  state: string; // local sqlite + json state
  vault: string; // credential broker storage
  temporal: string; // temporal dev-server db
  overlays: string; // user/project overlays (safe-mode resolution)
  attachments: string; // content-addressed user image attachments (image prompts)
  objects: string; // encrypted checkpoints, project resources, and promoted artifacts
  backups: string; // operator-created, integrity-checked control-plane snapshots
}

export function paths(home = karmaxHome()): KarmaxPaths {
  return {
    home,
    workflows: path.join(home, 'workflows'),
    worlds: path.join(home, 'worlds'),
    localCheckouts: path.join(home, 'local-checkouts'),
    configHomes: path.join(home, 'config-homes'),
    content: path.join(home, 'content'),
    state: path.join(home, 'state'),
    vault: path.join(home, 'vault'),
    temporal: path.join(home, 'temporal'),
    overlays: path.join(home, 'overlays'),
    attachments: path.join(home, 'attachments'),
    objects: path.join(home, 'objects'),
    backups: path.join(home, 'backups'),
  };
}

/** Ensure every karmax directory exists. Idempotent. */
export function ensurePaths(home = karmaxHome()): KarmaxPaths {
  const p = paths(home);
  for (const dir of Object.values(p)) fs.mkdirSync(dir, { recursive: true });
  return p;
}
