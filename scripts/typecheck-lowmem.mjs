#!/usr/bin/env node
// Typecheck in chunks for small machines (a 2 GB task sandbox), where one
// `tsc --noEmit` over the whole project runs out of heap. CI still checks the
// project in one pass with `npm run typecheck`.
//
//   node scripts/typecheck-lowmem.mjs              # src + scripts + benchmarks, then all tests in chunks
//   node scripts/typecheck-lowmem.mjs tests/a.test.ts tests/b.test.ts   # src first, then just these tests
//
// Each chunk gets a temporary tsconfig extending the project's.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const chunkSize = Number(process.env.TYPECHECK_CHUNK ?? 60);
const heap = process.env.TYPECHECK_HEAP_MB ?? '1400';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-typecheck-'));
const ambient = [];
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith('.d.ts')) ambient.push(full);
  }
})(path.join(root, 'src'));

const requested = process.argv.slice(2).map((file) => path.resolve(file));
const tests = requested.length ? requested : fs.readdirSync(path.join(root, 'tests'))
  .filter((name) => /\.tsx?$/.test(name)).map((name) => path.join(root, 'tests', name));
const chunks = [{ name: 'src', include: ['src', 'scripts', 'benchmarks'].map((dir) => path.join(root, dir)) }];
for (let i = 0; i < tests.length; i += chunkSize)
  chunks.push({ name: `tests ${i / chunkSize + 1}`, files: [...tests.slice(i, i + chunkSize), ...ambient] });

let failed = false;
for (const chunk of chunks) {
  const config = path.join(tmp, `${chunk.name.replace(/\W+/g, '-')}.json`);
  fs.writeFileSync(config, JSON.stringify({
    extends: path.join(root, 'tsconfig.json'),
    compilerOptions: { typeRoots: [path.join(root, 'node_modules/@types')] },
    ...(chunk.include ? { include: chunk.include } : { files: chunk.files, include: [] }),
  }));
  process.stdout.write(`typecheck ${chunk.name}… `);
  const result = spawnSync(process.execPath, [`--max-old-space-size=${heap}`,
    path.join(root, 'node_modules/typescript/bin/tsc'), '--noEmit', '-p', config], { encoding: 'utf8' });
  if (result.status === 0) { console.log('ok'); continue; }
  failed = true;
  console.log('failed');
  process.stdout.write(result.stdout || result.stderr || `exit ${result.status ?? result.signal}\n`);
}
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
