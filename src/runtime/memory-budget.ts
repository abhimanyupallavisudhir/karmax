import fs from 'node:fs';
import os from 'node:os';
import v8 from 'node:v8';
import { fileURLToPath } from 'node:url';

/**
 * One memory budget for the app container (RT-35). V8 sizes each heap from the
 * host's memory, not the container's, and knows nothing of the other heaps
 * beside it: the gateway, the worker child's main heap (activities) and its
 * workflow thread (every cached workflow), which is a separate isolate that
 * takes the same --max-old-space-size as its process. Before this the three
 * could claim about 6 GB in a 4 GiB container, and the worker died at V8's own
 * limit while the container still had room.
 *
 * Every heap at its limit together leaves a quarter of the container for
 * native memory: code, buffers, Temporal's Rust core and its sticky cache,
 * and git/restic children. Process mode: the gateway 15%, each worker isolate
 * 30%. One combined process: each of its two isolates 37.5%.
 */
export interface MemoryBudget {
  limitMb: number;
  gatewayHeapMb: number;
  /** Each of the worker's two isolates (its process and its workflow thread). */
  workerHeapMb: number;
}

const MiB = 1024 * 1024;
const GATEWAY_SHARE = 0.15;
const WORKER_ISOLATE_SHARE = 0.3;
const COMBINED_ISOLATE_SHARE = 0.375;
const WORKER_FLOOR_MB = 192;
const GATEWAY_FLOOR_MB = 128;

type ReadFile = (file: string) => string;
const readFile: ReadFile = (file) => fs.readFileSync(file, 'utf8');

/** The cgroup memory limit this process runs under (v2, then v1), else the
 * host's memory. "max" and v1's near-2^63 sentinel both mean unlimited. */
export function containerMemoryLimit(read: ReadFile = readFile, hostBytes = os.totalmem()): number {
  for (const file of ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes']) {
    let value: string;
    try { value = read(file).trim(); } catch { continue; }
    const bytes = Number(value);
    if (value === 'max' || !Number.isFinite(bytes) || bytes <= 0) return hostBytes;
    return Math.min(bytes, hostBytes);
  }
  return hostBytes;
}

export function memoryBudget(options: { limitBytes?: number; separateWorker: boolean; env?: NodeJS.ProcessEnv }): MemoryBudget {
  const explicit = (options.env ?? process.env).KARMAX_MEMORY_LIMIT_MB?.trim();
  if (explicit && !(Number.isSafeInteger(Number(explicit)) && Number(explicit) > 0))
    throw new Error('KARMAX_MEMORY_LIMIT_MB must be a positive whole number of MiB');
  const limitMb = explicit ? Number(explicit) : Math.floor((options.limitBytes ?? containerMemoryLimit()) / MiB);
  if (!options.separateWorker) {
    const heap = Math.max(WORKER_FLOOR_MB, Math.floor(limitMb * COMBINED_ISOLATE_SHARE));
    return { limitMb, gatewayHeapMb: heap, workerHeapMb: heap };
  }
  return { limitMb, gatewayHeapMb: Math.max(GATEWAY_FLOOR_MB, Math.floor(limitMb * GATEWAY_SHARE)),
    workerHeapMb: Math.max(WORKER_FLOOR_MB, Math.floor(limitMb * WORKER_ISOLATE_SHARE)) };
}

/** The sticky workflow cache of the worker this process hosts. */
export interface WorkflowCacheStatus {
  /** Workflow executions cached now. */
  cached: number;
  /** The cache's current capacity; lower than configured after a shrink. */
  limit: number;
  /** How many times heap pressure has shrunk it since the process started. */
  shrinks: number;
}

export interface HeapUsage { heapUsed: number; heapLimit: number }

/** What /api/metrics reports for one Node process: its main heap, and if it
 * hosts the worker, the workflow thread's separate heap and the cache in it. */
export interface ProcessMemory extends HeapUsage {
  rss: number;
  workflowHeap?: HeapUsage;
  workflowCache?: WorkflowCacheStatus;
}

export function processMemory(worker: Pick<ProcessMemory, 'workflowHeap' | 'workflowCache'> = {}): ProcessMemory {
  const heap = v8.getHeapStatistics();
  return { heapUsed: heap.used_heap_size, heapLimit: heap.heap_size_limit, rss: process.memoryUsage.rss(),
    ...(worker.workflowHeap ? { workflowHeap: worker.workflowHeap } : {}),
    ...(worker.workflowCache ? { workflowCache: worker.workflowCache } : {}) };
}

export function separateWorkerMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.KARMAX_WORKER_MODE ?? 'combined') === 'process';
}

// `node --import tsx src/runtime/memory-budget.ts gateway|worker` prints that
// process's heap in MiB; the container's start command uses it for the
// gateway's own --max-old-space-size, which must be set before Node starts.
if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  const which = process.argv[2];
  if (which !== 'gateway' && which !== 'worker') {
    console.error('usage: memory-budget.ts gateway|worker');
    process.exit(2);
  }
  const budget = memoryBudget({ separateWorker: separateWorkerMode() });
  console.log(which === 'gateway' ? budget.gatewayHeapMb : budget.workerHeapMb);
}
