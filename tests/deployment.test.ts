import { describe, expect, it } from 'vitest';
import { deploymentConfig, hydrateSecretFiles, validateDeployment } from '../src/config/deployment.js';

describe('deployment profiles', () => {
  it('keeps local development zero-config', () => {
    expect(validateDeployment({})).toEqual({ hosted: false, singleNode: false, cellId: 'local' });
  });

  it('fails closed when a hosted cell lacks durable or isolated services', () => {
    expect(() => validateDeployment({ KARMAX_DEPLOYMENT: 'hosted', KARMAX_PUBLIC_URL: 'http://localhost' }))
      .toThrow(/hosted deployment is unsafe[\s\S]*https[\s\S]*Temporal[\s\S]*remote world provider|hosted deployment is unsafe/);
  });

  it('accepts a complete E2B hosted cell', () => {
    const secret = 'x'.repeat(32);
    const env = {
      KARMAX_DEPLOYMENT: 'hosted', KARMAX_CELL_ID: 'eu-1', KARMAX_PUBLIC_URL: 'https://karmax.example',
      KARMAX_PREVIEW_ORIGIN: 'https://preview.karmax.example',
      KARMAX_AUTH_SECRET: secret, KARMAX_VAULT_KEY: secret, KARMAX_WORLD_REF_KEY: secret,
      KARMAX_TEMPORAL_ADDRESS: 'temporal.example:7233', KARMAX_OBJECT_STORE: 's3',
      KARMAX_S3_ENDPOINT: 'https://objects.example', KARMAX_S3_BUCKET: 'karmax',
      KARMAX_S3_ACCESS_KEY_ID: 'key', KARMAX_S3_SECRET_ACCESS_KEY: secret,
      KARMAX_GITHUB_APP_ID: '1', KARMAX_GITHUB_APP_SLUG: 'karmax-test',
      KARMAX_GITHUB_APP_PRIVATE_KEY: 'pem', KARMAX_GITHUB_WEBHOOK_SECRET: secret,
      KARMAX_CLOUD_WORLD_PROVIDER: 'e2b', E2B_API_KEY: 'e2b-key',
    };
    expect(validateDeployment(env)).toEqual({ hosted: true, singleNode: false, cellId: 'eu-1', cloudWorldProvider: 'e2b' });
    expect(deploymentConfig(env).hosted).toBe(true);
  });

  it('accepts the turnkey single-node profile with durable local objects', () => {
    const secret = 'x'.repeat(32);
    const env = {
      KARMAX_DEPLOYMENT: 'hosted', KARMAX_SINGLE_NODE: '1', KARMAX_PUBLIC_URL: 'https://karmax.example',
      KARMAX_PREVIEW_ORIGIN: 'https://preview.karmax.example', KARMAX_AUTH_SECRET: secret,
      KARMAX_VAULT_KEY: secret, KARMAX_WORLD_REF_KEY: secret, KARMAX_TEMPORAL_ADDRESS: 'temporal:7233',
      KARMAX_OBJECT_STORE: 'local', KARMAX_CLOUD_WORLD_PROVIDER: 'daytona',
    };
    expect(validateDeployment(env)).toEqual({ hosted: true, singleNode: true, cellId: 'cell-1',
      cloudWorldProvider: 'daytona' });
  });

  it('does not let a managed multi-node cell silently use node-local objects', () => {
    const secret = 'x'.repeat(32);
    expect(() => validateDeployment({
      KARMAX_DEPLOYMENT: 'hosted', KARMAX_PUBLIC_URL: 'https://karmax.example',
      KARMAX_PREVIEW_ORIGIN: 'https://preview.karmax.example', KARMAX_AUTH_SECRET: secret,
      KARMAX_VAULT_KEY: secret, KARMAX_WORLD_REF_KEY: secret, KARMAX_TEMPORAL_ADDRESS: 'temporal:7233',
      KARMAX_OBJECT_STORE: 'local', KARMAX_CLOUD_WORLD_PROVIDER: 'e2b',
    })).toThrow(/managed hosted deployments must use/);
  });

  it('requires untrusted previews to use a separate origin', () => {
    const secret = 'x'.repeat(32);
    const base = {
      KARMAX_DEPLOYMENT: 'hosted', KARMAX_PUBLIC_URL: 'https://karmax.example',
      KARMAX_AUTH_SECRET: secret, KARMAX_VAULT_KEY: secret, KARMAX_WORLD_REF_KEY: secret,
      KARMAX_TEMPORAL_ADDRESS: 'temporal.example:7233', KARMAX_OBJECT_STORE: 's3',
      KARMAX_S3_ENDPOINT: 'https://objects.example', KARMAX_S3_BUCKET: 'karmax',
      KARMAX_S3_ACCESS_KEY_ID: 'key', KARMAX_S3_SECRET_ACCESS_KEY: secret,
      KARMAX_GITHUB_APP_ID: '1', KARMAX_GITHUB_APP_SLUG: 'karmax-test',
      KARMAX_GITHUB_APP_PRIVATE_KEY: 'pem', KARMAX_GITHUB_WEBHOOK_SECRET: secret,
      KARMAX_CLOUD_WORLD_PROVIDER: 'e2b', E2B_API_KEY: 'e2b-key',
    };
    expect(() => validateDeployment({ ...base, KARMAX_PREVIEW_ORIGIN: 'https://karmax.example' }))
      .toThrow(/different origin/);
  });

  it('loads file-backed secrets without replacing explicit values', () => {
    const env: NodeJS.ProcessEnv = { KARMAX_AUTH_SECRET_FILE: '/auth', KARMAX_VAULT_KEY: 'explicit',
      KARMAX_VAULT_KEY_FILE: '/vault' };
    hydrateSecretFiles(env, (filename) => `${filename}-value\n`);
    expect(env.KARMAX_AUTH_SECRET).toBe('/auth-value');
    expect(env.KARMAX_VAULT_KEY).toBe('explicit');
  });
});
