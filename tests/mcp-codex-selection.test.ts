import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { selectedCodexMcpFlags } from '../src/mcp/connections/codex-selection.js';
import type { World } from '../src/world/types.js';

const world = { handle: { provider: 'worktree' } } as World;
describe('Codex selection fails closed without disclosing config', () => {
  async function inspect(source: string) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-config-test-'));
    try {
      const command = path.join(dir, 'codex');
      fs.writeFileSync(command, `#!${process.execPath}\n${source}`, { mode: 0o700 });
      return await selectedCodexMcpFlags(world, command, dir, {}, [], true);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
  it('disables each inherited connection for an explicit empty selection', async () => {
    expect(await inspect('console.log(JSON.stringify([{name:"legacy"},{name:"other-server"}]))')).toEqual(['-c', 'mcp_servers={}', '-c', 'mcp_servers.legacy.enabled=false', '-c', 'mcp_servers.other-server.enabled=false']);
  });
  it.each([
    ['malformed JSON', 'console.log("secret-do-not-disclose")', 'invalid MCP configuration'],
    ['invalid name', 'console.log(JSON.stringify([{name:"bad.name",token:"secret-do-not-disclose"}]))', 'Rename legacy'],
    ['non-array', 'console.log("{}")', 'too large or invalid'],
    ['oversized output', 'process.stdout.write("x".repeat(3*1024*1024))', 'too large'],
    ['process failure', 'console.error("secret-do-not-disclose");process.exit(1)', 'Could not inspect'],
  ])('rejects %s', async (_name, script, message) => {
    await expect(inspect(script)).rejects.toThrow(message);
  });
  it('rejects an unavailable command promptly', async () => {
    await expect(selectedCodexMcpFlags(world, '/missing-mcp-codex', os.tmpdir(), {}, [], true)).rejects.toThrow('Could not inspect');
  });
  it('honors cancellation before starting a process', async () => {
    await expect(selectedCodexMcpFlags(world, '/missing', os.tmpdir(), {}, [], true, AbortSignal.abort())).rejects.toThrow('cancelled');
  });
});
