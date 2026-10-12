import fs from 'node:fs';
import { hydrateEnvFile, hydrateSecretFiles } from '../config/deployment.js';
import { cloudflareAccount } from '../ops/repository-edge-deploy.js';
import { deployMailEdge } from '../ops/agent-mail-edge-deploy.js';
import { agentMailIngestKey } from '../autonomy/agent-mail.js';

// npm run deploy-agent-mail-edge — deploy/karmax deploy-agent-mail-edge runs it
// in a one-off app container with the operator's CLOUDFLARE_API_TOKEN and the
// mail domain, and prints the Worker's script name last.
const read = (filename: string) => fs.readFileSync(filename, 'utf8');
hydrateEnvFile(process.env, read);
hydrateSecretFiles(process.env, read, ['KARMAX_AUTH_SECRET']);
try {
  const apiToken = process.env.CLOUDFLARE_API_TOKEN?.trim();
  if (!apiToken) throw new Error('CLOUDFLARE_API_TOKEN is not set');
  const origin = process.env.KARMAX_PUBLIC_URL?.trim();
  if (!origin) throw new Error('KARMAX_PUBLIC_URL is not set');
  const domain = process.env.KARMAX_AGENT_MAIL_DOMAIN?.trim();
  if (!domain) throw new Error('KARMAX_AGENT_MAIL_DOMAIN is not set');
  console.log(await deployMailEdge({ apiToken, accountId: cloudflareAccount(process.env), origin, domain,
    secret: agentMailIngestKey() }));
} catch (error) {
  console.error(`deploy-agent-mail-edge: ${(error as Error).message}`);
  process.exit(1);
}
