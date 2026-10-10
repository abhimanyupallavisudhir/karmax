// tavya-data: fetch and drop parts of a project's on-demand data in a task
// world (wiki features/resource-storage). Installed into every world that has
// such a resource, at .karmax-injection/bin/tavya-data, and run by the agent.
// No dependencies: Node's standard library and the world's restic.
//
// A resource on demand arrives as a listing. Its parts are its top-level
// folders (and `.`, the files beside them); `get` restores parts, `drop` frees
// their space again. Neither changes the resource: a part this world never
// fetched, or dropped, is kept as it is by every save. Deleting files of a
// fetched part is what deletes them.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_PART = '.';
const here = path.dirname(fileURLToPath(import.meta.url));
const dataRoot = path.resolve(here, '../data');

const HELP = `tavya-data: this task's on-demand project data

  tavya-data ls [path]            what there is, its sizes, and what is on this disk
  tavya-data get <path>...        fetch top-level folders of a resource (or all of it)
  tavya-data drop <path>...       free their disk space again
  tavya-data drop --discard <path>...   ... also when they have unsaved changes

Only what you get is on disk. Dropping a folder, or never fetching it, never
removes it from the project: it stays as it is. Deleting files you fetched
does delete them, so free space with drop, not rm.`;

class Refusal extends Error {}

function resources() {
  if (!fs.existsSync(dataRoot)) return [];
  const found = [];
  for (const entry of fs.readdirSync(dataRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(dataRoot, entry.name);
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
      found.push({ ...manifest, dir });
    } catch { /* not one */ }
  }
  return found.sort((a, b) => a.label.localeCompare(b.label));
}

function fetched(resource) {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(resource.dir, 'fetched.json'), 'utf8'));
    return new Set(Array.isArray(value) ? value : []);
  } catch { return new Set(); }
}

function writeFetched(resource, names) {
  const file = path.join(resource.dir, 'fetched.json');
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify([...names].sort()));
  fs.renameSync(temporary, file);
}

/** The resource and part a path names (`part` undefined: the whole resource). */
function resolve(argument, all) {
  const absolute = path.resolve(process.cwd(), argument);
  let resource = all.find((candidate) => absolute === candidate.path || absolute.startsWith(`${candidate.path}/`));
  if (!resource) resource = all.find((candidate) => argument.replace(/\/+$/, '') === candidate.label || argument === candidate.name);
  if (!resource) throw new Refusal(`${argument} is not in on-demand data (${all.map((candidate) => candidate.label).join(', ') || 'there is none here'})`);
  const relative = absolute.startsWith(`${resource.path}/`) ? absolute.slice(resource.path.length + 1).replace(/\/+$/, '') : '';
  // `<resource>/.` names the files beside its folders.
  if (!relative && /(^|\/)\.\/*$/.test(argument)) return { resource, relative: '.', part: ROOT_PART };
  if (!relative) return { resource, relative: '' };
  const first = relative.split('/')[0];
  // A top-level file belongs to the part of top-level files.
  const folder = resource.parts[first] && first !== ROOT_PART || relative.includes('/')
    || fs.statSync(path.join(resource.path, first), { throwIfNoEntry: false })?.isDirectory();
  return { resource, relative: folder ? relative : '.', part: folder ? first : ROOT_PART };
}

function files(count) { return `${count.toLocaleString('en-US')} file${count === 1 ? '' : 's'}`; }

function size(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes; let unit = 0;
  while (value >= 1000 && unit < units.length - 1) { value /= 1000; unit++; }
  return `${unit ? value.toFixed(value < 10 ? 1 : 0) : value} ${units[unit]}`;
}

function grant(resource) {
  let value;
  try { value = JSON.parse(fs.readFileSync(path.join(resource.dir, 'grant.json'), 'utf8')); }
  catch { throw new Refusal(`no access to ${resource.label} right now: it is renewed when this task's world is next opened (your next turn)`); }
  if (Number(value.expiresAt) < Date.now()) throw new Refusal(`access to ${resource.label} expired: it is renewed when this task's world is next opened (your next turn)`);
  return value.env;
}

function restic(resource, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(resource.restic, args, { env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/tmp',
      RESTIC_CACHE_DIR: path.join(dataRoot, '..', 'restic-cache'), ...grant(resource) },
      stdio: ['ignore', options.capture ? 'pipe' : 'inherit', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-8192); });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolvePromise(stdout)
      : reject(new Error(`restic failed (exit ${code}): ${stderr.trim().split('\n').slice(-3).join('; ')}`)));
  });
}

/** A part's files: [type, size, mtime ns, link target, path], cached per snapshot. */
async function listing(resource, part) {
  const snapshot = resource.parts[part].snapshot;
  const cache = path.join(resource.dir, `listing-${snapshot.slice(0, 16)}.json`);
  if (fs.existsSync(cache)) return JSON.parse(fs.readFileSync(cache, 'utf8'));
  const out = await restic(resource, ['ls', '--json', '--no-lock', snapshot], { capture: true });
  const entries = [];
  for (const line of out.split('\n')) {
    if (!line.startsWith('{')) continue;
    const node = JSON.parse(line);
    if (node.struct_type !== 'node') continue;
    entries.push([node.type, Number(node.size ?? 0), String(mtimeNs(node.mtime)), node.linktarget ?? '', String(node.path).replace(/^\/+/, '')]);
  }
  fs.writeFileSync(cache, JSON.stringify(entries));
  return entries;
}

function mtimeNs(text) {
  const match = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d+))?(Z|[+-]\d\d:\d\d)$/.exec(String(text ?? ''));
  if (!match) return -1n;
  return BigInt(Date.parse(`${match[1]}${match[3]}`)) * 1_000_000n + BigInt((match[2] ?? '').padEnd(9, '0').slice(0, 9));
}

