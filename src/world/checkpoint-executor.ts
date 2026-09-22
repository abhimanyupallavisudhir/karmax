import { Worker } from 'node:worker_threads';

export interface CheckpointFile { repo: string; path: string; deleted?: boolean; data?: Buffer }
export interface EncodedCheckpoint { encrypted: Buffer; sha256: string }
const MAX_WAITING = 16;
let active = false;
const waiting: Array<() => void> = [];
export function checkpointEncodingStats() { return { active: Number(active), waiting: waiting.length }; }

/** One CPU/memory-heavy checkpoint encoder per process. The pending queue holds
 * iterators, not file contents. Admission failure leaves the previous checkpoint
 * intact; callers may retry through their existing durable lifecycle activity. */
async function acquire(): Promise<() => void> {
  if (active) {
    if (waiting.length >= MAX_WAITING) throw new Error('checkpoint encoding capacity exceeded');
    await new Promise<void>(resolve => waiting.push(resolve));
  } else active = true;
  return () => {
    const next = waiting.shift();
    if (next) next();
    else active = false;
  };
}

/** Serialize/base64, compress, encrypt and hash off the gateway's event loop.
 * Retains the KMX1 envelope and portable-delta v1 bytes accepted by old restores.
 * At most one file is in flight; the object store still requires a final Buffer. */
export async function encodeEncryptedCheckpoint(files: AsyncIterable<CheckpointFile>, key: Buffer): Promise<EncodedCheckpoint> {
  const release = await acquire();
  let worker: Worker | undefined;
  try {
    worker = new Worker(new URL('./checkpoint-worker.mjs', import.meta.url), { workerData: { key },
      resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16 } });
    let failure: Error | undefined;
    let pending: { resolve: (value: any) => void; reject: (error: Error) => void } | undefined;
    let sequence = 0;
    let stopping = false;
    const fail = (error: Error) => { failure = error; pending?.reject(error); pending = undefined; };
    worker.on('error', fail);
    worker.on('exit', code => { if (!stopping) fail(new Error(`checkpoint encoder exited before completion (${code})`)); });
    worker.on('message', message => {
      if (message.error) { fail(new Error(`checkpoint encoding failed: ${message.error}`)); return; }
      if (message.ready || message.id === sequence) { pending?.resolve(message); pending = undefined; }
    });
    await new Promise<void>((resolve, reject) => { pending = { resolve, reject }; });
    const exchange = (message: object): Promise<any> => {
      if (failure) return Promise.reject(failure);
      sequence++;
      return new Promise((resolve, reject) => {
        pending = { resolve, reject };
        worker!.postMessage({ ...message, id: sequence });
      });
    };
    for await (const file of files) await exchange({ file });
    const result = await exchange({ end: true });
    stopping = true;
    return { encrypted: Buffer.from(result.bytes.buffer, result.bytes.byteOffset, result.bytes.byteLength), sha256: result.sha256 };
  } finally {
    try { await worker?.terminate(); } finally { release(); }
  }
}
