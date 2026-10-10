import os from 'node:os';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { launchConfig } from '../launch/legal.js';

export interface DeploymentConfig {
  hosted: boolean;
  singleNode: boolean;
  cellId: string;
  /** Whether host-machine affordances are meaningful — see {@link hostLocal}. */
  hostLocal: boolean;
  cloudWorldProvider?: string;
}

/** A hostname only the machine running karmax can reach. `0.0.0.0`/`::` are
 *  deliberately excluded: binding every interface publishes the gateway. */
function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  return h === 'localhost' || h === '::1' || /^127(\.\d{1,3}){3}$/.test(h);
}

/**
 * Whether the person using this karmax is sitting at the machine that runs it.
 *
 * Some features only exist because the browser and the host are the same
 * computer: importing from the host's `pass` store (which needs a terminal to
 * unlock gpg-agent), typing a host filesystem path, materializing a checkout to
 * `cd` into. Served from a public URL they are noise at best and someone else's
 * secrets at worst, so the UI hides them and the gateway withdraws them.
 *
 * Detected from how the gateway is served — a managed cell, a non-loopback bind,
 * or a public URL all mean someone else is on the other end. `KARMAX_HOST_LOCAL`
 * (`1`/`0`, also true/false, yes/no, on/off) overrides the detection for setups
 * it cannot see, such as a tunnel in front of a loopback bind.
 */
export function hostLocal(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.KARMAX_DEPLOYMENT === 'hosted') return false; // a managed cell is nobody's own machine
  // Anything but a recognizable yes/no leaves detection in charge: `false` once
  // meant "on", exposing the host's pass store to whoever reached the gateway.
  const override = env.KARMAX_HOST_LOCAL?.trim().toLowerCase() ?? '';
  if (['1', 'true', 'yes', 'on'].includes(override)) return true;
  if (['0', 'false', 'no', 'off'].includes(override)) return false;
  if (!isLoopbackHost(env.KARMAX_HOST?.trim() || '127.0.0.1')) return false;
  const publicUrl = env.KARMAX_PUBLIC_URL?.trim();
  if (!publicUrl) return true;
  try { return isLoopbackHost(new URL(publicUrl).hostname); } catch { return false; }
}

const SECRET_FILE_ENV = [
  'KARMAX_AUTH_SECRET', 'KARMAX_VAULT_KEY', 'KARMAX_WORLD_REF_KEY',
  'KARMAX_DATABASE_URL',
  'KARMAX_TEMPORAL_API_KEY', 'KARMAX_S3_ACCESS_KEY_ID', 'KARMAX_S3_SECRET_ACCESS_KEY',
  'KARMAX_S3_SESSION_TOKEN', 'KARMAX_OIDC_CLIENT_SECRET', 'KARMAX_GOOGLE_CLIENT_SECRET',
  'KARMAX_GITHUB_OAUTH_CLIENT_SECRET',
  'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET',
  'KARMAX_GITHUB_APP_PRIVATE_KEY', 'KARMAX_GITHUB_WEBHOOK_SECRET',
  'KARMAX_GITHUB_CLIENT_SECRET',
  'E2B_API_KEY', 'DAYTONA_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY',
  'ARTIFICIAL_ANALYSIS_API_KEY',
] as const;

/** Resolve Docker/Kubernetes-style NAME_FILE secrets before any subsystem reads
 * process.env. Explicit NAME values win, making local and managed-secret
 * deployments use the same downstream configuration. */
export function hydrateSecretFiles(env: NodeJS.ProcessEnv = process.env,
  read: (filename: string) => string, names: readonly (typeof SECRET_FILE_ENV)[number][] = SECRET_FILE_ENV): void {
  for (const name of names) {
    if (env[name]) continue;
    const filename = env[`${name}_FILE`]?.trim();
    if (filename) env[name] = read(filename).trimEnd();
  }
}

/**
 * Durable operator settings for a self-host: `$KARMAX_HOME/karmax.env`.
 *
 * A managed cell gets its variables from compose and a secret manager. A
 * self-host is booted by hand with a bare `npm start`, so there was nowhere to
 * put an operator setting that has to outlive the shell — a social OAuth client,
 * a mailer, a public URL survived only until the next reboot, and "configured"
 * silently meant "configured until you close the terminal".
 *
 * Same file format as `node --env-file` (`parseEnv` is Node's own parser, so
 * there is no second dialect to learn). The real environment always wins, which
 * keeps `KARMAX_X=… npm start` an override rather than a surprise, and keeps
 * every test's explicit env authoritative. Absent file → zero-config default:
 * this is an affordance, never a requirement.
 *
 * @returns the file that was loaded, or undefined if there was none.
 */
