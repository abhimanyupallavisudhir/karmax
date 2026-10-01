import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { remoteAgentHomeRelative, syncRemoteAgentHome } from '../src/agent/remote-process.js';
import { openLocalPty, runLocalCommand } from '../src/world/local-execution.js';
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
function lossyWorld(root: string, loses: (terminal: number) => boolean, withExec = false): World {
  let terminals = 0;
  return {
    handle: { version: 2, kind: 'e2b', provider: 'e2b', sealedProviderRef: 'sealed', id: 'task', root, branch: 'task', base: 'main' },
    // With exec the sandbox measures its history in place and only the reads
    // cross the lossy terminal; without it every read and listing does.
    ...(withExec ? { exec: (command: string, args: string[]) => runLocalCommand(command, args, { cwd: root, env: process.env }) } : {}),
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
  ['listing', (terminal: number) => terminal % 2 === 1, false],
  ['rollout read', (terminal: number) => terminal % 2 === 0, false],
  ['measured tail read', (terminal: number) => terminal % 2 === 1, true],
])('exports the complete Codex history when a sandbox %s loses its final output', async (_, loses, withExec) => {
  const root = temp(), localHome = temp();
  const id = '01a0e28b-93ca-7d81-9d6f-2f82e8b44912';
  const { relative, absolute, content } = rollout(root, localHome, id);
  await syncRemoteAgentHome(lossyWorld(root, loses, withExec), 'codex', { relative, absolute }, localHome, id);
  expect(hostCopies(localHome, id)).toEqual([digest(content)]);
}, 30_000);

it.each([false, true])('publishes nothing when every sandbox read loses its final output (exec: %s)', async (withExec) => {
  const root = temp(), localHome = temp();
  const id = '01a0e28b-93ca-7d81-9d6f-2f82e8b44913';
  const { relative, absolute } = rollout(root, localHome, id);
  await expect(syncRemoteAgentHome(lossyWorld(root, () => true, withExec), 'codex', { relative, absolute }, localHome, id))
    .rejects.toThrow('incomplete');
  expect(hostCopies(localHome, id)).toEqual([]);
}, 30_000);

it('falls back to whole verified reads when a measured tail read keeps losing its output', async () => {
  const root = temp(), localHome = temp();
  const id = '01a0e28b-93ca-7d81-9d6f-2f82e8b44914';
  const { relative, absolute, content } = rollout(root, localHome, id);
  // The first three terminals (the tail read and its retries) lose their output; the full export's do not.
  await syncRemoteAgentHome(lossyWorld(root, (terminal) => terminal <= 3, true), 'codex', { relative, absolute }, localHome, id);
  expect(hostCopies(localHome, id)).toEqual([digest(content)]);
}, 30_000);

/** Bytes a sandbox printed to the host's terminals: what crossed the wire. */
function meteredWorld(root: string, withExec = true): { world: World; printed: () => number } {
  const inner = lossyWorld(root, () => false, withExec);
  let bytes = 0;
  return {
    printed: () => bytes,
    world: { ...inner, async openPty(spec) {
      const pty = await inner.openPty!(spec);
      pty.onData((chunk) => { bytes += Buffer.byteLength(chunk); });
      return pty;
    } } as World,
  };
}
function appendRecords(file: string, megabytes: number, label: string): void {
  const record = (i: number) => JSON.stringify({ type: 'response_item', payload: { text: `${label} ${i} ${'y'.repeat(1000)}` } });
  const lines: string[] = [];
  for (let i = 0; i < megabytes * 1024; i++) lines.push(record(i));
  fs.appendFileSync(file, lines.join('\n') + '\n');
}

// Native histories of long tasks reach 177 MiB on tavya.io. A 16 MiB cap on
// the whole file left LegiBench3 #10's last turns only in its sandbox
// ("remote history byte limit exceeded", 2026-09-30); one read is still
// bounded, so a long history crosses in several.
it('exports a history longer than one terminal read, then only what a turn appended', async () => {
  const root = temp(), localHome = temp();
  const id = '01a0e28b-93ca-7d81-9d6f-2f82e8b44915';
  const { relative, absolute } = rollout(root, localHome, id);
  const file = fs.readdirSync(absolute, { recursive: true }).map(String).find((name) => name.endsWith(`${id}.jsonl`))!;
  appendRecords(path.join(absolute, file), 20, 'early');
  const first = meteredWorld(root);
  await syncRemoteAgentHome(first.world, 'codex', { relative, absolute }, localHome, id);
  expect(hostCopies(localHome, id)).toEqual([digest(fs.readFileSync(path.join(absolute, file)))]);

  appendRecords(path.join(absolute, file), 2, 'late');
  const second = meteredWorld(root);
  await syncRemoteAgentHome(second.world, 'codex', { relative, absolute }, localHome, id);
  expect(hostCopies(localHome, id)).toEqual([digest(fs.readFileSync(path.join(absolute, file)))]);
  // Two appended MiB cross as base64 (about 2.7 MiB), not the whole history again.
  expect(second.printed()).toBeLessThan(4 * 1024 * 1024);
}, 120_000);

it('exports a history longer than one terminal read through whole verified reads', async () => {
  const root = temp(), localHome = temp();
  const id = '01a0e28b-93ca-7d81-9d6f-2f82e8b44917';
  const { relative, absolute } = rollout(root, localHome, id);
  const file = fs.readdirSync(absolute, { recursive: true }).map(String).find((name) => name.endsWith(`${id}.jsonl`))!;
  appendRecords(path.join(absolute, file), 20, 'early');
  // Without exec the sandbox cannot measure its history in place; every file crosses whole.
  await syncRemoteAgentHome(meteredWorld(root, false).world, 'codex', { relative, absolute }, localHome, id);
  expect(hostCopies(localHome, id)).toEqual([digest(fs.readFileSync(path.join(absolute, file)))]);
}, 120_000);

it.each([true, false])('refuses a history larger than the host accepts without reading it (exec: %s)', async (withExec) => {
  const root = temp(), localHome = temp();
  const id = withExec ? '01a0e28b-93ca-7d81-9d6f-2f82e8b44916' : '01a0e28b-93ca-7d81-9d6f-2f82e8b44918';
  const { relative, absolute } = rollout(root, localHome, id);
  const file = fs.readdirSync(absolute, { recursive: true }).map(String).find((name) => name.endsWith(`${id}.jsonl`))!;
  fs.truncateSync(path.join(absolute, file), 512 * 1024 * 1024 + 1); // sparse: no disk used
  const metered = meteredWorld(root, withExec);
  await expect(syncRemoteAgentHome(metered.world, 'codex', { relative, absolute }, localHome, id))
    .rejects.toThrow('remote history byte limit exceeded');
  expect(hostCopies(localHome, id)).toEqual([]);
  expect(metered.printed()).toBeLessThan(1024 * 1024);
}, 120_000);
