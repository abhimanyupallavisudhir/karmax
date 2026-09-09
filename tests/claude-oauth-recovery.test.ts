import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { spawn } from 'node:child_process';

// Exercise the installed SDK and remote process bridge. Only the provider
// transport/service are simulated; credential projection and refresh are real.
import { ClaudeAdapter } from '../src/agent/claude.js';
import { remoteAgentHomeRelative } from '../src/agent/remote-process.js';

let root: string;
afterEach(() => { vi.unstubAllEnvs(); if (root) fs.rmSync(root, { recursive: true, force: true }); });

const expired = 'Failed to authenticate. API Error: 401 OAuth access token has expired. Re-authenticate to continue.';

describe('Claude OAuth recovery through the real SDK', () => {
  it.each(['structured', 'text', 'preflight', 'persistent', 'revoked', 'refresh-failed', 'cancelled'])('%s terminal credential outcome', async (mode) => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-oauth-wire-'));
    const home = path.join(root, 'canonical');
    fs.mkdirSync(home);
    const authFile = path.join(home, '.credentials.json');
    fs.writeFileSync(authFile, JSON.stringify({ claudeAiOauth: {
      accessToken: 'initial', refreshToken: 'canonical-only', expiresAt: mode === 'preflight' ? Date.now() - 1 : Date.now() + 3600_000,
    } }));
    const log = path.join(root, 'requests.jsonl');
    const server = path.join(root, 'server.cjs');
    fs.writeFileSync(server, `
const fs = require('fs'), path = require('path'), rl = require('readline');
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
rl.createInterface({ input: process.stdin }).on('line', line => {
  const msg = JSON.parse(line);
  if (msg.type === 'control_request') {
    send({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: { commands: [], agents: [], models: [] } } });
  } else if (msg.type === 'user') {
    const auth = JSON.parse(fs.readFileSync(path.join(process.env.CLAUDE_CONFIG_DIR, '.credentials.json'))).claudeAiOauth;
    fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ auth, command: process.env.KARMAX_TEST_REMOTE_COMMAND }) + '\\n');
    send({ type: 'system', subtype: 'init', session_id: 'continued-session' });
    const success = auth.accessToken === 'fresh' && ${JSON.stringify(mode)} !== 'persistent';
    if (success) {
      send({ type: 'assistant', session_id: 'continued-session', message: { content: [{ type: 'text', text: 'RECOVERED' }] } });
      send({ type: 'result', subtype: 'success', is_error: false, session_id: 'continued-session', result: 'RECOVERED', stop_reason: 'end_turn' });
    } else {
      send({ type: 'assistant', session_id: 'continued-session', ${mode === 'text' ? '' : "error: 'authentication_failed',"}
        message: { content: [{ type: 'text', text: ${JSON.stringify(mode === 'revoked' ? 'API Error: 401 OAuth grant revoked' : expired)} }] } });
      send({ type: 'result', subtype: 'success', is_error: true, errors: ['completed'], session_id: 'continued-session' });
    }
  }
});
`);
    const refresh = path.join(root, 'refresh.cjs');
    fs.writeFileSync(refresh, `#!${process.execPath}
const fs = require('fs');
fs.appendFileSync(${JSON.stringify(path.join(root, 'refreshes'))}, 'refresh\\n');
${mode === 'refresh-failed' ? 'process.exit(1);' : `fs.writeFileSync(${JSON.stringify(authFile)}, JSON.stringify({ claudeAiOauth: { accessToken: 'fresh', refreshToken: 'rotated-host-only', expiresAt: Date.now() + 3600000 } }));`}
`);
    fs.chmodSync(refresh, 0o755);
    vi.stubEnv('KARMAX_CLAUDE_USAGE_CMD', refresh);
    const world: any = {
      handle: { version: 2, kind: 'e2b', provider: 'e2b', sealedProviderRef: 'test-sealed', id: 'test', root, branch: 'task', base: 'main' },
      async openPty(spec: any) {
        const child = spawn(process.execPath, [server], {
          env: { ...process.env, ...spec.env, KARMAX_TEST_REMOTE_COMMAND: spec.command },
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        return {
          onData(listener: (data: string) => void) {
            const receive = (data: Buffer) => listener(data.toString());
            child.stdout.on('data', receive);
            queueMicrotask(() => listener('\u001eKARMAX_AGENT_READY\u001e'));
            return () => child.stdout.off('data', receive);
          },
          onExit(listener: (code: number) => void) {
            const exit = (code: number | null) => listener(code ?? 1);
            child.once('exit', exit);
            return () => child.off('exit', exit);
          },
          async write(data: string) { if (data === '\x04') child.stdin.end(); else child.stdin.write(data); },
          async close() { child.kill(); },
          async resize() {},
        };
      },
      exec: async (command: string, args: string[]) => ({ stdout: '', stderr: '',
        code: command === 'test' && !fs.existsSync(args[1]!) ? 1 : 0 }),
      writeFileBuffer: async (name: string, value: Buffer) => { const dest = path.join(root, name); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, value); },
      readFile: async (name: string) => fs.readFileSync(path.join(root, name), 'utf8'),
      readFileBuffer: async (name: string) => fs.readFileSync(path.join(root, name)),
    };
    const events: any[] = [];
    const controller = new AbortController();
    const result = await new ClaudeAdapter().runTurn({
      profile: { id: 'p', provider: 'claude', role: 'do', capabilities: [] }, world,
      resolvedAuth: { configHome: home }, session: 'original-session', fork: true, role: 'do', systemPrompt: 'Test',
      messages: [{ id: 'm', role: 'user', text: 'Continue', ts: 0 }],
    } as any, { signal: controller.signal, emit() {}, emitActivity: (e: any) => {
      events.push(e);
      if (mode === 'cancelled' && e.id === 'claude-credential-recovery' && e.phase === 'started') controller.abort();
    } } as any).catch(e => e);
    expect(fs.existsSync(log), String(result)).toBe(true);
    const attempts = fs.readFileSync(log, 'utf8').trim().split('\n').map(s => JSON.parse(s));
    if (mode === 'structured' || mode === 'text' || mode === 'preflight') {
      expect(result).toMatchObject({ output: 'RECOVERED', session: 'continued-session', termination: { kind: 'success' } });
    } else expect(result).toBeInstanceOf(Error);
    expect(attempts).toHaveLength(mode === 'revoked' || mode === 'refresh-failed' || mode === 'preflight' || mode === 'cancelled' ? 1 : 2);
    for (const attempt of attempts) expect(attempt.auth.refreshToken).toBeUndefined();
    if (attempts.length === 2) {
      expect(attempts[0].command).toContain('--fork-session');
      expect(attempts[1].command).toContain('--resume=continued-session');
      expect(attempts[1].command).not.toContain('--fork-session');
      expect(events).toContainEqual(expect.objectContaining({ id: 'claude-credential-recovery', phase: 'completed' }));
      expect(fs.readFileSync(path.join(root, 'refreshes'), 'utf8')).toBe('refresh\n');
    }
    const projected = JSON.parse(fs.readFileSync(path.join(root, remoteAgentHomeRelative('claude', home), '.credentials.json'), 'utf8'));
    expect(projected.claudeAiOauth.refreshToken).toBeUndefined();
  }, 20_000);
});
