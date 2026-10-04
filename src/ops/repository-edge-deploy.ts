import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

/**
 * Deploys the resource repositories' edge (src/edge/resource-repository-worker.ts)
 * as a Cloudflare Worker bound to the managed R2 bucket, with Cloudflare's API
 * alone: no wrangler, no state outside the account. Repeatable; each run
 * replaces the script and its bindings. `deploy/karmax deploy-repository-edge`.
 */

export const EDGE_SCRIPT = 'tavya-resource-repositories';
/** The workerd behaviour the Worker is written against. */
const COMPATIBILITY_DATE = '2026-09-01';
const API = 'https://api.cloudflare.com/client/v4';
const SOURCE = path.join(path.dirname(fileURLToPath(import.meta.url)), '../edge/resource-repository-worker.ts');

/** The account and jurisdiction of an R2 S3 endpoint (`https://<account>[.eu|.fedramp].r2.cloudflarestorage.com`). */
export function r2Target(endpoint: string): { accountId: string; jurisdiction?: string } {
  const match = /^https:\/\/([0-9a-f]{32})(?:\.([a-z]+))?\.r2\.cloudflarestorage\.com\/?$/.exec(endpoint.trim());
  if (!match) throw new Error(`the managed object store is not Cloudflare R2 (${endpoint || 'no endpoint'}); the edge needs an R2 bucket`);
  return { accountId: match[1]!, ...(match[2] ? { jurisdiction: match[2] } : {}) };
}

export async function bundleRepositoryEdge(): Promise<string> {
  const result = await build({ entryPoints: [SOURCE], bundle: true, format: 'esm', platform: 'neutral', target: 'es2022',
    write: false, minify: false, logLevel: 'silent' });
  return result.outputFiles[0]!.text;
}

export interface EdgeDeployment {
  apiToken: string;
  accountId: string;
  bucket: string;
  jurisdiction?: string;
  /** tavya's public URL, where the edge sends everything it does not serve itself. */
  origin: string;
  /** The repository grant key (vault `resource-repositories:token-key`), base64. */
  tokenKey: string;
  script?: string;
  fetch?: typeof fetch;
}

/** Upload the Worker and serve it on the account's workers.dev subdomain; returns its URL. */
export async function deployRepositoryEdge(options: EdgeDeployment): Promise<string> {
  const fetcher = options.fetch ?? fetch;
  const script = options.script ?? EDGE_SCRIPT;
  const account = `${API}/accounts/${options.accountId}/workers`;
  const call = async <T>(method: string, url: string, body?: FormData | object): Promise<T> => {
    const json = body !== undefined && !(body instanceof FormData);
    const response = await fetcher(url, { method, headers: { authorization: `Bearer ${options.apiToken}`,
      ...(json ? { 'content-type': 'application/json' } : {}) }, ...(body === undefined ? {} : { body: json ? JSON.stringify(body) : body as FormData }) });
    const reply = await response.json().catch(() => ({})) as { success?: boolean; result?: T; errors?: Array<{ code?: number; message?: string }> };
    if (!response.ok || reply.success === false) {
      const reason = reply.errors?.map((error) => `${error.message ?? 'error'}${error.code ? ` (${error.code})` : ''}`).join('; ') || `HTTP ${response.status}`;
      throw new Error(`Cloudflare refused ${method} ${url.slice(API.length)}: ${reason}${response.status === 403
        ? '. The API token needs Workers Scripts: Edit and Workers R2 Storage: Edit on this account' : ''}`);
    }
    return reply.result as T;
  };

  const form = new FormData();
  form.set('metadata', new Blob([JSON.stringify({
    main_module: 'worker.js',
    compatibility_date: COMPATIBILITY_DATE,
    bindings: [
      { type: 'r2_bucket', name: 'BUCKET', bucket_name: options.bucket, ...(options.jurisdiction ? { jurisdiction: options.jurisdiction } : {}) },
      { type: 'secret_text', name: 'TOKEN_KEY', text: options.tokenKey },
      { type: 'plain_text', name: 'ORIGIN', text: options.origin.replace(/\/+$/, '') },
    ],
  })], { type: 'application/json' }));
  form.set('worker.js', new Blob([await bundleRepositoryEdge()], { type: 'application/javascript+module' }), 'worker.js');
  await call('PUT', `${account}/scripts/${script}`, form);

  const subdomain = (await call<{ subdomain?: string } | null>('GET', `${account}/subdomain`).catch((error: Error) => {
    if (/subdomain|10007/i.test(error.message)) return null;
    throw error;
  }))?.subdomain;
  if (!subdomain) throw new Error('this Cloudflare account has no workers.dev subdomain yet: choose one under Workers & Pages, then run this again');
  await call('POST', `${account}/scripts/${script}/subdomain`, { enabled: true, previews_enabled: false });
  return `https://${script}.${subdomain}.workers.dev`;
}
