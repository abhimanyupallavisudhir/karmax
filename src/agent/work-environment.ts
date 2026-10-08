import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import type { TurnInput } from './types.js';
import { isRemoteAgentWorld, preparedRemoteWorkDirectory } from './remote-process.js';
import { ensureWorldExcluded } from '../world/secret-exclude.js';
import type { ConfigHomeManager } from '../autonomy/config-homes.js';
import { processStartTick } from '../util/processes.js';
import { isEnvName } from '../util/shell.js';

/** Application credentials belong to work commands, never to the model client.
 * Tavya-owned turn values still win collisions (notably its scoped MCP token). */
export function workEnvironment(input: TurnInput): Record<string, string> {
  return Object.fromEntries(Object.entries(input.secretEnv ?? {}).map(([name, value]) => {
    if (!isEnvName(name) || value.includes('\0'))
      throw new Error('Invalid project environment variable');
    return [name, input.extraEnv?.[name] ?? value];
  }));
}

const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

/** Rewrites of a live work-environment file are serialized, atomic (a command
 * never sources half a file), and never land after cleanup has removed it. */
function liveFile(write: () => Promise<void>) {
  let closed = false;
  let pending: Promise<void> = Promise.resolve();
  return {
    update: () => (pending = pending.catch(() => {}).then(() => closed ? undefined : write())),
    close: async () => { closed = true; await pending.catch(() => {}); },
  };
}

/** Only a file path enters hook settings/history. The private export file stays
 * in the task's excluded injection directory and is deleted at turn end.
 * `live` installs it even while empty, so `update()` can deliver secrets that
 * project settings gain mid-turn: the hook sources the file before every command. */
export async function claudeWorkEnvironment(input: TurnInput, live = false) {
  if (!live && !Object.keys(workEnvironment(input)).length)
    return { settings: undefined, update: async () => {}, cleanup: async () => {} };
  const world = input.world.withoutProjectEnvironment?.() ?? input.world;
  const relative = `.karmax-injection/work-env/${crypto.randomUUID()}`;
  const directory = path.join(world.handle.root, relative);
  const file = path.join(directory, 'env.sh');
  const content = () => Object.entries(workEnvironment(input)).map(([name, value]) => `export ${name}=${quote(value)}\n`).join('');
  const remote = isRemoteAgentWorld(world);
  const write = async () => {
    const next = `${relative}/env.sh.${crypto.randomUUID()}`;
    if (remote) {
      await world.writeFile(next, content());
      const moved = await world.exec('bash', ['-c', 'chmod 600 "$1" && mv -f "$1" "$2"', 'karmax-work-env',
        path.join(world.handle.root, next), file]);
      if (moved.code !== 0) throw new Error('Could not protect work environment');
    } else {
      fs.writeFileSync(path.join(world.handle.root, next), content(), { mode: 0o600, flag: 'wx' });
      fs.renameSync(path.join(world.handle.root, next), file);
    }
  };
  const writes = liveFile(write);
  const cleanup = async () => {
    await writes.close();
    if (remote) {
      const result = await world.exec('rm', ['-rf', '--', directory]);
      if (result.code !== 0) throw new Error('Could not remove temporary work environment');
    } else fs.rmSync(directory, { recursive: true, force: true });
  };
  try {
    // A remote world's bootstrap, when it already ran beside prompt preparation,
    // git-excluded and privatized the parent: nothing is asked of the sandbox.
    const prepared = remote && await preparedRemoteWorkDirectory(world);
    if (!prepared && typeof world.exec === 'function') await ensureWorldExcluded(world, '.karmax-injection');
    if (remote && !prepared) {
      const created = await world.exec('mkdir', ['-p', '-m', '700', directory]);
      if (created.code !== 0) throw new Error('Could not prepare private work environment');
    } else if (!remote) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    await write();
  } catch (error) { await cleanup(); throw error; }
  // A source statement avoids copying secret values into Claude's persistent
  // shell snapshot. Native SessionStart hooks run on fresh, resume and fork.
  const source = `if [ -r ${quote(file)} ]; then . ${quote(file)}; fi`;
  const settings = { hooks: { SessionStart: [{ hooks: [{ type: 'command' as const,
    command: `printf '%s\\n' ${quote(source)} >> "$CLAUDE_ENV_FILE"`,
  }] }] } };
  return { settings, update: writes.update, cleanup };
}

/** The legacy CLI cannot receive per-thread JSON config over stdin. A unique,
 * private profile keeps values out of argv and shared config.toml, including
 * when several turns use the same subscription home concurrently. */
export function codexWorkProfile(input: TurnInput) {
  const env = workEnvironment(input);
  if (!Object.keys(env).length) return { args: [] as string[], cleanup() {} };
  const home = input.resolvedAuth?.configHome ?? defaultCodexHome();
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  sweepCodexWorkProfiles(home);
  const owner = ownerTag(process.pid);
  const name = `karmax-work-${process.pid}-${owner ? `${owner}-` : ''}${crypto.randomUUID()}`;
  const file = path.join(home, `${name}.config.toml`);
  fs.writeFileSync(file, '[shell_environment_policy.set]\n' + Object.entries(env)
    .map(([key, value]) => `${JSON.stringify(key)} = ${JSON.stringify(value)}\n`).join(''), { mode: 0o600, flag: 'wx' });
  return { args: ['--profile', name], cleanup() { fs.rmSync(file, { force: true }); } };
}

