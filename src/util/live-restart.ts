import path from 'node:path';
import { spawn } from 'node:child_process';
import type { WorldHandle } from '../world/types.js';
import { worldRepos } from '../world/types.js';

/** Whether a completed task merge landed into the checkout running this process. */
export function worldLandedInCheckout(handle: WorldHandle | undefined, checkout: string): boolean {
  if (!handle) return false;
  const wanted = normalizedPath(checkout);
  return worldRepos(handle).some((repo) => {
    const authority = repo.localPath ?? repo.repo;
    return path.isAbsolute(authority) && normalizedPath(authority) === wanted;
  });
}

export function replacementInvocation(
  execPath = process.execPath,
  execArgv = process.execArgv,
  argv = process.argv.slice(1),
): { command: string; args: string[] } {
  return { command: execPath, args: [...execArgv, ...argv] };
}

/** Start the successor only after the old gateway and worker have drained. */
export function spawnReplacementProcess(): void {
  const invocation = replacementInvocation();
  const child = spawn(invocation.command, invocation.args, {
    cwd: process.cwd(),
    env: { ...process.env, KARMAX_RESTARTED_FROM: String(process.pid) },
    detached: true,
    stdio: 'inherit',
  });
  child.unref();
}

function normalizedPath(value: string): string {
  return path.resolve(value).replace(/[\\/]+$/, '');
}