async function list(argument) {
  const all = resources();
  if (!all.length) { console.log('This world has no on-demand data.'); return; }
  const chosen = argument ? [resolve(argument, all)] : all.map((resource) => ({ resource, relative: '' }));
  for (const { resource, relative, part } of chosen) {
    const held = fetched(resource);
    if (!relative) {
      const names = Object.keys(resource.parts).sort((a, b) => a === ROOT_PART ? 1 : b === ROOT_PART ? -1 : a.localeCompare(b));
      const total = names.reduce((sum, name) => sum + resource.parts[name].bytes, 0);
      const local = names.filter((name) => held.has(name)).reduce((sum, name) => sum + resource.parts[name].bytes, 0);
      console.log(`${resource.label}  ${size(total)} in ${names.length} part${names.length === 1 ? '' : 's'}, ${size(local)} on this disk${resource.access === 'read' ? ' (read-only)' : ''}`);
      const shown = (name) => name === ROOT_PART ? './ (top-level files)' : `${name}/`;
      const width = Math.max(4, ...names.map((name) => shown(name).length));
      for (const name of names) {
        const value = resource.parts[name];
        console.log(`  ${shown(name).padEnd(width)}  ${size(value.bytes).padStart(8)}  ${files(value.files).padStart(12)}${held.has(name) ? '  here' : ''}`);
      }
      const extra = [...held].filter((name) => !resource.parts[name]);
      if (extra.length) console.log(`  new here, not saved yet: ${extra.map(shown).join(', ')}`);
      continue;
    }
    if (!resource.parts[part]) throw new Refusal(`${relative} is not in ${resource.label}${held.has(part) ? ' yet (it is new here)' : ''}`);
    const entries = await listing(resource, part);
    const prefix = part === ROOT_PART ? '' : `${relative}/`;
    const children = new Map();
    for (const [type, bytes, , , file] of entries) {
      if (part !== ROOT_PART && file === relative && type !== 'dir') { children.set(path.basename(file), { bytes, files: 1, dir: false }); continue; }
      if (prefix && !file.startsWith(prefix)) continue;
      if (part === ROOT_PART && file.includes('/')) continue;
      const rest = file.slice(prefix.length);
      if (!rest) continue;
      const name = rest.split('/')[0];
      const child = children.get(name) ?? { bytes: 0, files: 0, dir: rest.includes('/') || type === 'dir' };
      if (type !== 'dir') { child.bytes += bytes; child.files++; }
      if (rest.includes('/')) child.dir = true;
      children.set(name, child);
    }
    console.log(`${resource.label}/${relative}${held.has(part) ? '  (here)' : '  (not on this disk: tavya-data get ' + path.posix.join(resource.label, part === ROOT_PART ? '.' : part) + ')'}`);
    for (const [name, child] of [...children].sort((a, b) => a[0].localeCompare(b[0])))
      console.log(`  ${(child.dir ? `${name}/` : name).padEnd(30)}  ${size(child.bytes).padStart(8)}${child.dir ? `  ${files(child.files)}` : ''}`);
  }
}

