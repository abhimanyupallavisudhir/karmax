#!/usr/bin/env node
// Bundles the tavya CLI (src/cli) into one dependency-free file:
//   node scripts/build-cli.mjs            → cli/dist/tavya.mjs (the npm package's bin)
//   node scripts/build-cli.mjs --sea      → also cli/dist/tavya.cjs and a Node
//                                           single-executable blob (cli/dist/sea-prep.blob)
// The release workflow (.github/workflows/cli-release.yml) publishes both.
// esbuild resolves from cli/: the release installs only cli/'s locked build
// tools there (npm ci in cli/), while a checkout with `npm ci` at the root
// finds the root's esbuild one directory up.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { build } = createRequire(path.join(root, 'cli', 'package.json'))('esbuild');
const out = path.join(root, 'cli', 'dist');
const sea = process.argv.includes('--sea');
fs.mkdirSync(out, { recursive: true });
const common = { bundle: true, platform: 'node', target: 'node22', legalComments: 'none', logLevel: 'warning', minifySyntax: true };

const { metafile } = await build({ ...common, entryPoints: [path.join(root, 'src/cli/bin.ts')], format: 'esm', outfile: path.join(out, 'tavya.mjs'),
  banner: { js: '#!/usr/bin/env node' }, metafile: true, absWorkingDir: root });
// Its inputs, for scripts/check-cli-version.mjs.
fs.writeFileSync(path.join(out, 'meta.json'), JSON.stringify(metafile));
fs.chmodSync(path.join(out, 'tavya.mjs'), 0o755);

if (sea) {
  // A single executable embeds one CommonJS script.
  await build({ ...common, entryPoints: [path.join(root, 'src/cli/bin.ts')], format: 'cjs', outfile: path.join(out, 'tavya.cjs') });
  const config = path.join(out, 'sea-config.json');
  fs.writeFileSync(config, JSON.stringify({ main: path.join(out, 'tavya.cjs'), output: path.join(out, 'sea-prep.blob'),
    disableExperimentalSEAWarning: true, useCodeCache: false }));
  execFileSync(process.execPath, ['--experimental-sea-config', config], { stdio: 'inherit' });
}
console.log(`built ${path.relative(root, out)}`);
