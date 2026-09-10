import fs from 'node:fs';
import path from 'node:path';
import { claudeCwdSlug, findProviderSession } from './fork.js';
import crypto from 'node:crypto';
import { atomicPrivateWrite } from './codex-history-files.js';
import { isRemoteAgentWorld, remoteAgentHomeRelative } from './remote-process.js';
import { worldWorkingDirectory, type World } from '../world/types.js';

/** Older panagent exports could put Codex free-form arguments in tool_use.input.
 * Recover into a fresh native session: never rewrite a source another task forks.
 * Prefer the live world's history, which may have advanced beyond the host copy. */
export async function recoverClaudeToolInputs(opts: {
  session: string; configHome: string; world: World;
}): Promise<string | undefined> {
  if (!/^[a-zA-Z0-9_-]{8,160}$/.test(opts.session)) return;
  const cwd = worldWorkingDirectory(opts.world.handle);
  const relative = path.posix.join('projects', claudeCwdSlug(cwd), `${opts.session}.jsonl`);
  let data: Buffer | undefined;
  if (isRemoteAgentWorld(opts.world)) {
    const remoteFile = path.posix.join(remoteAgentHomeRelative('claude', opts.configHome), relative);
    // Missing remote history is normal before the first seed. Other read errors
    // must not silently replace a newer remote history with an older host copy.
    const exists = await opts.world.exec('test', ['-f', path.posix.join(opts.world.handle.root, remoteFile)]);
    if (exists.code === 0) data = await opts.world.readFileBuffer(remoteFile);
    else if (exists.code !== 1) throw new Error('Could not inspect remote Claude history');
  }
  if (!data) {
    const exact = path.join(opts.configHome, relative);
    const file = fs.existsSync(exact) ? exact : findProviderSession({
      provider: 'claude', session: opts.session, srcHome: opts.configHome,
    });
    if (!file) return;
    data = fs.readFileSync(file);
  }
  let changed = false;
  const repaired = crypto.randomUUID();
  const lines = data.toString('utf8').split('\n').map((line) => {
    if (!line.trim()) return line;
    let record: any;
    try { record = JSON.parse(line); } catch { return line; } // Leave truncated/provider-owned lines to the SDK.
    if (!record || typeof record !== 'object') return line;
    const content = record.message?.content;
    if (Array.isArray(content)) for (const block of content) {
      if (block?.type === 'tool_use'
        && (!block.input || typeof block.input !== 'object' || Array.isArray(block.input))) {
        block.input = block.input === undefined ? {} : { input: block.input };
        changed = true;
      }
    }
    // Keep native UUID chains, signed reasoning, tool results, and metadata.
    // Only the session identity and invalid inputs differ in this recovery copy.
    if (record.sessionId === opts.session) record.sessionId = repaired;
    return JSON.stringify(record);
  });
  if (!changed) return;
  atomicPrivateWrite(path.join(opts.configHome, 'projects', claudeCwdSlug(cwd), `${repaired}.jsonl`),
    Buffer.from(lines.join('\n')));
  return repaired;
}
