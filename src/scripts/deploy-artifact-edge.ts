import fs from 'node:fs';
import { hydrateEnvFile, hydrateSecretFiles } from '../config/deployment.js';
import { cloudflareAccount } from '../ops/repository-edge-deploy.js';
import { deployArtifactEdge, r2Jurisdiction } from '../ops/artifact-edge-deploy.js';
import { artifactEdgeKey } from '../gateway/artifact-urls.js';

// npm run deploy-artifact-edge — deploy/karmax deploy-artifact-edge runs it in
// a one-off app container with the operator's CLOUDFLARE_API_TOKEN, and prints
// the edge's URL last (the app reads it as KARMAX_ARTIFACT_EDGE_URL).
const read = (filename: string) => fs.readFileSync(filename, 'utf8');
hydrateEnvFile(process.env, read);
hydrateSecretFiles(process.env, read, ['KARMAX_AUTH_SECRET']);
try {
  const apiToken = process.env.CLOUDFLARE_API_TOKEN?.trim();
  if (!apiToken) throw new Error('CLOUDFLARE_API_TOKEN is not set');
  const origin = process.env.KARMAX_PUBLIC_URL?.trim();
  if (!origin) throw new Error('KARMAX_PUBLIC_URL is not set');
  if (process.env.KARMAX_OBJECT_STORE?.trim() !== 's3') throw new Error('the managed store is not an R2 bucket (KARMAX_OBJECT_STORE=s3)');
  console.log(await deployArtifactEdge({ apiToken, accountId: cloudflareAccount(process.env), origin,
    bucket: process.env.KARMAX_S3_BUCKET ?? '', jurisdiction: r2Jurisdiction(process.env.KARMAX_S3_ENDPOINT),
    secret: artifactEdgeKey() }));
} catch (error) {
  console.error(`deploy-artifact-edge: ${(error as Error).message}`);
  process.exit(1);
}
