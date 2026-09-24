import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import type { TurnInput } from './types.js';
import { isRemoteAgentWorld } from './remote-process.js';
import { ensureWorldExcluded } from '../world/secret-exclude.js';

/** Application credentials belong to work commands, never to the model client.
 * Tavya-owned turn values still win collisions (notably its scoped MCP token). */
export function workEnvironment(input: TurnInput): Record<string, string> {
  return Object.fromEntries(Object.entries(input.secretEnv ?? {}).map(([name, value]) => {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name) || value.includes('\0'))
      throw new Error('Invalid project environment variable');
    return [name, input.extraEnv?.[name] ?? value];
  }));
}

const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

/** Only a file path enters hook settings/history. The private export file stays
 * in the task's excluded injection directory and is deleted at turn end. */
export async function claudeWorkEnvironment(input: TurnInput) {
  const env = workEnvironment(input);
  if (!Object.keys(env).length) return { settings: undefined, cleanup: async () => {} };
  const world = input.world.withoutProjectEnvironment?.() ?? input.world;
  const relative = `.karmax-injection/work-env/${crypto.randomUUID()}`;
  const directory = path.join(world.handle.root, relative);
  const file = path.join(directory, 'env.sh');
  const content = Object.entries(env).map(([name, value]) => `export ${name}=${quote(value)}\n`).join('');
  const remote = isRemoteAgentWorld(world);
  const cleanup = async () => {
    if (remote) {
      const result = await world.exec('rm', ['-rf', '--', directory]);
      if (result.code !== 0) throw new Error('Could not remove temporary work environment');
    } else fs.rmSync(directory, { recursive: true, force: true });
  };
  try {
    if (typeof world.exec === 'function') await ensureWorldExcluded(world, '.karmax-injection');
    if (remote) {
      const created = await world.exec('mkdir', ['-p', '-m', '700', directory]);
      if (created.code !== 0) throw new Error('Could not prepare private work environment');
      await world.writeFile(`${relative}/env.sh`, content);
      const protectedFile = await world.exec('chmod', ['600', file]);
      if (protectedFile.code !== 0) throw new Error('Could not protect work environment');
    } else {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      fs.writeFileSync(file, content, { mode: 0o600, flag: 'wx' });
    }
  } catch (error) { await cleanup(); throw error; }
  // A source statement avoids copying secret values into Claude's persistent
  // shell snapshot. Native SessionStart hooks run on fresh, resume and fork.
  const source = `if [ -r ${quote(file)} ]; then . ${quote(file)}; fi`;
  const settings = { hooks: { SessionStart: [{ hooks: [{ type: 'command' as const,
    command: `printf '%s\\n' ${quote(source)} >> "$CLAUDE_ENV_FILE"`,
  }] }] } };
  return { settings, cleanup };
}

/** The legacy CLI cannot receive per-thread JSON config over stdin. A unique,
 * private profile keeps values out of argv and shared config.toml, including
 * when several turns use the same subscription home concurrently. */
export function codexWorkProfile(input: TurnInput) {
  const env = workEnvironment(input);
  if (!Object.keys(env).length) return { args: [] as string[], cleanup() {} };
  const home = input.resolvedAuth?.configHome ?? process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
  const name = `karmax-work-${crypto.randomUUID()}`;
  const file = path.join(home, `${name}.config.toml`);
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, '[shell_environment_policy.set]\n' + Object.entries(env)
    .map(([key, value]) => `${JSON.stringify(key)} = ${JSON.stringify(value)}\n`).join(''), { mode: 0o600, flag: 'wx' });
  return { args: ['--profile', name], cleanup() { fs.rmSync(file, { force: true }); } };
}

/** OpenCode can run its Bash tool inside the server instead of calling ACP
 * terminal/create. Its documented shell.env hook covers that path too. */
export async function openCodeWorkEnvironment(input: TurnInput) {
  const env = workEnvironment(input);
  if (input.profile.provider !== 'opencode' || !Object.keys(env).length)
    return { plugin: undefined, cleanup() {} };
  const world = input.world.withoutProjectEnvironment?.() ?? input.world;
  const directory = path.join(world.handle.root, '.karmax-injection', 'work-env', crypto.randomUUID());
  if (typeof world.exec === 'function') await ensureWorldExcluded(world, '.karmax-injection');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const cleanup = () => fs.rmSync(directory, { recursive: true, force: true });
  try {
    fs.writeFileSync(path.join(directory, 'env.json'), JSON.stringify(env), { mode: 0o600, flag: 'wx' });
    const file = path.join(directory, 'plugin.mjs');
    fs.writeFileSync(file, `import { readFileSync } from 'node:fs';
export default async () => ({
  'shell.env': async (_input, output) => {
    Object.assign(output.env, JSON.parse(readFileSync(new URL('./env.json', import.meta.url), 'utf8')));
  },
});
`, { mode: 0o600, flag: 'wx' });
    return { plugin: pathToFileURL(file).href, cleanup };
  } catch (error) { cleanup(); throw error; }
}
