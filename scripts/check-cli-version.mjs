#!/usr/bin/env node
// Fails when a change alters what @tavya/cli ships but keeps cli/package.json's
// version: merging a version change is what publishes the CLI
// (.github/workflows/cli-release.yml), so an unbumped change would never reach users.
//   node scripts/check-cli-version.mjs <base commit>
// "What it ships" is every file in the bundle (esbuild's own input list), its
// build script and its locked build tools.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = process.argv[2];
if (!base) { console.error('usage: check-cli-version.mjs <base commit>'); process.exit(2); }
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });

execFileSync(process.execPath, [path.join(root, 'scripts/build-cli.mjs')], { cwd: root, stdio: 'inherit' });
const meta = JSON.parse(fs.readFileSync(path.join(root, 'cli/dist/meta.json'), 'utf8'));
const shipped = [...Object.keys(meta.inputs), 'scripts/build-cli.mjs', 'cli/package-lock.json'];
const from = git('merge-base', base, 'HEAD').trim();
const changed = git('diff', '--name-only', from, 'HEAD', '--', ...shipped).split('\n').filter(Boolean);
const version = (ref) => JSON.parse(git('show', `${ref}:cli/package.json`)).version;
const [before, after] = [version(from), version('HEAD')];

if (!changed.length) console.log(`@tavya/cli unchanged (${after})`);
else if (before !== after) console.log(`@tavya/cli ${before} → ${after}: merging publishes it`);
else {
  console.error(`This change alters what @tavya/cli ships, but cli/package.json is still ${after}:\n  ${changed.join('\n  ')}\n`
    + 'Bump "version" in cli/package.json and cli/package-lock.json (npm version patch --prefix cli --no-git-tag-version);'
    + ' merging publishes it.');
  process.exit(1);
}