export function hydrateEnvFile(env: NodeJS.ProcessEnv = process.env,
  read: (filename: string) => string = () => { throw new Error('no reader'); }): string | undefined {
  const file = path.join(env.KARMAX_HOME ?? path.join(os.homedir(), '.karmax'), 'karmax.env');
  let contents: string;
  try { contents = read(file); } catch { return undefined; }
  for (const [name, value] of Object.entries(parseEnv(contents))) {
    if (env[name] === undefined) env[name] = value;
  }
  return file;
}

/** Hosted Karmax is a single-writer control-plane cell with execution forced
 * onto a remote provider. Development remains zero-config and local. */
export function deploymentConfig(env: NodeJS.ProcessEnv = process.env): DeploymentConfig {
  const hosted = env.KARMAX_DEPLOYMENT === 'hosted';
  const singleNode = hosted && env.KARMAX_SINGLE_NODE === '1';
  return { hosted, singleNode, cellId: env.KARMAX_CELL_ID?.trim() || (hosted ? 'cell-1' : 'local'),
    hostLocal: hostLocal(env),
    ...(hosted ? { cloudWorldProvider: env.KARMAX_CLOUD_WORLD_PROVIDER?.trim() || 'e2b' } : {}) };
}

export function validateDeployment(env: NodeJS.ProcessEnv = process.env): DeploymentConfig {
  const config = deploymentConfig(env);
  if (!config.hosted) return config;
  const failures: string[] = [];
  let publicUrl: URL | undefined;
  let previewUrl: URL | undefined;
  try { publicUrl = new URL(env.KARMAX_PUBLIC_URL ?? ''); } catch {}
  try { previewUrl = new URL(env.KARMAX_PREVIEW_ORIGIN ?? ''); } catch {}
  if (!publicUrl || publicUrl.protocol !== 'https:') failures.push('KARMAX_PUBLIC_URL must be an https URL');
  if (!previewUrl || previewUrl.protocol !== 'https:') failures.push('KARMAX_PREVIEW_ORIGIN must be an https URL');
  if (publicUrl && previewUrl && publicUrl.origin === previewUrl.origin)
    failures.push('KARMAX_PREVIEW_ORIGIN must use a different origin from KARMAX_PUBLIC_URL');
  if (!env.KARMAX_AUTH_SECRET || env.KARMAX_AUTH_SECRET.length < 32) failures.push('KARMAX_AUTH_SECRET must contain at least 32 characters');
  if (!env.KARMAX_VAULT_KEY || env.KARMAX_VAULT_KEY.length < 32) failures.push('KARMAX_VAULT_KEY must contain at least 32 characters');
  if (!env.KARMAX_WORLD_REF_KEY || env.KARMAX_WORLD_REF_KEY.length < 32) failures.push('KARMAX_WORLD_REF_KEY must contain at least 32 characters');
  if (!env.KARMAX_DATABASE_URL || !/^postgres(?:ql)?:\/\//i.test(env.KARMAX_DATABASE_URL))
    failures.push('KARMAX_DATABASE_URL must point at PostgreSQL');
  if (!env.KARMAX_TEMPORAL_ADDRESS) failures.push('KARMAX_TEMPORAL_ADDRESS must point at a durable Temporal service');
  if (config.singleNode) {
    if (!['local', 's3'].includes(env.KARMAX_OBJECT_STORE ?? ''))
      failures.push('single-node KARMAX_OBJECT_STORE must be local or s3');
  } else if (env.KARMAX_OBJECT_STORE !== 's3') {
    failures.push('managed hosted deployments must use KARMAX_OBJECT_STORE=s3');
  }
  if (env.KARMAX_OBJECT_STORE === 's3') {
    for (const name of ['KARMAX_S3_ENDPOINT', 'KARMAX_S3_BUCKET', 'KARMAX_S3_ACCESS_KEY_ID', 'KARMAX_S3_SECRET_ACCESS_KEY'])
      if (!env[name]) failures.push(`${name} is required when KARMAX_OBJECT_STORE=s3`);
  }
  if (!['e2b', 'daytona'].includes(config.cloudWorldProvider!)) failures.push('KARMAX_CLOUD_WORLD_PROVIDER must be e2b or daytona');
  const launch = launchConfig(env);
  if (launch.paidLaunch && !launch.ready)
    failures.push(`KARMAX_PAID_LAUNCH=1 requires the explicit launch checklist: ${launch.missing.join(', ')}`);
  if (failures.length) throw new Error(`hosted deployment is unsafe:\n- ${failures.join('\n- ')}`);
  return config;
}