function parts(argument, all, verb) {
  const { resource, relative, part } = resolve(argument, all);
  if (!relative) return { resource, names: Object.keys(resource.parts) };
  if (relative.includes('/')) throw new Refusal(`${verb} works on whole top-level folders: ${verb} ${path.posix.join(resource.label, part)}`);
  if (part === ROOT_PART && !resource.parts[ROOT_PART] && !fetched(resource).has(ROOT_PART)) throw new Refusal(`${argument} is not in ${resource.label}`);
  if (part !== ROOT_PART && !resource.parts[part] && verb === 'get') throw new Refusal(`${argument} is not in ${resource.label}`);
  return { resource, names: [part] };
}

/** Move what `from` has and `to` lacks into it, descending into folders both have. */
function merge(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name); const target = path.join(to, entry.name);
    let existing;
    try { existing = fs.lstatSync(target); } catch { existing = undefined; }
    if (!existing) fs.renameSync(source, target);
    else if (entry.isDirectory() && existing.isDirectory()) merge(source, target);
  }
}

function freeBytes(target) {
  let dir = target;
  while (!fs.existsSync(dir)) dir = path.dirname(dir);
  const stats = fs.statfsSync(dir);
  return Number(stats.bavail) * Number(stats.bsize);
}

async function get(argumentsList) {
  const all = resources();
  if (!argumentsList.length) throw new Refusal('usage: tavya-data get <path>...');
  const wanted = new Map();
  for (const argument of argumentsList) {
    const { resource, names } = parts(argument, all, 'get');
    const entry = wanted.get(resource.attachmentId) ?? { resource, names: new Set() };
    for (const name of names) entry.names.add(name);
    wanted.set(resource.attachmentId, entry);
  }
  for (const { resource, names } of wanted.values()) {
    const held = fetched(resource);
    const todo = [...names].filter((name) => !held.has(name));
    for (const name of [...names].filter((name) => held.has(name))) console.log(`${label(resource, name)} is already here`);
    if (!todo.length) continue;
    const needed = todo.reduce((sum, name) => sum + resource.parts[name].bytes, 0);
    const free = freeBytes(resource.path);
    if (needed > free - 256 * 1024 * 1024)
      throw new Refusal(`${todo.map((name) => label(resource, name)).join(', ')} need${todo.length === 1 ? 's' : ''} ${size(needed)}; this disk has ${size(free)} free. `
        + 'Drop parts you no longer need (tavya-data drop), or get a bigger disk.');
    for (const name of todo) {
      const scratch = path.join(resource.dir, `fetch-${crypto.createHash('sha256').update(name).digest('hex').slice(0, 12)}`);
      fs.rmSync(scratch, { recursive: true, force: true });
      console.log(`fetching ${label(resource, name)} (${size(resource.parts[name].bytes)})…`);
      // Restored beside the resource and moved in once complete: an interrupted
      // fetch never leaves half a part where the resource is.
      await restic(resource, ['restore', resource.parts[name].snapshot, '--target', scratch, '--no-lock']);
      merge(scratch, resource.path);
      fs.rmSync(scratch, { recursive: true, force: true });
      if (resource.access === 'read') {
        const targets = name === ROOT_PART
          ? fs.readdirSync(resource.path).filter((entry) => !fs.lstatSync(path.join(resource.path, entry)).isDirectory())
          : [name];
        for (const target of targets) makeReadOnly(path.join(resource.path, target));
      }
      const now = fetched(resource); now.add(name); writeFetched(resource, now);
      console.log(`${label(resource, name)} is here`);
    }
  }
}

