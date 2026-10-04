/**
 * The half of a direct resource transfer that runs inside a task world
 * (wiki planned/direct-resource-uploads). It reads, packs or chunks, encrypts
 * and uploads files itself, so their bytes go from the sandbox straight to the
 * object store instead of through the worker. The worker keeps every decision:
 * which files, which objects to upload (each with its own presigned URL), and
 * what is recorded. Its objects match `chunk-store.ts` exactly, so the worker
 * reads them like any other: chunks are KRC1 with a nonce derived from their
 * id, packs are gzipped KRZ1, and ids are HMACs under the transfer's key.
 *
 * One run is one operation: `node <script> <op>`, its JSON input on stdin (the
 * key travels there, never in argv), its JSON result on stdout. A failure
 * exits non-zero with one line on stderr, which never contains a URL.
 */
export const DIRECT_TRANSFER_SCRIPT = String.raw`import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const op = process.argv[2];
const input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
const key = Buffer.from(input.key ?? '', 'base64');
const sha = (data) => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (value) => crypto.createHmac('sha256', key).update(value);
const objectId = (plain, kind) => {
  const scoped = input.ns ? input.ns + '\0' + sha(plain) : sha(plain);
  return hmac(kind ? kind + '\0' + scoped : scoped).digest('hex');
};
const stampOf = (s) => s.size + ':' + s.mtimeNs + ':' + s.ctimeNs + ':' + s.ino;
/** Whether gzip is worth its time: random-looking data (media, archives) is
 * stored rather than compressed, which on a small sandbox is 20x faster. */
const compressible = (plain) => {
  const sample = plain.subarray(0, 64 * 1024);
  return sample.length > 0 && zlib.gzipSync(sample, { level: 1 }).length < sample.length * 0.9;
};
const fail = (message) => { const error = new Error(message); error.expected = true; throw error; };

function stage(id, sealed) {
  const file = path.join(input.dir, id + '.bin');
  fs.writeFileSync(file, sealed);
  return { id, file, size: sealed.length };
}

function readFully(fd, buffer, position) {
  let done = 0;
  while (done < buffer.length) {
    const read = fs.readSync(fd, buffer, done, buffer.length - done, position + done);
    if (!read) return false;
    done += read;
  }
  return true;
}

/** The file's bytes if it still has the stamp it was listed with, else undefined. */
function readStable(source, stamp, bytes) {
  let fd;
  try {
    const before = fs.lstatSync(source, { bigint: true });
    if (!before.isFile() || stampOf(before) !== stamp) return undefined;
    fd = fs.openSync(source, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    if (stampOf(fs.fstatSync(fd, { bigint: true })) !== stamp) return undefined;
    const data = Buffer.alloc(bytes);
    if (!readFully(fd, data, 0)) return undefined;
    if (stampOf(fs.fstatSync(fd, { bigint: true })) !== stamp) return undefined;
    return data;
  } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'ELOOP'].includes(error.code)) return undefined;
    throw error;
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function openChecked(source, stamp) {
  const fd = fs.openSync(source, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  const stat = fs.fstatSync(fd, { bigint: true });
  if (stamp && stampOf(stat) !== stamp) { fs.closeSync(fd); fail(input.path + ' changed while it was being saved'); }
  return { fd, size: Number(stat.size) };
}
function checkUnchanged(fd, stamp) {
  if (stamp && stampOf(fs.fstatSync(fd, { bigint: true })) !== stamp) fail(input.path + ' changed while it was being saved');
}

const ops = {
  /** Small files into packs of at most packBytes, skipping a file whose hash is its baseline's. */
  pack() {
    fs.mkdirSync(input.dir, { recursive: true });
    const packs = [], files = [];
    let parts = [], bytes = 0, members = [];
    const seal = () => {
      if (!members.length) return;
      const plain = Buffer.concat(parts, bytes);
      const id = objectId(plain, 'pack');
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(Buffer.from(id));
      const body = Buffer.concat([cipher.update(zlib.gzipSync(plain, { level: compressible(plain) ? 1 : 0 })), cipher.final()]);
      packs.push({ ...stage(id, Buffer.concat([Buffer.from('KRZ1'), iv, cipher.getAuthTag(), body])), bytes: plain.length });
      for (const member of members) files.push({ ...member, pack: id });
      parts = []; bytes = 0; members = [];
    };
    for (const file of input.files) {
      const data = readStable(file.source, file.stamp, file.bytes);
      if (!data) { files.push({ path: file.path, changed: true }); continue; }
      const digest = sha(data);
      if (file.base === digest) { files.push({ path: file.path, same: true }); continue; }
      if (bytes && bytes + data.length > input.packBytes) seal();
      members.push({ path: file.path, bytes: data.length, sha256: digest, offset: bytes });
      parts.push(data); bytes += data.length;
    }
    seal();
    return { packs, files };
  },

  /** Up to count chunks of one file from offset, each its own object. */
  chunks() {
    fs.mkdirSync(input.dir, { recursive: true });
    const { fd, size } = openChecked(input.source, input.stamp);
    try {
      const chunks = [];
      let offset = input.offset;
      for (let i = 0; i < input.count && (offset < size || (size === 0 && offset === 0 && i === 0)); i++) {
        const plain = Buffer.alloc(Math.min(input.chunkBytes, size - offset));
        if (!readFully(fd, plain, offset)) fail(input.path + ' changed while it was being saved');
        const id = objectId(plain);
        const iv = hmac('iv:' + id).digest().subarray(0, 12);
        const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
        cipher.setAAD(Buffer.from(id));
        const body = Buffer.concat([cipher.update(plain), cipher.final()]);
        chunks.push({ ...stage(id, Buffer.concat([Buffer.from('KRC1'), cipher.getAuthTag(), body])), bytes: plain.length });
        offset += plain.length;
        if (!plain.length) break;
      }
      checkUnchanged(fd, input.stamp);
      return { chunks, next: offset, size, eof: offset >= size };
    } finally { fs.closeSync(fd); }
  },

  /** The whole file's hash, read in place. */
  hash() {
    const { fd, size } = openChecked(input.source, input.stamp);
    try {
      const digest = crypto.createHash('sha256');
      const buffer = Buffer.alloc(4 * 1024 * 1024);
      let position = 0;
      for (;;) {
        const read = fs.readSync(fd, buffer, 0, buffer.length, position);
        if (!read) break;
        digest.update(buffer.subarray(0, read));
        position += read;
      }
      checkUnchanged(fd, input.stamp);
      if (position !== size) fail(input.path + ' changed while it was being saved');
      return { sha256: digest.digest('hex'), bytes: size };
    } finally { fs.closeSync(fd); }
  },

  /** PUT each staged object to its URL, several at once, then remove it and
   * any staged object the store already holds (discard). */
  async upload() {
    let next = 0, failed;
    const one = async (item) => {
      for (let attempt = 1; ; attempt++) {
        let status = 0;
        try {
          const response = await fetch(item.url, { method: 'PUT', body: fs.readFileSync(item.file) });
          status = response.status;
          await response.arrayBuffer().catch(() => undefined);
          if (response.ok) return;
        } catch { /* network: retried like a 5xx */ }
        if (attempt >= 4 || (status >= 400 && status < 500 && status !== 408 && status !== 429))
          fail('upload failed' + (status ? ' (HTTP ' + status + ')' : ' (network)'));
        await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
      }
    };
    const worker = async () => {
      while (!failed && next < input.items.length) {
        const item = input.items[next++];
        try { await one(item); } catch (error) { failed ??= error; }
      }
    };
    try { await Promise.all(Array.from({ length: Math.max(1, Math.min(input.concurrency ?? 4, 32)) }, worker)); }
    finally { for (const file of [...input.items.map((item) => item.file), ...(input.discard ?? [])]) fs.rmSync(file, { force: true }); }
    if (failed) throw failed;
    return { uploaded: input.items.length };
  },

  /** Download objects (each once), check and decrypt them, and write their
   * bytes, or a pack's slice, at each segment's position. A segment that is a
   * whole file is checked against its hash. */
  async restore() {
    const keys = Object.fromEntries(Object.entries(input.keys).map(([id, value]) => [id, Buffer.from(value, 'base64')]));
    const objects = new Map();
    for (const segment of input.segments) objects.set(segment.object.id, segment.object);
    const plain = new Map();
    const open = (object, sealed) => {
      const own = keys[object.key];
      if (!own) fail('restore is missing a key');
      const magic = sealed.subarray(0, 4).toString();
      let data;
      if (object.kind === 'pack' && magic === 'KRZ1') {
        const decipher = crypto.createDecipheriv('aes-256-gcm', own, sealed.subarray(4, 16));
        decipher.setAAD(Buffer.from(object.id)); decipher.setAuthTag(sealed.subarray(16, 32));
        data = zlib.gunzipSync(Buffer.concat([decipher.update(sealed.subarray(32)), decipher.final()]), { maxOutputLength: 4 * 1024 * 1024 });
      } else if (object.kind === 'chunk' && magic === 'KRC1') {
        const iv = crypto.createHmac('sha256', own).update('iv:' + object.id).digest().subarray(0, 12);
        const decipher = crypto.createDecipheriv('aes-256-gcm', own, iv);
        decipher.setAAD(Buffer.from(object.id)); decipher.setAuthTag(sealed.subarray(4, 20));
        data = Buffer.concat([decipher.update(sealed.subarray(20)), decipher.final()]);
      } else fail('restore found an object in an unknown format');
      const scoped = input.ns ? input.ns + '\0' + sha(data) : sha(data);
      const expected = crypto.createHmac('sha256', own).update(object.kind === 'pack' ? 'pack\0' + scoped : scoped).digest('hex');
      if (expected !== object.id) fail('restore found an object that does not match its id');
      return data;
    };
    const queue = [...objects.values()];
    let next = 0, failed;
    const download = async (object) => {
      for (let attempt = 1; ; attempt++) {
        let status = 0;
        try {
          const response = await fetch(object.url);
          status = response.status;
          if (response.ok) { plain.set(object.id, open(object, Buffer.from(await response.arrayBuffer()))); return; }
          await response.arrayBuffer().catch(() => undefined);
        } catch (error) { if (error?.expected) throw error; }
        if (attempt >= 4 || (status >= 400 && status < 500 && status !== 408 && status !== 429))
          fail('download failed' + (status ? ' (HTTP ' + status + ')' : ' (network)'));
        await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(input.concurrency ?? 6, 32)) }, async () => {
      while (!failed && next < queue.length) { try { await download(queue[next++]); } catch (error) { failed ??= error; } }
    }));
    if (failed) throw failed;
    for (const segment of input.segments) {
      const data = plain.get(segment.object.id);
      const bytes = segment.slice ? data.subarray(segment.slice[0], segment.slice[1]) : data;
      if (segment.sha256 && sha(bytes) !== segment.sha256) fail(segment.path + ' does not match its snapshot');
      fs.mkdirSync(path.dirname(segment.path), { recursive: true });
      // Batches may land in any order: write in place, then set the file's size.
      const fd = fs.openSync(segment.path, fs.constants.O_WRONLY | fs.constants.O_CREAT, 0o644);
      try {
        fs.writeSync(fd, bytes, 0, bytes.length, segment.position);
        fs.ftruncateSync(fd, segment.size);
      } finally { fs.closeSync(fd); }
    }
    return { written: input.segments.length };
  },

  cleanup() {
    fs.rmSync(input.dir, { recursive: true, force: true });
    return {};
  },
};

try {
  if (!Object.hasOwn(ops, op)) fail('unknown operation');
  process.stdout.write(JSON.stringify(await ops[op]()));
} catch (error) {
  process.stderr.write(String(error?.message ?? error).split('\n')[0] + '\n');
  process.exit(1);
}
`;
