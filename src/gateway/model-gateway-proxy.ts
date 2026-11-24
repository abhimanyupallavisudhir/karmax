/**
 * tavya's proxy in front of the operator's model gateways (wiki
 * features/model-gateways). The agent's harness — Claude Code at
 * `ANTHROPIC_BASE_URL`, Codex at its provider's `base_url` — sends its model
 * requests here with a token good for one turn (`tmg_…`), never the
 * gateway's key: a key in a computer is a key the agent can read, and an
 * operator's key would spend the operator's money for anyone who took it.
 *
 * Each request is forwarded to `<gateway>/v1/…` with the gateway's key, its
 * response streamed back unchanged, and the tokens the gateway reported
 * booked to the turn's organization (and task) at the gateway's price. A
 * request is refused once the organization's credit is spent, so a long turn
 * stops where the credit does, not where it ends.
 */
import type http from 'node:http';
import type { CredentialBroker } from '../autonomy/broker.js';
import type { Store } from '../store/db.js';
import { bookGatewayRequest, gatewayGrant, gatewayKey, modelGateways, UsageMeter } from '../agent/model-gateways.js';
import { modelListPrice } from '../agent/model-prices.js';
import { computeCredit, outOfCompute } from '../world/managed-compute.js';

/** Model requests carry whole conversations, images included. */
const MAX_REQUEST_BYTES = 64 * 1024 * 1024;

/** Request headers that describe this hop or carry the turn's token, not the request. */
const DROP_REQUEST = new Set(['host', 'connection', 'keep-alive', 'content-length', 'transfer-encoding', 'te', 'upgrade',
  'authorization', 'x-api-key', 'cookie', 'accept-encoding', 'proxy-authorization', 'proxy-connection', 'forwarded', 'x-real-ip']);
/** Response headers fetch already acted on (it decompresses), or that are this hop's. */
const DROP_RESPONSE = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'keep-alive', 'set-cookie']);

function refuse(res: http.ServerResponse, status: number, type: string, message: string): void {
  if (res.headersSent) { res.end(); return; }
  // Anthropic's error shape; OpenAI clients read `error.message` from it too.
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ type: 'error', error: { type, message } }));
}

async function readBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_REQUEST_BYTES) throw Object.assign(new Error('request too large'), { status: 413 });
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

/** Serve one request to `/api/model-gateway<rest>`. */
export async function proxyModelGateway(deps: { store: Store; broker?: CredentialBroker }, req: http.IncomingMessage,
  res: http.ServerResponse, rest: string): Promise<void> {
  const { store, broker } = deps;
  const bearer = String(req.headers.authorization ?? '').match(/^Bearer\s+(\S+)$/i)?.[1];
  const token = bearer ?? (typeof req.headers['x-api-key'] === 'string' ? req.headers['x-api-key'] : undefined);
  const grant = token ? await gatewayGrant(store, token) : undefined;
  if (!grant || !broker) return refuse(res, 401, 'authentication_error', 'This model gateway token is not valid (it lasts one agent turn).');
  const gateway = (await modelGateways(store)).find((candidate) => candidate.id === grant.gatewayId);
  if (!gateway?.enabled) return refuse(res, 403, 'permission_error', 'This model gateway has been switched off.');
  if (!/^\/v1(\/|$|\?)/.test(rest)) return refuse(res, 404, 'not_found_error', 'Model gateways serve /v1/… only.');
  if (store.hosted) {
    const credit = await computeCredit(store, grant.organizationId);
    if (credit.availableMicros != null && credit.availableMicros <= 0)
      return refuse(res, 402, 'billing_error', (await outOfCompute(store, grant.organizationId, 'openrouter')).message);
  }
  let body: Buffer;
  try { body = await readBody(req); }
  catch (error) { return refuse(res, (error as any)?.status ?? 400, 'invalid_request_error', error instanceof Error ? error.message : String(error)); }
  let model: string | undefined;
  if (body.length) {
    try { const parsed = JSON.parse(body.toString('utf8')); if (typeof parsed?.model === 'string') model = parsed.model; }
    catch { /* not JSON: forwarded as it is, and nothing to meter */ }
  }
  // A request that names a model is a model call: one tavya cannot price, it does not make.
  const price = model ? await modelListPrice(model) : undefined;
  if (model && !price) return refuse(res, 400, 'invalid_request_error',
    `There is no API list price for ${model}, so its use cannot be charged; ask for a model the gateway's list includes.`);

  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    const lower = name.toLowerCase();
    if (value === undefined || DROP_REQUEST.has(lower) || lower.startsWith('x-forwarded-') || lower.startsWith('cf-')) continue;
    headers[lower] = Array.isArray(value) ? value.join(', ') : value;
  }
  const key = await gatewayKey(broker, gateway.id);
  headers.authorization = `Bearer ${key}`;
  // Anthropic's own API reads `x-api-key`; gateways in front of it often a bearer token.
  if (grant.harness === 'claude') headers['x-api-key'] = key;

  const abort = new AbortController();
  const onClose = () => { if (!res.writableFinished) abort.abort(); };
  res.on('close', onClose);
  const meter = new UsageMeter(grant.harness);
  let upstream: Response;
  try {
    upstream = await fetch(`${gateway.baseUrl}${rest}`, { method: req.method ?? 'POST', headers,
      ...(body.length && req.method !== 'GET' && req.method !== 'HEAD' ? { body } : {}), redirect: 'manual', signal: abort.signal });
  } catch (error) {
    res.off('close', onClose);
    if (abort.signal.aborted) { res.end(); return; }
    return refuse(res, 502, 'api_error', `The model gateway ${gateway.name} could not be reached: ${error instanceof Error ? error.message : String(error)}`);
  }
  const out: Record<string, string> = {};
  upstream.headers.forEach((value, name) => { if (!DROP_RESPONSE.has(name.toLowerCase())) out[name] = value; });
  res.writeHead(upstream.status, out);
  res.flushHeaders?.();
  try {
    if (upstream.body) for await (const chunk of upstream.body as unknown as AsyncIterable<Uint8Array>) {
      meter.push(chunk);
      if (!res.write(chunk)) await new Promise<void>((resolve) => { res.once('drain', resolve); res.once('close', resolve); });
      if (res.destroyed) break;
    }
  } catch { /* the client or the gateway went away: what was reported still counts */ }
  finally {
    res.off('close', onClose);
    res.end();
    const usage = meter.result();
    if (usage && price && model) await bookGatewayRequest(store, grant, gateway, usage, price, model).catch((error) =>
      console.warn(`[karmax] could not book a ${gateway.name} model request for ${grant.organizationId}:`, error instanceof Error ? error.message : error));
  }
}
