import { it, expect } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { cachedWorkflowBundle } from '../src/packages/bundle-cache.js';

it('reuses bytes, invalidates all dependency kinds, and rejects corrupt cache entries', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bundle-cache-test-'));
  const source = path.join(dir, 'workflow.ts'), sdk = path.join(dir, 'package.json');
  const missing = path.join(dir, 'optional.ts'), context = path.join(dir, 'imports');
  await fs.mkdir(context);
  await fs.symlink(context, path.join(context, 'self'), 'dir');
  await fs.writeFile(source, 'first'); await fs.writeFile(sdk, '{"version":"1"}');
  let builds = 0;
  const build = async () => ({ bundle: { code: `bundle-${++builds}` }, files: [source, sdk], missing: [missing], contexts: [context] });
  const get = (identity = 'entry') => cachedWorkflowBundle(path.join(dir, 'cache'), identity, build);
  try {
    expect((await get()).code).toBe('bundle-1');
    expect((await get()).code).toBe('bundle-1');
    const originalStat = await fs.stat(source);
    await fs.writeFile(source, 'other');
    await fs.utimes(source, originalStat.atime, originalStat.mtime);
    expect((await get()).code).toBe('bundle-2');
    await fs.writeFile(sdk, '{"version":"2"}');
    expect((await get()).code).toBe('bundle-3');
    await fs.writeFile(missing, 'new resolution');
    expect((await get()).code).toBe('bundle-4');
    await fs.writeFile(path.join(context, 'new.ts'), 'new import');
    expect((await get()).code).toBe('bundle-5');
    expect((await get('external installed')).code).toBe('bundle-6');
    for (const name of await fs.readdir(path.join(dir, 'cache')))
      await fs.writeFile(path.join(dir, 'cache', name), 'corrupt');
    expect((await get()).code).toBe('bundle-7');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

it('persists a real webpack bundle and invalidates transitive external sources', async () => {
  const { buildVersionedBundle } = await import('../src/packages/bundle.js');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bundle-real-test-'));
  const entryFile = path.join(dir, 'workflow.mjs'), dependency = path.join(dir, 'value.mjs');
  const cacheDir = path.join(dir, 'cache');
  await fs.writeFile(entryFile, "import { value } from './value.mjs'; export default async function external() { return value; }");
  await fs.writeFile(dependency, "export const value = 'original-value';");
  const refs = [{ type: 'cache-test@1', entryFile }];
  try {
    const start = performance.now();
    const cold = await buildVersionedBundle(refs, { cacheDir });
    const coldMs = performance.now() - start;
    const warmStart = performance.now();
    const warm = await buildVersionedBundle(refs, { cacheDir });
    console.log(JSON.stringify({ coldMs: Math.round(coldMs), warmMs: Math.round(performance.now() - warmStart) }));
    expect(warm.code).toBe(cold.code);
    expect(await fs.readdir(cacheDir)).toHaveLength(1);
    await fs.writeFile(dependency, "export const value = 'modified-value';");
    const changed = await buildVersionedBundle(refs, { cacheDir });
    expect(changed.code).not.toBe(cold.code);
    expect(changed.code).toContain('modified-value');
    await fs.writeFile(entryFile, "import { value } from './priority.js'; export default async function external() { return value; }");
    await fs.writeFile(path.join(dir, 'priority.js'), "export const value = 'lower-priority';");
    expect((await buildVersionedBundle(refs, { cacheDir })).code).toContain('lower-priority');
    // Temporal's .js alias prefers .ts: a previously missing file changes resolution.
    await fs.writeFile(path.join(dir, 'priority.ts'), "export const value = 'higher-priority';");
    expect((await buildVersionedBundle(refs, { cacheDir })).code).toContain('higher-priority');
    const ephemeralCache = path.join(dir, 'ephemeral-cache');
    await buildVersionedBundle(refs, { cacheDir: ephemeralCache, cache: false });
    await expect(fs.access(ephemeralCache)).rejects.toThrow();
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
// Six real webpack builds: ~10 s here, but a loaded CI runner took 10 s for
// one cold build and 7 s for a warm one (run 36316793983) and ran out of time.
}, 180_000);

it('frames each input so moving delimiter-like bytes between files cannot reuse a stale bundle', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bundle-framing-test-'));
  const a = path.join(dir, 'a'), b = path.join(dir, 'b');
  await fs.writeFile(a, 'original-a'); await fs.writeFile(b, '');
  const delimiter = `\0${JSON.stringify(b)}${await fs.realpath(b)}`;
  await fs.writeFile(b, `${delimiter}original-b`);
  let builds = 0;
  const get = () => cachedWorkflowBundle(path.join(dir, 'cache'), 'entry', async () => ({
    bundle: { code: String(++builds) }, files: [a, b], missing: [], contexts: [],
  }));
  try {
    expect((await get()).code).toBe('1');
    await fs.writeFile(a, `original-a${delimiter}`); await fs.writeFile(b, 'original-b');
    expect((await get()).code).toBe('2');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
