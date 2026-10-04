import { expect, it } from 'vitest';
import { EDGE_SCRIPT, bundleRepositoryEdge, deployRepositoryEdge, r2Target } from '../src/ops/repository-edge-deploy.js';

const ACCOUNT = '35e42bcea7b0b9f09dce2860d587d418';

it('finds the account and jurisdiction of the R2 bucket behind the managed store', () => {
  expect(r2Target(`https://${ACCOUNT}.eu.r2.cloudflarestorage.com`)).toEqual({ accountId: ACCOUNT, jurisdiction: 'eu' });
  expect(r2Target(`https://${ACCOUNT}.r2.cloudflarestorage.com/`)).toEqual({ accountId: ACCOUNT });
  expect(() => r2Target('https://s3.eu-central-1.amazonaws.com')).toThrow(/not Cloudflare R2/);
});

it('bundles the Worker as one web-standard module', async () => {
  const code = await bundleRepositoryEdge();
  expect(code).toMatch(/export\s*\{[^}]*as default/);
  expect(code).not.toMatch(/\bfrom\s*["']node:|\brequire\(/);
  const worker = (await import(`data:text/javascript,${encodeURIComponent(code)}`)).default;
  expect((await worker.fetch(new Request('https://edge/elsewhere'), {})).status).toBe(404);
});

it('uploads the Worker with its bucket, grant key and origin, and serves it on workers.dev', async () => {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const fake: typeof fetch = async (input, init) => {
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
  const url = await deployRepositoryEdge({ apiToken: 'cf-token', accountId: ACCOUNT, bucket: 'tavya-storage', jurisdiction: 'eu',
    origin: 'https://tavya.io/', tokenKey: 'a2V5', fetch: fake });
  expect(url).toBe(`https://${EDGE_SCRIPT}.tavya.workers.dev`);
  expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([`PUT /scripts/${EDGE_SCRIPT}`, 'GET /subdomain',
    `POST /scripts/${EDGE_SCRIPT}/subdomain`]);
  const upload = calls[0]!.body as { metadata: { main_module: string; bindings: unknown[] }; module: string };
  expect(upload.metadata.main_module).toBe('worker.js');
  expect(upload.metadata.bindings).toEqual([
    { type: 'r2_bucket', name: 'BUCKET', bucket_name: 'tavya-storage', jurisdiction: 'eu' },
    { type: 'secret_text', name: 'TOKEN_KEY', text: 'a2V5' },
    { type: 'plain_text', name: 'ORIGIN', text: 'https://tavya.io' },
  ]);
  expect(upload.module).toContain('resource-repositories/');
  expect(calls[2]!.body).toEqual({ enabled: true, previews_enabled: false });
});

it('says which permission a refused token lacks', async () => {
  const refused: typeof fetch = async () => Response.json({ success: false, errors: [{ code: 10000, message: 'Authentication error' }] }, { status: 403 });
  await expect(deployRepositoryEdge({ apiToken: 'x', accountId: ACCOUNT, bucket: 'b', origin: 'https://tavya.io', tokenKey: 'a2V5',
    fetch: refused })).rejects.toThrow(/Authentication error \(10000\).*Workers Scripts: Edit/);
});
