import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { EDGE_MARKER } from '../edge/resource-repository-worker.js';

/**
 * Deploys the resource repositories' edge (src/edge/resource-repository-worker.ts)
 * as a Cloudflare Worker with Cloudflare's API alone: no wrangler, no state
 * outside the account. The Worker knows only tavya's URL. Repeatable; each run
 * replaces the script. `deploy/karmax deploy-repository-edge`.
 */

export const EDGE_SCRIPT = 'tavya-resource-repositories';
/** The workerd behaviour the Worker is written against. */
const COMPATIBILITY_DATE = '2026-09-01';
const API = 'https://api.cloudflare.com/client/v4';
const READY_ANSWERS = 5;
const SOURCE = path.join(path.dirname(fileURLToPath(import.meta.url)), '../edge/resource-repository-worker.ts');

/** The Cloudflare account to deploy to: `CLOUDFLARE_ACCOUNT_ID`, else the one
 * whose R2 bucket is the managed store (`https://<account>[.eu].r2.cloudflarestorage.com`). */
export function cloudflareAccount(env: NodeJS.ProcessEnv): string {
  const explicit = env.CLOUDFLARE_ACCOUNT_ID?.trim();
  if (explicit) return explicit;
  const match = /^https:\/\/([0-9a-f]{32})(?:\.[a-z]+)?\.r2\.cloudflarestorage\.com\/?$/.exec(env.KARMAX_S3_ENDPOINT?.trim() ?? '');
  if (!match) throw new Error('set CLOUDFLARE_ACCOUNT_ID (the managed store is not an R2 bucket that names one)');
  return match[1]!;
}

export async function bundleRepositoryEdge(): Promise<string> {
  const result = await build({ entryPoints: [SOURCE], bundle: true, format: 'esm', platform: 'neutral', target: 'es2022',
    write: false, minify: false, logLevel: 'silent' });
  return result.outputFiles[0]!.text;
}

export interface EdgeDeployment {
  apiToken: string;
  accountId: string;
  /** tavya's public URL. */
  origin: string;
  script?: string;
  fetch?: typeof fetch;
  /** How long to wait for the new URL to serve the Worker (default 2 minutes). */
  readyTimeoutMs?: number;
  /** Between readiness checks (default 2 s). */
  readyIntervalMs?: number;
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
        ? '. The API token needs Workers Scripts: Edit on this account' : ''}`);
    }
    return reply.result as T;
  };

  const form = new FormData();
  form.set('metadata', new Blob([JSON.stringify({
    main_module: 'worker.js',
    compatibility_date: COMPATIBILITY_DATE,
    bindings: [{ type: 'plain_text', name: 'ORIGIN', text: options.origin.replace(/\/+$/, '') }],
  })], { type: 'application/json' }));
  form.set('worker.js', new Blob([await bundleRepositoryEdge()], { type: 'application/javascript+module' }), 'worker.js');
  await call('PUT', `${account}/scripts/${script}`, form);

  const subdomain = (await call<{ subdomain?: string } | null>('GET', `${account}/subdomain`).catch((error: Error) => {
    if (/subdomain|10007/i.test(error.message)) return null;
    throw error;
  }))?.subdomain;
  if (!subdomain) throw new Error('this Cloudflare account has no workers.dev subdomain yet: choose one under Workers & Pages, then run this again');
  await call('POST', `${account}/scripts/${script}/subdomain`, { enabled: true, previews_enabled: false });
  const url = `https://${script}.${subdomain}.workers.dev`;
  // A new workers.dev route takes a while to reach every location: until then
  // Cloudflare answers 404 (which restic would take for a missing repository),
  // and for a few seconds after the first answer it still alternates. Ready is
  // five answers in a row.
  const deadline = Date.now() + (options.readyTimeoutMs ?? 120_000);
  for (let served = 0; served < READY_ANSWERS;) {
    const answer = await fetcher(`${url}/`, { signal: AbortSignal.timeout(10_000) }).then((r) => r.text()).catch(() => '');
    served = answer.startsWith(EDGE_MARKER) ? served + 1 : 0;
    if (served < READY_ANSWERS && Date.now() > deadline)
      throw new Error(`deployed, but ${url} does not serve the Worker reliably yet; run this again in a few minutes`);
    if (served < READY_ANSWERS) await new Promise((resolve) => setTimeout(resolve, options.readyIntervalMs ?? 2_000));
  }
  return url;
}
