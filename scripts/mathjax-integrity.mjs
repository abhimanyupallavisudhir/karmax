#!/usr/bin/env node
// Print the SRI table web/markdown.js pins MathJax's runtime-loaded files to,
// computed from the npm release the CDN serves byte for byte (jsDelivr's /npm/
// path mirrors the registry tarball). `--check` compares it with markdown.js.
//
//   node scripts/mathjax-integrity.mjs [--check] [path/to/mathjax/package]
//
// Without a path the pinned release's tarball is downloaded from the registry.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const markdown = fs.readFileSync(path.join(root, 'web/markdown.js'), 'utf8');
const version = markdown.match(/cdn\.jsdelivr\.net\/npm\/mathjax@([\d.]+)\/es5\//)?.[1];
if (!version) throw new Error('web/markdown.js does not name a pinned MathJax release');

// What MathJax may load after its entry bundle: the safe-mode filter, the TeX
// extensions autoload and \require pull in, and the assistive-MathML option
// its menu offers. Speech (a11y/sre) is left out: it also fetches locale data.
const RUNTIME = (name) => name === 'ui/safe.js' || name === 'a11y/assistive-mml.js'
  || /^input\/tex\/extensions\/[\w-]+\.js$/.test(name);

async function files(dir) {
  if (dir) {
    const es5 = path.join(dir, 'es5');
    const walk = (rel) => fs.readdirSync(path.join(es5, rel), { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? walk(path.join(rel, entry.name)) : [[path.join(rel, entry.name).split(path.sep).join('/'), fs.readFileSync(path.join(es5, rel, entry.name))]]);
    return new Map(walk(''));
  }
  const response = await fetch(`https://registry.npmjs.org/mathjax/-/mathjax-${version}.tgz`);
  if (!response.ok) throw new Error(`registry answered ${response.status}`);
  const tar = zlib.gunzipSync(Buffer.from(await response.arrayBuffer()));
  const out = new Map();
  for (let offset = 0; offset + 512 <= tar.length;) {
    const name = tar.toString('utf8', offset, offset + 100).replace(/\0.*$/s, '');
    if (!name) break;
    const size = parseInt(tar.toString('utf8', offset + 124, offset + 136).trim() || '0', 8);
    if (name.startsWith('package/es5/')) out.set(name.slice('package/es5/'.length), tar.subarray(offset + 512, offset + 512 + size));
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

const args = process.argv.slice(2);
const all = await files(args.find((arg) => !arg.startsWith('--')));
const table = [...all].filter(([name]) => RUNTIME(name)).sort(([a], [b]) => a.localeCompare(b))
  .map(([name, bytes]) => `    '${name.replace(/\.js$/, '')}': 'sha384-${crypto.createHash('sha384').update(bytes).digest('base64')}',`);
const entry = `sha384-${crypto.createHash('sha384').update(all.get('tex-svg.js')).digest('base64')}`;
if (!args.includes('--check')) {
  console.log(`// tex-svg.js ${entry}`);
  console.log(table.join('\n'));
} else {
  const pinned = new Set(markdown.split('\n').filter((line) => /^\s+'[\w/-]+': 'sha384-/.test(line) && !line.includes("'tex-svg'")).map((line) => line.trimEnd()));
  const missing = table.filter((line) => !pinned.has(line));
  const stale = [...pinned].filter((line) => !table.includes(line));
  if (!markdown.includes(`'${entry}'`)) missing.push(`tex-svg.js ${entry}`);
  if (missing.length || stale.length) {
    console.error(`MathJax ${version} integrity table is out of date.\nmissing:\n${missing.join('\n')}\nstale:\n${stale.join('\n')}`);
    process.exit(1);
  }
  console.log(`MathJax ${version}: ${table.length + 1} files pinned and current`);
}
