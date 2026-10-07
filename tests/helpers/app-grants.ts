import crypto from 'node:crypto';
import { hostedGateway, type HostedGateway } from './browser.js';
import type { GatewayDeps } from '../../src/gateway/server.js';

/** A hosted gateway with real Better Auth and authorization, an owner of one
 * organization with two projects, and a helper to call it as that owner's
 * browser (cookie) or as any bearer. Shared by the app-grant/OAuth suites. */
export async function appGrantFixture(extra: Partial<GatewayDeps> = {}) {
  const g = await hostedGateway(() => ({ hostLocal: true, ...extra }));
  const password = 'long-fixture-password';
  const { user, organization } = await g.owner({ name: 'Ada', email: 'ada@example.test', password, organization: 'Acme' });
  const site = await g.store.createProject('Site', undefined, organization.id);
  const docs = await g.store.createProject('Docs', undefined, organization.id);
  const signIn = await fetch(`${g.url}/api/auth/sign-in/email`, { method: 'POST',
    headers: { origin: g.url, 'content-type': 'application/json', 'x-forwarded-for': `192.0.2.${crypto.randomInt(2, 250)}` },
    body: JSON.stringify({ email: user.email, password }) });
  if (signIn.status !== 200) throw new Error(`sign-in failed: ${signIn.status} ${await signIn.text()}`);
  const cookie = signIn.headers.get('set-cookie')?.match(/better-auth\.session_token=[^;]+/)?.[0] ?? '';
  /** JSON call as the signed-in browser (`cookie`) or a bearer. */
  const call = async (method: string, path: string, auth: { cookie?: string; bearer?: string } = { cookie }, body?: unknown) => {
    const response = await fetch(`${g.url}${path}`, { method, redirect: 'manual', headers: {
      origin: g.url, ...(auth.cookie ? { cookie: auth.cookie } : {}), ...(auth.bearer ? { authorization: `Bearer ${auth.bearer}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const text = await response.text();
    let json: any; try { json = JSON.parse(text); } catch { json = text; }
    return { status: response.status, body: json, headers: response.headers };
  };
  /** A form post to an OAuth endpoint, as a CLI or MCP client sends it. */
  const form = async (path: string, fields: Record<string, string>) => {
    const response = await fetch(`${g.url}${path}`, { method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields) });
    return { status: response.status, body: await response.json() as any, headers: response.headers };
  };
  /** Device login approved by the owner with an optional limit; returns the token response. */
  const deviceLogin = async (limit: Record<string, unknown> = {}, name = 'laptop') => {
    const start = await form('/oauth/device', { client_id: 'tavya-cli', name });
    const approved = await call('POST', '/api/oauth/device/approve', { cookie }, { code: start.body.user_code, ...limit });
    if (approved.status !== 200) throw new Error(`approve: ${approved.status} ${JSON.stringify(approved.body)}`);
    const token = await form('/oauth/token', { grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: start.body.device_code, client_id: 'tavya-cli' });
    if (token.status !== 200) throw new Error(`token: ${token.status} ${JSON.stringify(token.body)}`);
    return token.body as { access_token: string; refresh_token: string; scope: string; expires_in: number };
  };
  return { g, user, organization, site, docs, cookie, password, call, form, deviceLogin };
}

export type AppGrantFixture = Awaited<ReturnType<typeof appGrantFixture>>;
export type { HostedGateway };

export const pkce = () => {
  const verifier = crypto.randomBytes(32).toString('base64url');
  return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') };
};
