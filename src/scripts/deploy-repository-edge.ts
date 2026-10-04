import fs from 'node:fs';
import { hydrateEnvFile, hydrateSecretFiles } from '../config/deployment.js';
import { paths } from '../config/paths.js';
import { Vault } from '../autonomy/vault.js';
import { CredentialBroker } from '../autonomy/broker.js';
import { TOKEN_KEY_HANDLE } from '../world/resource-repository.js';
import { deployRepositoryEdge, r2Target } from '../ops/repository-edge-deploy.js';

// npm run deploy-repository-edge — deploy/karmax deploy-repository-edge runs it
// in a one-off app container with the operator's CLOUDFLARE_API_TOKEN, and
// prints the edge's URL last (the app reads it as KARMAX_RESOURCE_EDGE_URL).
hydrateEnvFile(process.env, (filename) => fs.readFileSync(filename, 'utf8'));
try {
  hydrateSecretFiles(process.env, (filename) => fs.readFileSync(filename, 'utf8'), ['KARMAX_VAULT_KEY']);
  const apiToken = process.env.CLOUDFLARE_API_TOKEN?.trim();
  if (!apiToken) throw new Error('CLOUDFLARE_API_TOKEN is not set');
  if (process.env.KARMAX_OBJECT_STORE !== 's3') throw new Error('the managed object store is not S3 (R2); the edge needs it');
  const bucket = process.env.KARMAX_S3_BUCKET?.trim();
  const origin = process.env.KARMAX_PUBLIC_URL?.trim();
  if (!bucket || !origin) throw new Error('KARMAX_S3_BUCKET and KARMAX_PUBLIC_URL must be set');
  // Read only: the grant key is the app's, created with its first resource save.
  const broker = new CredentialBroker(new Vault(paths().vault, { readOnly: true }));
  if (!broker.hasHandle(TOKEN_KEY_HANDLE)) throw new Error('no repository grant key yet: save a resource once first');
  const tokenKey = broker.resolve(TOKEN_KEY_HANDLE, { caps: [`use-credential:${TOKEN_KEY_HANDLE}`] });
  const url = await deployRepositoryEdge({ apiToken, ...r2Target(process.env.KARMAX_S3_ENDPOINT ?? ''), bucket, origin, tokenKey });
  console.log(url);
} catch (error) {
  console.error(`deploy-repository-edge: ${(error as Error).message}`);
  process.exit(1);
}
