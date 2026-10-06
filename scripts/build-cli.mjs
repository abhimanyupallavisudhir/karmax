#!/usr/bin/env node
// Bundles the tavya CLI (src/cli) into one dependency-free file:
//   node scripts/build-cli.mjs            → cli/dist/tavya.mjs (the npm package's bin)
//   node scripts/build-cli.mjs --sea      → also cli/dist/tavya.cjs and a Node
//                                           single-executable blob (cli/dist/sea-prep.blob)
// The release workflow (.github/workflows/cli-release.yml) publishes both.
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'cli', 'dist');
const sea = process.argv.includes('--sea');
fs.mkdirSync(out, { recursive: true });
const common = { bundle: true, platform: 'node', target: 'node22', legalComments: 'none', logLevel: 'warning', minifySyntax: true };

await build({ ...common, entryPoints: [path.join(root, 'src/cli/bin.ts')], format: 'esm', outfile: path.join(out, 'tavya.mjs'),
  banner: { js: '#!/usr/bin/env node' } });
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
