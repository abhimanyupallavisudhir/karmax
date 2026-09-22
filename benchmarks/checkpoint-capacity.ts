/** Isolated CPU/latency comparison; no real worlds, database, keys, or storage. */
import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setTimeout as pause } from 'node:timers/promises';
import { encodePortableDelta } from '../src/world/checkpoint-encoding.js';
import { encodeEncryptedCheckpoint } from '../src/world/checkpoint-executor.js';

const data = crypto.randomBytes(24 * 1024 * 1024);
const key = crypto.randomBytes(32);
async function measure(operation: () => Promise<unknown>) {
  let last = performance.now(), maxTimerDelayMs = 0, ticks = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    maxTimerDelayMs = Math.max(maxTimerDelayMs, now - last - 10);
    last = now; ticks++;
  }, 10);
  await pause(20);
  const start = performance.now();
  try {
    await operation();
    const durationMs = performance.now() - start;
    await pause(20); // observe a final synchronous stall before stopping the timer
    return { durationMs, maxTimerDelayMs, ticks };
  } finally { clearInterval(timer); }
}
const mainThread = await measure(async () => {
  async function* files() { yield { repo: '', path: 'binary', data: data.toString('base64') }; }
  const compressed = await encodePortableDelta(files());
  const cipher = crypto.createCipheriv('aes-256-gcm', key, crypto.randomBytes(12));
  const encrypted = Buffer.concat([cipher.update(compressed), cipher.final()]);
  crypto.createHash('sha256').update(encrypted).digest('hex');
});
const isolated = await measure(async () => {
  async function* files() { yield { repo: '', path: 'binary', data }; }
  await encodeEncryptedCheckpoint(files(), key);
});
console.log(JSON.stringify({ fixture: { files: 1, bytes: data.length }, mainThread, isolated,
  peakRssBytes: process.resourceUsage().maxRSS * 1024 }, null, 2));
