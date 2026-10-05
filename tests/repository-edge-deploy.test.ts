import { expect, it } from 'vitest';
import { EDGE_SCRIPT, bundleRepositoryEdge, cloudflareAccount, deployRepositoryEdge } from '../src/ops/repository-edge-deploy.js';
import { EDGE_MARKER } from '../src/edge/resource-repository-worker.js';

const ACCOUNT = '35e42bcea7b0b9f09dce2860d587d418';

it('deploys to the named account, else to the one whose R2 bucket is the managed store', () => {
  expect(cloudflareAccount({ CLOUDFLARE_ACCOUNT_ID: 'acct', KARMAX_S3_ENDPOINT: `https://${ACCOUNT}.eu.r2.cloudflarestorage.com` })).toBe('acct');
  expect(cloudflareAccount({ KARMAX_S3_ENDPOINT: `https://${ACCOUNT}.eu.r2.cloudflarestorage.com` })).toBe(ACCOUNT);
  expect(cloudflareAccount({ KARMAX_S3_ENDPOINT: `https://${ACCOUNT}.r2.cloudflarestorage.com/` })).toBe(ACCOUNT);
  expect(() => cloudflareAccount({ KARMAX_S3_ENDPOINT: 'https://s3.eu-central-1.amazonaws.com' })).toThrow(/CLOUDFLARE_ACCOUNT_ID/);
});

it('bundles the Worker as one web-standard module', async () => {
  const code = await bundleRepositoryEdge();
  expect(code).toMatch(/export\s*\{[^}]*as default/);
  expect(code).not.toMatch(/\bfrom\s*["']node:|\brequire\(/);
  const worker = (await import(`data:text/javascript,${encodeURIComponent(code)}`)).default;
  expect((await worker.fetch(new Request('https://edge/elsewhere'), {})).status).toBe(404);
  expect(await (await worker.fetch(new Request('https://edge/'), {})).text()).toBe(`${EDGE_MARKER}\n`);
});

it('uploads the Worker with only tavya\'s URL, and serves it on workers.dev once the route is live', async () => {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  // The new route answers Cloudflare's 404 at first, then alternates for a while (measured), then the Worker.
  const route = ['404', 'worker', '404', 'worker', 'worker', 'worker', 'worker', 'worker'];
  const fake: typeof fetch = async (input, init) => {
    if (String(input) === `https://${EDGE_SCRIPT}.tavya.workers.dev/`) {
      calls.push({ method: 'GET', path: 'edge /' });
      return route.shift() === 'worker' ? new Response(`${EDGE_MARKER}\n`) : new Response('There is nothing here yet', { status: 404 });
    }
    const path = String(input).replace(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers`, '');
    let body: unknown;
    if (init?.body instanceof FormData) {
      body = { metadata: JSON.parse(await (init.body.get('metadata') as Blob).text()),
        module: await (init.body.get('worker.js') as Blob).text() };
    } else if (typeof init?.body === 'string') body = JSON.parse(init.body);
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer cf-token');
    calls.push({ method: init?.method ?? 'GET', path, ...(body ? { body } : {}) });
    const result = path === '/subdomain' ? { subdomain: 'tavya' } : {};
    return Response.json({ success: true, result });
  };
  const url = await deployRepositoryEdge({ apiToken: 'cf-token', accountId: ACCOUNT, origin: 'https://tavya.io/', fetch: fake, readyIntervalMs: 1 });
  expect(url).toBe(`https://${EDGE_SCRIPT}.tavya.workers.dev`);
  expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([`PUT /scripts/${EDGE_SCRIPT}`, 'GET /subdomain',
    `POST /scripts/${EDGE_SCRIPT}/subdomain`, ...Array(8).fill('GET edge /')]);
  expect(route).toEqual([]); // five answers in a row, after the last 404
  const upload = calls[0]!.body as { metadata: { main_module: string; bindings: unknown[] }; module: string };
  expect(upload.metadata.main_module).toBe('worker.js');
  // No secret and no bucket: tavya decides every upload and signs where it goes.
  expect(upload.metadata.bindings).toEqual([{ type: 'plain_text', name: 'ORIGIN', text: 'https://tavya.io' }]);
  expect(upload.module).toContain('resource-repositories/');
  expect(calls[2]!.body).toEqual({ enabled: true, previews_enabled: false });
});

it('says which permission a refused token lacks', async () => {
  const refused: typeof fetch = async () => Response.json({ success: false, errors: [{ code: 10000, message: 'Authentication error' }] }, { status: 403 });
  await expect(deployRepositoryEdge({ apiToken: 'x', accountId: ACCOUNT, origin: 'https://tavya.io', fetch: refused }))
    .rejects.toThrow(/Authentication error \(10000\).*Workers Scripts: Edit/);
});
