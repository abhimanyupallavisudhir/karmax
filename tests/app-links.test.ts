import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { stubGateway } from './helpers/stub-gateway.js';
import { PLATFORM_API_CATALOG } from '../src/platform/catalog.js';
import { routeCapability } from '../src/gateway/server.js';

/**
 * Verified links for the phone apps (wiki planned/native-apps-round-2 §
 * contracts 6): the console's host vouches for the app `io.tavya.app` with the
 * signing details an operator sets in Installation → Phone apps. Nothing set:
 * 404, so links keep opening in the browser.
 */
let h: Awaited<ReturnType<typeof stubGateway>>;
let operator: string;
const fingerprint = crypto.randomBytes(32).toString('hex');
const colons = fingerprint.toUpperCase().match(/../g)!.join(':');

beforeAll(async () => {
  h = await stubGateway();
  const { token, record } = await h.tokens.mintPrincipal('user:root', ['*']);
  await h.store.putScopedToken(crypto.createHash('sha256').update(token).digest('hex'), record.id,
    { ...record, humanSubject: { kind: 'user', userId: 'root', presence: 'delegated' } } as any, record.expiresAt);
  operator = token;
});
afterAll(async () => { await h.close(); });

const get = (path: string) => fetch(`${h.base}${path}`, { redirect: 'manual' });
const settings = (method: string, body?: unknown, token = operator) => fetch(`${h.base}/api/settings/app-links`, { method,
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });

describe('verified app links', () => {
  it('are 404 until set', async () => {
    expect((await get('/.well-known/assetlinks.json')).status).toBe(404);
    expect((await get('/.well-known/apple-app-site-association')).status).toBe(404);
    expect(await (await settings('GET')).json()).toEqual({ settings: { androidCertFingerprints: [] } });
  });

  it('validate what the operator sets, normalizing fingerprints as keytool prints them', async () => {
    expect((await settings('PUT', { androidCertFingerprints: ['nope'] })).status).toBe(400);
    expect((await settings('PUT', { appleTeamId: 'short' })).status).toBe(400);
    const saved = await settings('PUT', { androidCertFingerprints: [fingerprint, colons.toLowerCase()], appleTeamId: 'abcde12345' });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ settings: { androidCertFingerprints: [colons], appleTeamId: 'ABCDE12345' } });
  });

  it('serve assetlinks.json and apple-app-site-association as JSON, without a redirect', async () => {
    const android = await get('/.well-known/assetlinks.json');
    expect(android.status).toBe(200);
    expect(android.headers.get('content-type')).toMatch(/^application\/json/);
    expect(await android.json()).toEqual([{ relation: ['delegate_permission/common.handle_all_urls'],
      target: { namespace: 'android_app', package_name: 'io.tavya.app', sha256_cert_fingerprints: [colons] } }]);
    const apple = await get('/.well-known/apple-app-site-association');
    expect(apple.status).toBe(200);
    expect(apple.headers.get('content-type')).toMatch(/^application\/json/);
    const association = await apple.json() as any;
    const [detail] = association.applinks.details;
    expect(detail.appIDs).toEqual(['ABCDE12345.io.tavya.app']);
    // Console pages open in the app; the public site, the API and sign-in pages stay in the browser.
    expect(detail.components.at(-1)).toEqual({ '/': '*' });
    for (const path of ['/', '/api/*', '/oauth/*', '/docs*', '/device*'])
      expect(detail.components).toContainEqual({ '/': path, exclude: true });
  });

  it('carry the store listings, public in /api/launch for the download page', async () => {
    expect((await settings('PUT', { appStoreUrl: 'https://evil.example/app' })).status).toBe(400);
    expect((await settings('PUT', { playStoreUrl: 'http://play.google.com/store/apps/details?id=io.tavya.app' })).status).toBe(400);
    expect(((await (await get('/api/launch')).json()) as any).appStores).toEqual({ ios: null, android: null });
    const saved = await settings('PUT', { androidCertFingerprints: [colons], appleTeamId: 'ABCDE12345',
      appStoreUrl: 'https://apps.apple.com/app/tavya/id123', playStoreUrl: 'https://play.google.com/store/apps/details?id=io.tavya.app' });
    expect(saved.status).toBe(200);
    expect(((await (await get('/api/launch')).json()) as any).appStores).toEqual({ ios: 'https://apps.apple.com/app/tavya/id123',
      android: 'https://play.google.com/store/apps/details?id=io.tavya.app' });
  });

  it('are an installation setting with an API route in the catalog', async () => {
    expect(routeCapability('GET', '/api/settings/app-links')).toBe('settings:read');
    expect(routeCapability('PUT', '/api/settings/app-links')).toBe('settings:write');
    expect(JSON.stringify(PLATFORM_API_CATALOG)).toContain('/api/settings/app-links');
    // Clearing them withdraws both files.
    expect((await settings('PUT', { androidCertFingerprints: [], appleTeamId: null })).status).toBe(200);
    expect((await get('/.well-known/assetlinks.json')).status).toBe(404);
  });
});
