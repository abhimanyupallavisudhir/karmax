import type { Store } from '../store/db.js';

/**
 * Verified links for the phone apps (wiki features/phone-apps § links,
 * planned/native-apps-round-2 § contracts 6): Android App Links read
 * `/.well-known/assetlinks.json`, iOS universal links read
 * `/.well-known/apple-app-site-association`, both from the console's own host.
 * They name the app (`io.tavya.app`) and who signs it — the release signing
 * certificates' SHA-256 fingerprints (Play App Signing's and the upload key's)
 * and the Apple Team ID — set in Installation → Phone apps, so a self-hoster
 * who builds the apps under their own accounts sets their own. Unset: 404, and
 * links open in the browser as before.
 */
export const APP_PACKAGE = 'io.tavya.app';
export const ASSET_LINKS_PATH = '/.well-known/assetlinks.json';
export const APPLE_APP_SITE_ASSOCIATION_PATH = '/.well-known/apple-app-site-association';
const SETTINGS = ['global', 'app-links'] as const;

export interface AppLinkSettings {
  /** SHA-256 fingerprints of the Android signing certificates, `AA:BB:…` (32 bytes). */
  androidCertFingerprints: string[];
  /** The Apple Developer Team ID (10 characters). */
  appleTeamId?: string;
  /** The apps' store listings, shown on /download once published. */
  appStoreUrl?: string;
  playStoreUrl?: string;
}

/**
 * Paths that stay in the browser: the public site, the API, sign-in and
 * approval pages (a CLI's /device, an app's /oauth/consent: signing in happens
 * in the browser), shared links, Git and the downloads. Every other path is a
 * console page the app opens. The Android manifest's intent filters (mobile/)
 * list the same exclusions.
 */
export const APP_LINK_EXCLUDED_PATHS = ['/', '/docs*', '/pricing*', '/legal*', '/compare*', '/about*', '/changelog*',
  '/api/*', '/oauth/*', '/.well-known/*', '/device*', '/share/*', '/git/*', '/download/*', '/mcp*', '/ws*', '/link/*'];

export async function appLinkSettings(store: Pick<Store, 'getSettings'>): Promise<AppLinkSettings> {
  const raw = await store.getSettings(...SETTINGS) ?? {};
  const fingerprints = Array.isArray(raw.androidCertFingerprints) ? raw.androidCertFingerprints.filter((value): value is string => typeof value === 'string') : [];
  const text = (key: string) => typeof raw[key] === 'string' && raw[key] ? { [key]: raw[key] as string } : {};
  return { androidCertFingerprints: fingerprints, ...text('appleTeamId'), ...text('appStoreUrl'), ...text('playStoreUrl') };
}

/** The store listings, for public pages (GET /api/launch `appStores`). */
export async function appStores(store: Pick<Store, 'getSettings'>): Promise<{ ios: string | null; android: string | null }> {
  const settings = await appLinkSettings(store);
  return { ios: settings.appStoreUrl ?? null, android: settings.playStoreUrl ?? null };
}

/** A store listing's address: https on the store's own host, or undefined. */
function storeUrl(value: unknown, host: string): string | undefined | false {
  if (value === null || value === undefined || value === '') return undefined;
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:' && url.hostname === host && !url.username && !url.password ? url.href : false;
  } catch { return false; }
}

/** Normalize a fingerprint as `keytool -list` or the Play Console prints it (any case, colons optional). */
export function normalizeFingerprint(value: string): string | undefined {
  const hex = value.trim().replace(/:/g, '').toUpperCase();
  return /^[0-9A-F]{64}$/.test(hex) ? hex.match(/../g)!.join(':') : undefined;
}

/** Validate a PUT body: the whole settings (a field left out is cleared), or an error to answer with. */
export function parseAppLinkSettings(body: Record<string, unknown>): AppLinkSettings | string {
  const list = body.androidCertFingerprints ?? [];
  if (!Array.isArray(list) || list.length > 10 || list.some((value) => typeof value !== 'string'))
    return 'androidCertFingerprints must be a list of up to 10 SHA-256 certificate fingerprints';
  const fingerprints: string[] = [];
  for (const value of list as string[]) {
    const normalized = normalizeFingerprint(value);
    if (!normalized) return `Not a SHA-256 certificate fingerprint: ${value.slice(0, 120)}`;
    if (!fingerprints.includes(normalized)) fingerprints.push(normalized);
  }
  const team = body.appleTeamId === null || body.appleTeamId === undefined ? '' : body.appleTeamId;
  if (typeof team !== 'string' || (team.trim() && !/^[A-Z0-9]{10}$/.test(team.trim().toUpperCase())))
    return 'appleTeamId must be the 10-character Team ID from Apple Developer → Membership';
  const appStoreUrl = storeUrl(body.appStoreUrl, 'apps.apple.com');
  if (appStoreUrl === false) return 'appStoreUrl must be the app\'s https://apps.apple.com/… listing';
  const playStoreUrl = storeUrl(body.playStoreUrl, 'play.google.com');
  if (playStoreUrl === false) return 'playStoreUrl must be the app\'s https://play.google.com/… listing';
  return { androidCertFingerprints: fingerprints, ...(team.trim() ? { appleTeamId: team.trim().toUpperCase() } : {}),
    ...(appStoreUrl ? { appStoreUrl } : {}), ...(playStoreUrl ? { playStoreUrl } : {}) };
}

export async function saveAppLinkSettings(store: Pick<Store, 'setSettings'>, settings: AppLinkSettings): Promise<void> {
  await store.setSettings(...SETTINGS, { ...settings });
}

/** Digital Asset Links (Android App Links): undefined while no fingerprint is set. */
export function assetLinks(settings: AppLinkSettings): unknown[] | undefined {
  if (!settings.androidCertFingerprints.length) return undefined;
  return [{ relation: ['delegate_permission/common.handle_all_urls'],
    target: { namespace: 'android_app', package_name: APP_PACKAGE, sha256_cert_fingerprints: settings.androidCertFingerprints } }];
}

/** apple-app-site-association (iOS 13+ `components`): undefined while no Team ID is set. */
export function appleAppSiteAssociation(settings: AppLinkSettings): Record<string, unknown> | undefined {
  if (!settings.appleTeamId) return undefined;
  return { applinks: { details: [{ appIDs: [`${settings.appleTeamId}.${APP_PACKAGE}`],
    components: [...APP_LINK_EXCLUDED_PATHS.map((path) => ({ '/': path, exclude: true })), { '/': '*' }] }] } };
}
