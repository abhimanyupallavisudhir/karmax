import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ARTIFACT_EDGE_MARKER } from '../edge/artifact-worker.js';
import { bundleWorker, serveOnWorkersDev, workersApi } from './repository-edge-deploy.js';

/**
 * Deploys the Review artifact edge (src/edge/artifact-worker.ts) as a
 * Cloudflare Worker with Cloudflare's API alone: bound to the managed R2
 * bucket, holding the key tavya signs its URLs with as a secret, served on the
 * account's workers.dev subdomain (an origin of its own, apart from tavya's).
 * Repeatable; each run replaces the script. `deploy/karmax deploy-artifact-edge`.
 */

export const ARTIFACT_EDGE_SCRIPT = 'tavya-review-artifacts';
const SOURCE = path.join(path.dirname(fileURLToPath(import.meta.url)), '../edge/artifact-worker.ts');

export interface ArtifactEdgeDeployment {
  apiToken: string;
  accountId: string;
  /** tavya's public URL (the console reads text artifacts from the edge). */
  origin: string;
  /** The managed R2 bucket, and its jurisdiction (`eu`) if it has one. */
  bucket: string;
  jurisdiction?: string;
  /** The signing key (artifactEdgeKey). */
  secret: string;
  script?: string;
  fetch?: typeof fetch;
  readyTimeoutMs?: number;
  readyIntervalMs?: number;
}

/** The jurisdiction an R2 endpoint names (`https://<account>.eu.r2.cloudflarestorage.com` → `eu`). */
export function r2Jurisdiction(endpoint: string | undefined): string | undefined {
  return /^https:\/\/[0-9a-f]{32}\.([a-z]+)\.r2\.cloudflarestorage\.com\/?$/.exec(endpoint?.trim() ?? '')?.[1];
}

export function bundleArtifactEdge(): Promise<string> {
  return bundleWorker(SOURCE);
}

/** Upload the Worker and serve it on workers.dev; returns its URL. */
export async function deployArtifactEdge(options: ArtifactEdgeDeployment): Promise<string> {
  if (options.secret.length < 32) throw new Error('the artifact edge key is missing: the installation has no auth secret');
  if (!options.bucket.trim()) throw new Error('the managed store has no bucket (KARMAX_S3_BUCKET)');
  const fetcher = options.fetch ?? fetch;
  const script = options.script ?? ARTIFACT_EDGE_SCRIPT;
  await workersApi(options.apiToken, options.accountId, fetcher).upload(script, await bundleArtifactEdge(), [
    { type: 'r2_bucket', name: 'BUCKET', bucket_name: options.bucket.trim(), ...(options.jurisdiction ? { jurisdiction: options.jurisdiction } : {}) },
    { type: 'plain_text', name: 'ORIGIN', text: options.origin.replace(/\/+$/, '') },
    { type: 'secret_text', name: 'URL_KEY', text: options.secret },
  ]);
  return serveOnWorkersDev(options.apiToken, options.accountId, script, ARTIFACT_EDGE_MARKER, options, fetcher);
}