const defaultCodexHome = () => process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');

/** A pid names a process only until it is reused, so a profile also records a
 * digest of its owner's start time (safe in a file name on every platform). */
function ownerTag(pid: number): string | undefined {
  const tick = processStartTick(pid);
  return tick ? crypto.createHash('sha256').update(tick).digest('hex').slice(0, 12) : undefined;
}

/** Profiles hold a turn's work secrets. Remove those whose owner process is
 * gone (or whose pid now belongs to another process), and unowned ones from
 * older releases once no turn could still be using them. */
export function sweepCodexWorkProfiles(home: string, now = Date.now()): number {
  let removed = 0;
  let entries: string[];
  try { entries = fs.readdirSync(home); } catch { return 0; }
  for (const entry of entries) {
    const file = path.join(home, entry);
    const owned = entry.match(/^karmax-work-(\d+)-(?:([a-f0-9]{12})-)?[a-f0-9-]{36}\.config\.toml$/);
    let stale: boolean;
    if (owned) {
      const pid = Number(owned[1]);
      try { process.kill(pid, 0); stale = Boolean(owned[2]) && ownerTag(pid) !== owned[2]; }
      catch (error) { stale = (error as NodeJS.ErrnoException).code === 'ESRCH'; }
    } else if (/^karmax-work-[a-f0-9-]{36}\.config\.toml$/.test(entry)) {
      try { stale = now - fs.statSync(file).mtimeMs > 86_400_000; } catch { stale = false; }
    } else continue;
    if (stale) { fs.rmSync(file, { force: true }); removed++; }
  }
  return removed;
}

/** Boot's sweep: a home no turn uses again would otherwise keep a crashed
 * turn's secrets indefinitely. */
export function sweepWorkProfiles(homes: Pick<ConfigHomeManager, 'allHomes'>): number {
  const codexHomes = new Set(homes.allHomes().filter(({ provider }) => provider === 'codex').map(({ path: home }) => home));
  codexHomes.add(defaultCodexHome());
  let removed = 0;
  for (const home of codexHomes) removed += sweepCodexWorkProfiles(home);
  return removed;
}

const OPENCODE_WORK_PLUGIN = `import { readFileSync } from 'node:fs';
export default async () => ({
  'shell.env': async (_input, output) => {
    Object.assign(output.env, JSON.parse(readFileSync(new URL('./env.json', import.meta.url), 'utf8')));
  },
});
`;

/** OpenCode can run its Bash tool inside the server instead of calling ACP
 * terminal/create. Its documented shell.env hook covers that path too, and
 * re-reads env.json per command, so `update()` reaches the running agent. In a
 * cloud sandbox the plugin and env.json live in the world's private injection
 * directory, written through the world API like Claude's env file. */
export async function openCodeWorkEnvironment(input: TurnInput, live = false) {
  if (input.profile.provider !== 'opencode' || (!live && !Object.keys(workEnvironment(input)).length))
    return { plugin: undefined, update: async () => {}, cleanup() {} };
  const world = input.world.withoutProjectEnvironment?.() ?? input.world;
  const relative = `.karmax-injection/work-env/${crypto.randomUUID()}`;
  const directory = path.posix.join(world.handle.root, relative);
  const remote = isRemoteAgentWorld(world);
  const write = async () => {
    const name = `env.json.${crypto.randomUUID()}`;
    if (remote) {
      await world.writeFile(`${relative}/${name}`, JSON.stringify(workEnvironment(input)));
      const moved = await world.exec('bash', ['-c', 'chmod 600 "$1" && mv -f "$1" "$2"', 'karmax-work-env',
        path.posix.join(directory, name), path.posix.join(directory, 'env.json')]);
      if (moved.code !== 0) throw new Error('Could not protect work environment');
    } else {
      const next = path.join(directory, name);
      fs.writeFileSync(next, JSON.stringify(workEnvironment(input)), { mode: 0o600, flag: 'wx' });
      fs.renameSync(next, path.join(directory, 'env.json'));
    }
  };
  const writes = liveFile(write);
  const cleanup = () => {
    void writes.close();
    if (remote) void world.exec('rm', ['-rf', '--', directory]).catch(() => undefined);
    else fs.rmSync(directory, { recursive: true, force: true });
  };
  try {
    const prepared = remote && await preparedRemoteWorkDirectory(world);
    if (!prepared && typeof world.exec === 'function') await ensureWorldExcluded(world, '.karmax-injection');
    if (remote) {
      const created = await world.exec('mkdir', ['-p', '-m', '700', directory]);
      if (created.code !== 0) throw new Error('Could not prepare private work environment');
    } else fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    await write();
    if (remote) {
      await world.writeFile(`${relative}/plugin.mjs`, OPENCODE_WORK_PLUGIN);
      return { plugin: `file://${path.posix.join(directory, 'plugin.mjs')}`, update: writes.update, cleanup };
    }
    const file = path.join(directory, 'plugin.mjs');
    fs.writeFileSync(file, OPENCODE_WORK_PLUGIN, { mode: 0o600, flag: 'wx' });
    return { plugin: pathToFileURL(file).href, update: writes.update, cleanup };
  } catch (error) { cleanup(); throw error; }
}
