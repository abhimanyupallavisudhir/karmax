import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundleWorker, workersApi } from './repository-edge-deploy.js';

/**
 * Deploys agent mail's inbound edge (src/edge/agent-mail-worker.ts) as a
 * Cloudflare Email Worker, with Cloudflare's API alone. It is reached only by
 * Email Routing's catch-all rule for the mail domain, never over HTTP, so it
 * gets no workers.dev route. The signing key goes up as a Worker secret.
 * Repeatable; each run replaces the script. `deploy/karmax deploy-agent-mail-edge`.
 */

export const MAIL_EDGE_SCRIPT = 'tavya-agent-mail';
const SOURCE = path.join(path.dirname(fileURLToPath(import.meta.url)), '../edge/agent-mail-worker.ts');

export interface MailEdgeDeployment {
  apiToken: string;
  accountId: string;
  /** tavya's public URL. */
  origin: string;
  /** The mail domain, e.g. mail.tavyausercontent.com. */
  domain: string;
  /** The signing key the app checks deliveries with (agentMailIngestKey). */
  secret: string;
  script?: string;
  fetch?: typeof fetch;
}

export function bundleMailEdge(): Promise<string> {
  return bundleWorker(SOURCE);
}

/** Upload the Worker, turn off its workers.dev route; returns the script name
 * the catch-all rule must name. */
export async function deployMailEdge(options: MailEdgeDeployment): Promise<string> {
  const domain = options.domain.trim().toLowerCase();
  if (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(domain)) throw new Error(`not a mail domain: ${options.domain}`);
  if (options.secret.length < 32) throw new Error('the agent-mail signing key is missing: the installation has no auth secret');
  const script = options.script ?? MAIL_EDGE_SCRIPT;
  const { account, call, upload } = workersApi(options.apiToken, options.accountId, options.fetch ?? fetch);
  await upload(script, await bundleMailEdge(), [
    { type: 'plain_text', name: 'INGEST_URL', text: `${options.origin.replace(/\/+$/, '')}/api/agent-mail/ingest` },
    { type: 'plain_text', name: 'MAIL_DOMAIN', text: domain },
    { type: 'secret_text', name: 'INGEST_SECRET', text: options.secret },
  ]);
  await call('POST', `${account}/scripts/${script}/subdomain`, { enabled: false, previews_enabled: false });
  return script;
}
