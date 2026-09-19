import { parentPort, workerData } from 'node:worker_threads';
import { createGzip } from 'node:zlib';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';

const key = Buffer.from(workerData.key);
const iv = crypto.randomBytes(12);
const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
key.fill(0);
const gzip = createGzip();
const chunks = [];
const output = pipeline(gzip, cipher, async source => {
  for await (const chunk of source) chunks.push(Buffer.from(chunk));
});
// Attach immediately: an error can arrive between protocol messages.
output.catch(error => parentPort.postMessage({ error: error.message }));
let first = true;
gzip.write('{"version":1,"files":[');
parentPort.postMessage({ ready: true });
parentPort.on('message', async message => {
  try {
    if (message.end) {
      gzip.end(']}');
      await output;
      const encrypted = Buffer.concat([Buffer.from('KMX1'), iv, cipher.getAuthTag(), ...chunks]);
      const sha256 = crypto.createHash('sha256').update(encrypted).digest('hex');
      // Own the transfer buffer: pooled Buffer storage must never be detached.
      const bytes = new Uint8Array(encrypted.length);
      bytes.set(encrypted);
      parentPort.postMessage({ id: message.id, bytes, sha256 }, [bytes.buffer]);
      parentPort.close();
      return;
    }
    const { data, ...metadata } = message.file;
    const write = text => new Promise((resolve, reject) => gzip.write(text, error => error ? reject(error) : resolve()));
    const prefix = first ? '' : ',';
    first = false;
    if (data === undefined) await write(prefix + JSON.stringify(metadata));
    else {
      await write(prefix + JSON.stringify(metadata).slice(0, -1) + ',"data":"');
      const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
      // Multiples of three preserve base64 boundaries. Neither the full base64
      // string nor a second complete JSON representation is allocated.
      for (let offset = 0; offset < bytes.length; offset += 48 * 1024)
        await write(bytes.subarray(offset, offset + 48 * 1024).toString('base64'));
      await write('"}');
    }
    // Acknowledge only after zlib consumed this file. The caller cannot enqueue
    // the rest of the world's raw bytes while the worker is busy serializing.
    parentPort.postMessage({ id: message.id });
  } catch (error) {
    gzip.destroy(error);
    parentPort.postMessage({ error: error.message });
  }
});
