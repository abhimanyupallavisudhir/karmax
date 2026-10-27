import { afterAll, beforeAll, expect, it } from 'vitest';
import { appGrantFixture, type AppGrantFixture } from './helpers/app-grants.js';

// The audit row of a request says how it was signed in: which browser session,
// or which app grant (a CLI login, an MCP client, a personal token), from which
// address and program. On 2026-10-24 krmax's deletion was audited only as
// "interactive-human": the owner's browser and their CLI looked the same, and
// nobody could say which of them sent it (#737, #747).
let f: AppGrantFixture;
beforeAll(async () => { f = await appGrantFixture(); });
afterAll(async () => { await f.g.close(); });

async function auditOf(path: string): Promise<Array<Record<string, any>>> {
  const rows = await f.g.store.db.prepare('SELECT detail FROM audit_log WHERE action LIKE ? ORDER BY seq').all('http.patch.%') as Array<{ detail: string }>;
  return rows.map((row) => JSON.parse(row.detail)).filter((detail) => detail.path === path);
}

it('records whether a person acted through their browser or an app grant, and from where', async () => {
  const path = `/api/projects/${f.site.id}`;
  const { access_token } = await f.deviceLogin({}, 'manyu-laptop');
  const cli = await fetch(`${f.g.url}${path}`, { method: 'PATCH', body: JSON.stringify({ name: 'Site renamed' }),
    headers: { authorization: `Bearer ${access_token}`, 'content-type': 'application/json', 'user-agent': 'tavya-cli/9.9.9' } });
  expect(cli.status).toBe(200);
  expect((await f.call('PATCH', path, { cookie: f.cookie }, { name: 'Site' })).status).toBe(200);

  const [byCli, byBrowser] = await auditOf(path);
  expect(byCli).toMatchObject({ actor: { kind: 'interactive-human', userId: f.user.id },
    via: { kind: 'cli', name: 'manyu-laptop' }, userAgent: 'tavya-cli/9.9.9' });
  expect(byCli!.via.grantId).toEqual(expect.any(String));
  expect(byCli!.ip).toEqual(expect.any(String));
  expect(byBrowser).toMatchObject({ actor: { kind: 'interactive-human', userId: f.user.id }, via: { kind: 'browser' } });
  expect(byBrowser!.via.sessionId).toEqual(expect.any(String));
  // An identifier of the session, never its secret.
  expect(JSON.stringify(byBrowser)).not.toContain(decodeURIComponent(f.cookie.split('=')[1]!).split('.')[0]!);
});
