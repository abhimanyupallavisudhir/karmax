import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claudeWorkEnvironment, openCodeWorkEnvironment } from '../src/agent/work-environment.js';

// Project secrets added mid-turn reach harnesses that re-read a file per command.
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function turn(provider: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-work-env-live-'));
  roots.push(root);
  const secretEnv: Record<string, string> = {};
  return { root, secretEnv, input: { profile: { provider }, secretEnv,
    world: { handle: { id: 'live', root, base: 'main', branch: 'task' } } } as any };
}
const files = (root: string, name: string) => {
  const dir = path.join(root, '.karmax-injection/work-env');
  return fs.existsSync(dir) ? fs.readdirSync(dir).map((id) => path.join(dir, id, name)).filter((file) => fs.existsSync(file)) : [];
};

describe('live work environment files', () => {
  it('Claude installs its hook while still empty, rewrites on update, and never writes after cleanup', async () => {
    const { root, secretEnv, input } = turn('claude');
    expect((await claudeWorkEnvironment(input)).settings).toBeUndefined();
    const work = await claudeWorkEnvironment(input, true);
    expect(JSON.stringify(work.settings)).toContain('env.sh');
    const [file] = files(root, 'env.sh');
    expect(fs.readFileSync(file!, 'utf8')).toBe('');
    secretEnv.LATE = "it's here";
    await work.update();
    expect(fs.readFileSync(file!, 'utf8')).toBe(`export LATE='it'\\''s here'\n`);
    expect(fs.statSync(file!).mode & 0o777).toBe(0o600);
    const late = work.update();
    await work.cleanup();
    await late;
    expect(fs.readdirSync(path.join(root, '.karmax-injection/work-env'))).toEqual([]);
  });

  it('OpenCode rewrites the env.json its shell.env plugin reads per command', async () => {
    const { root, secretEnv, input } = turn('opencode');
    expect((await openCodeWorkEnvironment(input)).plugin).toBeUndefined();
    const work = await openCodeWorkEnvironment(input, true);
    expect(work.plugin).toMatch(/plugin\.mjs$/);
    const [file] = files(root, 'env.json');
    expect(JSON.parse(fs.readFileSync(file!, 'utf8'))).toEqual({});
    secretEnv.LATE = 'value';
    await work.update();
    expect(JSON.parse(fs.readFileSync(file!, 'utf8'))).toEqual({ LATE: 'value' });
    work.cleanup();
    expect(files(root, 'env.json')).toEqual([]);
  });
});
