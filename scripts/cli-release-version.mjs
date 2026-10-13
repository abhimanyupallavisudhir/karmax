#!/usr/bin/env node
// The version the next @tavya/cli release gets, computed when master changes,
// so pull requests never edit a version number. Every pull request that touched
// the CLI used to bump cli/package.json itself; two of them in flight always
// conflicted on that one line, and a merged neighbour turned the other's CI red
// (wiki reviews/2026-10-12-github-landing, GL-5).
//
// cli/package.json's version is the floor: a change that warrants a minor or
// major release raises it there (1.4.0 → 1.5.0). Otherwise a master change to
// what the CLI ships releases the next patch after the newest cli-v* tag.
//
//   node scripts/cli-release-version.mjs              report: {"version","tag","release"}
//   node scripts/cli-release-version.mjs --write      also write the version into cli/package.json and its lock
//   node scripts/cli-release-version.mjs --tag cli-v1.2.3 --write   republish that tag's version
//   node scripts/cli-release-version.mjs --set 1.2.3  only write that version (release jobs building one commit)
// With GITHUB_OUTPUT set, the result is appended there as key=value lines.
// "What it ships" is every input of the bundle (esbuild's own list), its build
// script and its locked build tools.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

/** @param {string} version */
export function parseVersion(version) {
  const match = SEMVER.exec(version.trim());
  if (!match) throw new Error(`not a release version: ${version}`);
  return match.slice(1, 4).map(Number);
}

/** @param {string} a @param {string} b */
export function compareVersions(a, b) {
  const [x, y] = [parseVersion(a), parseVersion(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

/**
 * @param {{ floor: string, released: string[], shippedChanged: boolean }} input
 * @returns {{ version: string, release: boolean }}
 */
export function nextCliVersion({ floor, released, shippedChanged }) {
  const newest = released.filter((version) => SEMVER.test(version)).sort(compareVersions).at(-1);
  if (!newest) return { version: floor, release: true };
  if (compareVersions(floor, newest) > 0) return { version: floor, release: true };
  if (!shippedChanged) return { version: newest, release: false };
  const [major, minor, patch] = parseVersion(newest);
  return { version: `${major}.${minor}.${patch + 1}`, release: true };
}

/** @param {string} root @param {string} version */
export function writeCliVersion(root, version) {
  parseVersion(version);
  const pkgFile = path.join(root, 'cli', 'package.json');
  const lockFile = path.join(root, 'cli', 'package-lock.json');
  const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
  pkg.version = version;
  fs.writeFileSync(pkgFile, `${JSON.stringify(pkg, null, 2)}\n`);
  const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
  lock.version = version;
  if (lock.packages?.['']) lock.packages[''].version = version;
  fs.writeFileSync(lockFile, `${JSON.stringify(lock, null, 2)}\n`);
}

function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const args = process.argv.slice(2);
  const option = (name) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; };
  const set = option('--set');
  if (set) { writeCliVersion(root, set); console.log(`@tavya/cli ${set}`); return; }
  const git = (...gitArgs) => execFileSync('git', gitArgs, { cwd: root, encoding: 'utf8' });

  const requested = option('--tag');
  let result;
  if (requested) {
    if (!requested.startsWith('cli-v')) throw new Error(`not a CLI release tag: ${requested}`);
    result = { version: requested.slice('cli-v'.length), release: true };
  } else {
    const tags = git('tag', '--list', 'cli-v*', '--merged', 'HEAD').split('\n').map((tag) => tag.trim()).filter(Boolean);
    const released = tags.map((tag) => tag.slice('cli-v'.length)).filter((version) => SEMVER.test(version));
    const newest = released.sort(compareVersions).at(-1);
    let shippedChanged = true;
    if (newest) {
      execFileSync(process.execPath, [path.join(root, 'scripts/build-cli.mjs')], { cwd: root, stdio: 'inherit' });
      const meta = JSON.parse(fs.readFileSync(path.join(root, 'cli/dist/meta.json'), 'utf8'));
      const shipped = [...Object.keys(meta.inputs), 'scripts/build-cli.mjs', 'cli/package-lock.json'];
      shippedChanged = git('diff', '--name-only', `cli-v${newest}`, 'HEAD', '--', ...shipped).trim().length > 0;
    }
    const floor = JSON.parse(fs.readFileSync(path.join(root, 'cli/package.json'), 'utf8')).version;
    result = nextCliVersion({ floor, released, shippedChanged });
  }
  if (args.includes('--write')) writeCliVersion(root, result.version);
  const output = { ...result, tag: `cli-v${result.version}` };
  console.log(JSON.stringify(output));
  if (process.env.GITHUB_OUTPUT)
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `version=${output.version}\ntag=${output.tag}\nrelease=${output.release}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