function makeReadOnly(target) {
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) for (const entry of fs.readdirSync(target)) makeReadOnly(path.join(target, entry));
  fs.chmodSync(target, stat.mode & ~0o222);
}

function makeWritable(target) {
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink()) return;
  fs.chmodSync(target, stat.mode | 0o200);
  if (stat.isDirectory()) for (const entry of fs.readdirSync(target)) makeWritable(path.join(target, entry));
}

function label(resource, name) { return name === ROOT_PART ? `${resource.label}/. (top-level files)` : `${resource.label}/${name}`; }

/** What differs on disk from the part as last saved, by size and modification
 * time as restic itself judges (a few paths). */
async function changes(resource, name) {
  if (!resource.parts[name]) return ['all of it (it was never saved)'];
  const saved = new Map();
  for (const [type, bytes, mtime, link, file] of await listing(resource, name)) if (type !== 'dir') saved.set(file, { type, bytes, mtime: BigInt(mtime), link });
  const changed = [];
  const visit = (relative) => {
    const absolute = path.join(resource.path, relative);
    const stat = fs.lstatSync(absolute, { bigint: true });
    if (stat.isDirectory()) {
      if (name === ROOT_PART && relative) return;
      for (const entry of fs.readdirSync(absolute)) {
        if (name === ROOT_PART && !relative && fs.lstatSync(path.join(absolute, entry)).isDirectory()) continue;
        visit(relative ? `${relative}/${entry}` : entry);
      }
      return;
    }
    const prior = saved.get(relative);
    saved.delete(relative);
    if (!prior) changed.push(`${relative} (new)`);
    else if (stat.isSymbolicLink() ? prior.type !== 'symlink' || fs.readlinkSync(absolute) !== prior.link
      : prior.type !== 'file' || BigInt(prior.bytes) !== stat.size || prior.mtime !== stat.mtimeNs) changed.push(`${relative} (changed)`);
  };
  if (name === ROOT_PART) visit(''); else if (fs.existsSync(path.join(resource.path, name))) visit(name);
  for (const file of saved.keys()) changed.push(`${file} (deleted)`);
  return changed;
}

async function drop(argumentsList) {
  const discard = argumentsList.includes('--discard');
  const targets = argumentsList.filter((argument) => argument !== '--discard');
  if (!targets.length) throw new Refusal('usage: tavya-data drop [--discard] <path>...');
  const all = resources();
  for (const argument of targets) {
    const { resource, names } = parts(argument, all, 'drop');
    for (const name of names) {
      const held = fetched(resource);
      if (!held.has(name)) { if (names.length === 1) console.log(`${label(resource, name)} is not on this disk`); continue; }
      const changed = await changes(resource, name);
      if (changed.length && !discard)
        throw new Refusal(`${label(resource, name)} has changes that are not saved yet (${changed.slice(0, 5).join(', ')}${changed.length > 5 ? ', …' : ''}). `
          + 'They are saved when the task parks or is confirmed; drop it after that, or drop --discard to lose them.');
      const freed = resource.parts[name]?.bytes ?? 0;
      const entries = name === ROOT_PART
        ? fs.readdirSync(resource.path).filter((entry) => !fs.lstatSync(path.join(resource.path, entry)).isDirectory())
        : fs.existsSync(path.join(resource.path, name)) ? [name] : [];
      for (const entry of entries) {
        const target = path.join(resource.path, entry);
        makeWritable(target);
        fs.rmSync(target, { recursive: true, force: true });
      }
      held.delete(name); writeFetched(resource, held);
      console.log(`dropped ${label(resource, name)}: ${size(freed)} freed; it is still in the project`);
    }
  }
}

const [command = 'ls', ...rest] = process.argv.slice(2);
try {
  if (command === 'ls' || command === 'list') await list(rest[0]);
  else if (command === 'get' || command === 'fetch') await get(rest);
  else if (command === 'drop') await drop(rest);
  else if (command === '-h' || command === '--help' || command === 'help') console.log(HELP);
  else throw new Refusal(`unknown command ${command}\n\n${HELP}`);
} catch (error) {
  console.error(`tavya-data: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(error instanceof Refusal ? 2 : 1);
}
