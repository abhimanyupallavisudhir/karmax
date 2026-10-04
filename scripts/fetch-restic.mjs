#!/usr/bin/env node
// Installs the pinned restic (src/world/restic-release.json) into
// node_modules/.cache/restic/<version>/: the host's own binary, and the Linux
// binaries the server hands to task worlds. Run by `npm install`/`npm ci`.
// Downloads are checked against the pinned digests and kept in
// ~/.cache/karmax/restic, so reinstalling needs no network.
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const release = JSON.parse(fs.readFileSync(path.join(root, 'src/world/restic-release.json'), 'utf8'));
const target = path.join(root, 'node_modules/.cache/restic', release.version);
const cache = path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'karmax/restic', release.version);
const arch = { x64: 'amd64', arm64: 'arm64' }[process.arch];
const host = arch && ['linux', 'darwin'].includes(process.platform) ? `${process.platform}-${arch}` : undefined;
const wanted = [...new Set(['linux-amd64', 'linux-arm64', ...(host ? [host] : [])])];
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

async function install(platform) {
  const pinned = release.binaries[platform];
  const out = path.join(target, `restic-${platform}`);
  if (fs.existsSync(out) && (!pinned.binary || sha256(out) === pinned.binary)) return;
  fs.mkdirSync(cache, { recursive: true });
  const archive = path.join(cache, `restic_${release.version}_${platform.replace('-', '_')}.bz2`);
  if (!fs.existsSync(archive) || sha256(archive) !== pinned.archive) {
    const url = `https://github.com/restic/restic/releases/download/v${release.version}/restic_${release.version}_${platform.replace('-', '_')}.bz2`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`downloading ${url}: HTTP ${response.status}`);
    const temporary = `${archive}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, Buffer.from(await response.arrayBuffer()));
    if (sha256(temporary) !== pinned.archive) { fs.rmSync(temporary); throw new Error(`${url} does not match its pinned digest`); }
    fs.renameSync(temporary, archive);
  }
  fs.mkdirSync(target, { recursive: true });
  const temporary = `${out}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, execFileSync('bunzip2', ['-c', archive], { maxBuffer: 256 * 1024 * 1024 }));
  if (pinned.binary && sha256(temporary) !== pinned.binary) { fs.rmSync(temporary); throw new Error(`restic ${platform} does not match its pinned digest`); }
  fs.chmodSync(temporary, 0o755);
  fs.renameSync(temporary, out);
}

try {
  for (const platform of wanted) await install(platform);
} catch (error) {
  console.error(`restic: ${error instanceof Error ? error.message : String(error)}`);
  console.error('restic is needed to save and restore project resources (needs network access and bunzip2).');
  process.exit(1);
}
