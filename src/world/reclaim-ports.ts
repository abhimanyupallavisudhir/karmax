import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { World } from './types.js';

const SCRIPT = fs.readFileSync(fileURLToPath(new URL('./reclaim-ports.sh', import.meta.url)), 'utf8');

export interface ReclaimedPort { port: number; pid: number; command: string }

/** Stop stale listeners on `ports` inside an isolated world (src/world/reclaim-ports.sh).
 * The script is passed inline, so nothing is written into the task's tree. */
export async function reclaimPorts(world: Pick<World, 'exec'>, ports: Iterable<number>): Promise<ReclaimedPort[]> {
  const wanted = [...new Set(ports)].filter((port) => Number.isInteger(port) && port > 0 && port < 65_536);
  if (!wanted.length) return [];
  const result = await world.exec('sh', ['-c', SCRIPT, 'reclaim-ports', ...wanted.map(String)], { timeoutMs: 30_000 });
  return result.stdout.split('\n').flatMap((line) => {
    const match = /^(\d+) (\d+) ?(.*)$/.exec(line.trim());
    return match ? [{ port: Number(match[1]), pid: Number(match[2]), command: match[3] ?? '' }] : [];
  });
}
