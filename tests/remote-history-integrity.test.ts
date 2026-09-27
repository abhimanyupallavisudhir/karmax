import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { remoteAgentHomeRelative, syncRemoteAgentHome } from '../src/agent/remote-process.js';
import { openLocalPty } from '../src/world/local-execution.js';
import type { World, WorldPty } from '../src/world/types.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function temp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-remote-history-'));
  dirs.push(dir);
  return dir;
}

/** node-pty destroys its terminal socket 200 ms after the child exits and
 * discards the bytes not yet read, so on a loaded host a command's final
 * output is lost (AD-30; how the Codex lineage tests failed on CI). Replay
 * that deterministically: after the command script is sent, withhold each
 * chunk until the next one arrives, and when the command's output is complete
 * (its end-of-output marker is withheld) end the transport, discarding the
 * withheld tail. */
function lossyWorld(root: string, loses: (terminal: number) => boolean): World {
  let terminals = 0;
  return {
    handle: { version: 2, kind: 'e2b', provider: 'e2b', sealedProviderRef: 'sealed', id: 'task', root, branch: 'task', base: 'main' },
    async openPty(spec) {
      const pty = await openLocalPty(root, spec);
      if (!loses(++terminals)) return pty;
      let writes = 0;
      let held: string | undefined;
      let ended = false;
      const outputs = new Set<(chunk: string) => void>();
      const exits = new Set<(code: number | null) => void>();
      pty.onData((chunk) => {
        if (ended) return;
        if (writes < 2) { for (const listener of outputs) listener(chunk); return; }
        if (held !== undefined) for (const listener of outputs) listener(held);
        held = chunk;
        if (/KARMAX_EXEC_[0-9a-f]+_EXIT:/.test(held)) {
          ended = true; // the transport ends with the tail unread
          for (const listener of exits) listener(0);
        }
      });
      pty.onExit((code) => { if (!ended) { ended = true; for (const listener of exits) listener(code); } });
      const lossy: WorldPty = {
        onData(listener) { outputs.add(listener); return () => outputs.delete(listener); },
        onExit(listener) { exits.add(listener); return () => exits.delete(listener); },
        write: (data) => { writes++; return pty.write(data); },
        resize: (cols, rows) => pty.resize(cols, rows),
        close: () => pty.close(),
      };
      return lossy;
    },
  } as World;
}

function rollout(root: string, localHome: string, id: string): { relative: string; absolute: string; content: Buffer } {
  const relative = remoteAgentHomeRelative('codex', localHome);
  const lines = [JSON.stringify({ type: 'session_meta', payload: { id, history_mode: 'paginated' } })];
  // Large enough to cross many terminal reads.
  for (let i = 0; i < 400; i++) lines.push(JSON.stringify({ type: 'response_item', payload: { text: `turn ${i} ${'x'.repeat(500)}` } }));
  const content = Buffer.from(lines.join('\n') + '\n');
  const file = path.join(root, relative, 'sessions/2026/09/27', `rollout-2026-09-27T00-00-00-${id}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return { relative, absolute: path.join(root, relative), content };
}

/** Length and digest of each host copy: a readable diff for a truncated one. */
function hostCopies(localHome: string, id: string): string[] {
  const sessions = path.join(localHome, 'sessions');
  if (!fs.existsSync(sessions)) return [];
  return fs.readdirSync(sessions, { recursive: true }).map(String).filter((file) => file.endsWith(`${id}.jsonl`))
    .map((file) => digest(fs.readFileSync(path.join(sessions, file))));
}
function digest(content: Buffer): string {
  return `${content.length} ${crypto.createHash('sha256').update(content).digest('hex')}`;
}

it.each([
  ['listing', (terminal: number) => terminal % 2 === 1],
  ['rollout read', (terminal: number) => terminal % 2 === 0],
])('exports the complete Codex history when a sandbox %s loses its final output', async (_, loses) => {
  const root = temp(), localHome = temp();
  const id = '01a0e28b-93ca-7d81-9d6f-2f82e8b44912';
  const { relative, absolute, content } = rollout(root, localHome, id);
  await syncRemoteAgentHome(lossyWorld(root, loses), 'codex', { relative, absolute }, localHome, id);
  expect(hostCopies(localHome, id)).toEqual([digest(content)]);
}, 30_000);

it('publishes nothing when every sandbox read loses its final output', async () => {
  const root = temp(), localHome = temp();
  const id = '01a0e28b-93ca-7d81-9d6f-2f82e8b44913';
  const { relative, absolute } = rollout(root, localHome, id);
  await expect(syncRemoteAgentHome(lossyWorld(root, () => true), 'codex', { relative, absolute }, localHome, id))
    .rejects.toThrow('incomplete');
  expect(hostCopies(localHome, id)).toEqual([]);
}, 30_000);
