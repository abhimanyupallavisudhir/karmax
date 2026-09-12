import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { ConfigHomeManager, isLoggedIn } from '../src/autonomy/config-homes.js';
import { materializeFork, findProviderSession, claudeCwdSlug } from '../src/agent/fork.js';
import { prepareCodexHistory } from '../src/agent/codex-history.js';
import { readLocalCodexHistory } from '../src/agent/codex-history-files.js';

const roots: string[] = [];
const temp = () => { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'login-history-')); roots.push(root); return root; };
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function write(home: string, file: string, content: string) {
  fs.mkdirSync(path.dirname(path.join(home, file)), { recursive: true });
  fs.writeFileSync(path.join(home, file), content);
}

describe('disconnecting a login preserves task history', () => {
  it('keeps a Codex fork and archived ancestor readable through disconnect and reconnect', async () => {
    const homes = new ConfigHomeManager(temp());
    const home = homes.ensure('codex', 'personal');
    const parent = crypto.randomUUID(), session = crypto.randomUUID();
    const line = (value: unknown) => JSON.stringify(value) + '\n';
    const ancestor = line({ type: 'session_meta', ordinal: 0, payload: {
      id: parent, history_mode: 'paginated', timestamp: '2026-08-14T22:00:00Z',
    } }) + line({ type: 'response_item', ordinal: 1, payload: { type: 'message', role: 'user', content: [] } });
    const leaf = line({ type: 'session_meta', ordinal: 2, payload: {
      id: session, history_mode: 'paginated', timestamp: '2026-08-14T22:01:00Z',
      history_base: { thread_id: parent, end_byte_offset: Buffer.byteLength(ancestor), end_ordinal_exclusive: 2 },
    } });
    write(home, `archived_sessions/rollout-2026-08-14T22-00-00-${parent}.jsonl`, ancestor);
    write(home, `sessions/rollout-2026-08-14T22-01-00-${session}.jsonl`, leaf);
    write(home, 'auth.json', '{"token":"old-credential"}');
    write(home, 'karmax-oauth.json', '{"token":"captured-credential"}');
    write(home, 'config.toml', 'secret = "old-config"');
    const snapshot = () => prepareCodexHistory(session, async id => readLocalCodexHistory(home, id), { snapshot: true });
    const before = await snapshot();
    expect(isLoggedIn('codex', home)).toBe(true);
    homes.remove('codex', 'personal');
    expect(homes.list()).toEqual([]);
    expect(isLoggedIn('codex', home)).toBe(false);
    expect(fs.existsSync(path.join(home, 'config.toml'))).toBe(false);
    // The task's recorded home and session remain unchanged.
    expect((await snapshot())?.content).toEqual(before?.content);
    const destination = temp();
    expect(materializeFork({ provider: 'codex', session, srcHome: home, forkHome: destination, worldPath: '/new' })).toBe(true);
    expect(readLocalCodexHistory(destination, parent).content.toString()).toBe(ancestor);
    homes.remove('codex', 'personal'); // repeated disconnect must also be safe
    expect(homes.ensure('codex', 'personal')).toBe(home);
    expect(homes.list()).toEqual([]); // status polling must not reactivate the login
    expect(homes.prepareLogin('codex', 'personal')).toBe(home);
    write(home, 'auth.json', '{"token":"new-credential"}');
    expect(homes.list()).toEqual([expect.objectContaining({ account: 'personal', loggedIn: true })]);
    expect((await snapshot())?.content).toEqual(before?.content);
  });

  it('preserves Claude native history and subagents, while deleting both credential locations', () => {
    const homes = new ConfigHomeManager(temp());
    const home = homes.ensure('claude', 'personal');
    const session = crypto.randomUUID(), slug = claudeCwdSlug('/old');
    write(home, `projects/${slug}/${session}.jsonl`, '{"type":"user","message":"retained"}\n');
    write(home, `projects/${slug}/${session}/subagents/agent-child.jsonl`, '{"type":"assistant"}\n');
    write(home, '.credentials.json', '{"claudeAiOauth":{"accessToken":"secret"}}');
    write(home, '.claude/.credentials.json', '{"claudeAiOauth":{"accessToken":"secret"}}');
    write(home, 'karmax-oauth.json', '{"token":"secret"}');
    homes.remove('claude', 'personal');
    expect(homes.list()).toEqual([]);
    expect(isLoggedIn('claude', home)).toBe(false);
    expect(findProviderSession({ provider: 'claude', session, srcHome: home })).toBeDefined();
    expect(fs.readFileSync(path.join(home, `projects/${slug}/${session}/subagents/agent-child.jsonl`), 'utf8')).toContain('assistant');
    expect(materializeFork({ provider: 'claude', session, srcHome: home, forkHome: temp(), worldPath: '/new' })).toBe(true);
  });

  it('preserves OpenCode storage but removes its colocated auth, without touching another organization', () => {
    const homes = new ConfigHomeManager(temp());
    const home = homes.ensure('opencode', 'work', 'org_a');
    const other = homes.ensure('opencode', 'work', 'org_b');
    write(home, 'data/opencode/auth.json', '{"openai":{"type":"oauth"}}');
    write(home, 'data/opencode/opencode.db', 'native storage');
    write(home, 'data/opencode/storage/session/session.json', '{"id":"session"}');
    write(other, 'data/opencode/auth.json', '{"openai":{"type":"oauth"}}');
    homes.remove('opencode', 'work', 'org_a');
    expect(isLoggedIn('opencode', home)).toBe(false);
    expect(fs.readFileSync(path.join(home, 'data/opencode/opencode.db'), 'utf8')).toBe('native storage');
    expect(homes.list('org_a')).toEqual([]);
    expect(isLoggedIn('opencode', other)).toBe(true);
    expect(homes.list('org_b')).toHaveLength(1);
    homes.removeOrganization('org_a'); // whole-tenant deletion still erases retained history
    expect(fs.existsSync(home)).toBe(false);
  });

  it('unlinks history symlinks without following them into another home', () => {
    const homes = new ConfigHomeManager(temp());
    const home = homes.ensure('codex', 'personal');
    const outside = temp();
    write(outside, 'auth.json', 'unrelated credential');
    fs.symlinkSync(outside, path.join(home, 'sessions'), 'dir');
    homes.remove('codex', 'personal');
    expect(fs.existsSync(path.join(home, 'sessions'))).toBe(false);
    expect(fs.readFileSync(path.join(outside, 'auth.json'), 'utf8')).toBe('unrelated credential');
  });
});
