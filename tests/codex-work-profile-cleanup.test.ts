import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { codexWorkProfile, sweepCodexWorkProfiles, sweepWorkProfiles } from '../src/agent/work-environment.js';
import { ConfigHomeManager } from '../src/autonomy/config-homes.js';
import { processStartTick } from '../src/util/processes.js';

it('removes profiles whose owner died while preserving a live turn profile', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-work-profile-'));
  const stale = path.join(home, `karmax-work-2147483647-${crypto.randomUUID()}.config.toml`);
  const live = path.join(home, `karmax-work-${process.pid}-${crypto.randomUUID()}.config.toml`);
  fs.writeFileSync(stale, 'secret'); fs.writeFileSync(live, 'secret');
  const kill = vi.spyOn(process, 'kill').mockImplementation(pid => {
    if (pid === 2147483647) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
    return true;
  });
  try {
    const profile = codexWorkProfile({ secretEnv: { APP_TOKEN: 'test' }, resolvedAuth: { configHome: home } } as any);
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(live)).toBe(true);
    profile.cleanup();
    expect(fs.readdirSync(home)).toEqual([path.basename(live)]);
  } finally { kill.mockRestore(); fs.rmSync(home, { recursive: true, force: true }); }
});

const ownerTag = (tick: string) => crypto.createHash('sha256').update(tick).digest('hex').slice(0, 12);

// A pid alone does not identify a process: once the owner dies its pid can be
// reused, and the dead turn's secrets would then be kept indefinitely (RT-30b).
it('names a profile after its owner process and reaps one whose pid was recycled', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-work-profile-'));
  const recycled = path.join(home, `karmax-work-${process.pid}-${ownerTag('another start')}-${crypto.randomUUID()}.config.toml`);
  fs.writeFileSync(recycled, 'secret');
  try {
    const profile = codexWorkProfile({ secretEnv: { APP_TOKEN: 'test' }, resolvedAuth: { configHome: home } } as any);
    expect(fs.existsSync(recycled)).toBe(false);
    const [own] = fs.readdirSync(home);
    expect(own).toMatch(new RegExp(`^karmax-work-${process.pid}-${ownerTag(processStartTick(process.pid)!)}-[a-f0-9-]{36}\\.config\\.toml$`));
    expect(profile.args).toEqual(['--profile', own!.replace(/\.config\.toml$/, '')]);
    // The live owner's own profile survives another turn's sweep.
    const second = codexWorkProfile({ secretEnv: { APP_TOKEN: 'test' }, resolvedAuth: { configHome: home } } as any);
    expect(fs.readdirSync(home)).toContain(own);
    second.cleanup(); profile.cleanup();
    expect(fs.readdirSync(home)).toEqual([]);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

// Profiles from before owners were recorded name no process; a turn never
// lasts a day, so one that old has no live owner.
it('reaps unowned profiles from older releases once they are a day old', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-work-profile-'));
  const old = path.join(home, `karmax-work-${crypto.randomUUID()}.config.toml`);
  const recent = path.join(home, `karmax-work-${crypto.randomUUID()}.config.toml`);
  const unrelated = path.join(home, 'config.toml');
  for (const file of [old, recent, unrelated]) fs.writeFileSync(file, 'secret');
  const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000);
  fs.utimesSync(old, twoDaysAgo, twoDaysAgo);
  try {
    expect(sweepCodexWorkProfiles(home)).toBe(1);
    expect(fs.readdirSync(home).sort()).toEqual([path.basename(recent), 'config.toml'].sort());
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

// A home no turn uses again kept a crashed turn's secrets until the next turn
// in that same home; boot now sweeps every Codex home.
it('sweeps the profiles of dead owners from every Codex home at boot', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-work-homes-'));
  const personal = path.join(root, 'codex-alice');
  const organization = path.join(root, 'organizations', 'org_team', 'codex-bob');
  const claude = path.join(root, 'claude-carol');
  for (const dir of [personal, organization, claude]) fs.mkdirSync(dir, { recursive: true });
  const dead = (dir: string) => {
    const file = path.join(dir, `karmax-work-2147483647-${ownerTag('gone')}-${crypto.randomUUID()}.config.toml`);
    fs.writeFileSync(file, 'secret');
    return file;
  };
  const standalone = path.join(root, 'codex-home');
  fs.mkdirSync(standalone);
  vi.stubEnv('CODEX_HOME', standalone);
  const files = [dead(personal), dead(organization), dead(standalone)];
  const untouched = dead(claude);
  const kill = vi.spyOn(process, 'kill').mockImplementation(pid => {
    if (pid === 2147483647) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
    return true;
  });
  try {
    expect(sweepWorkProfiles(new ConfigHomeManager(root))).toBe(3);
    for (const file of files) expect(fs.existsSync(file)).toBe(false);
    expect(fs.existsSync(untouched)).toBe(true);
  } finally { kill.mockRestore(); vi.unstubAllEnvs(); fs.rmSync(root, { recursive: true, force: true }); }
});
