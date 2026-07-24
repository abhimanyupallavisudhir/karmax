export interface DeploymentConfig {
  hosted: boolean;
  singleNode: boolean;
  cellId: string;
  cloudWorldProvider?: string;
}

const SECRET_FILE_ENV = [
  'KARMAX_AUTH_SECRET', 'KARMAX_VAULT_KEY', 'KARMAX_WORLD_REF_KEY',
  'KARMAX_TEMPORAL_API_KEY', 'KARMAX_S3_ACCESS_KEY_ID', 'KARMAX_S3_SECRET_ACCESS_KEY',
  'KARMAX_S3_SESSION_TOKEN', 'KARMAX_OIDC_CLIENT_SECRET', 'STRIPE_SECRET_KEY',
  'KARMAX_GITHUB_APP_PRIVATE_KEY', 'KARMAX_GITHUB_WEBHOOK_SECRET',
  'KARMAX_GITHUB_CLIENT_SECRET',
  'E2B_API_KEY', 'DAYTONA_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY',
] as const;

/** Resolve Docker/Kubernetes-style NAME_FILE secrets before any subsystem reads
 * process.env. Explicit NAME values win, making local and managed-secret
 * deployments use the same downstream configuration. */
export function hydrateSecretFiles(env: NodeJS.ProcessEnv = process.env,
  read: (filename: string) => string): void {
  for (const name of SECRET_FILE_ENV) {
    if (env[name]) continue;
    const filename = env[`${name}_FILE`]?.trim();
    if (filename) env[name] = read(filename).trimEnd();
  }
}

/** Hosted Karmax is a single-writer control-plane cell with execution forced
 * onto a remote provider. Development remains zero-config and local. */
export function deploymentConfig(env: NodeJS.ProcessEnv = process.env): DeploymentConfig {
  const hosted = env.KARMAX_DEPLOYMENT === 'hosted';
  const singleNode = hosted && env.KARMAX_SINGLE_NODE === '1';
  return { hosted, singleNode, cellId: env.KARMAX_CELL_ID?.trim() || (hosted ? 'cell-1' : 'local'),
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
  if (failures.length) throw new Error(`hosted deployment is unsafe:\n- ${failures.join('\n- ')}`);
  return config;
}
