import fs from 'node:fs';
import { hydrateEnvFile } from '../config/deployment.js';
import { cloudflareAccount, deployRepositoryEdge } from '../ops/repository-edge-deploy.js';

// npm run deploy-repository-edge — deploy/karmax deploy-repository-edge runs it
// in a one-off app container with the operator's CLOUDFLARE_API_TOKEN, and
// prints the edge's URL last (the app reads it as KARMAX_RESOURCE_EDGE_URL).
hydrateEnvFile(process.env, (filename) => fs.readFileSync(filename, 'utf8'));
try {
  const apiToken = process.env.CLOUDFLARE_API_TOKEN?.trim();
  if (!apiToken) throw new Error('CLOUDFLARE_API_TOKEN is not set');
  const origin = process.env.KARMAX_PUBLIC_URL?.trim();
  if (!origin) throw new Error('KARMAX_PUBLIC_URL is not set');
  console.log(await deployRepositoryEdge({ apiToken, accountId: cloudflareAccount(process.env), origin }));
} catch (error) {
  console.error(`deploy-repository-edge: ${(error as Error).message}`);
  process.exit(1);
}
