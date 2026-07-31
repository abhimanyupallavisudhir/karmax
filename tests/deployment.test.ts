import { describe, expect, it } from 'vitest';
import { deploymentConfig, hostLocal, hydrateEnvFile, hydrateSecretFiles, validateDeployment } from '../src/config/deployment.js';

describe('deployment profiles', () => {
  it('keeps local development zero-config', () => {
    expect(validateDeployment({})).toEqual({ hosted: false, singleNode: false, cellId: 'local', hostLocal: true });
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
    expect(validateDeployment(env)).toEqual({ hosted: true, singleNode: false, cellId: 'eu-1', hostLocal: false,
      cloudWorldProvider: 'e2b' });
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
    expect(validateDeployment(env)).toEqual({ hosted: true, singleNode: true, cellId: 'cell-1', hostLocal: false,
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

  it('treats an unconfigured install as the operator sitting at the machine', () => {
    expect(hostLocal({})).toBe(true);
    expect(hostLocal({ KARMAX_HOST: '127.0.0.1' })).toBe(true);
    expect(hostLocal({ KARMAX_HOST: 'localhost', KARMAX_PUBLIC_URL: 'http://localhost:4505' })).toBe(true);
    expect(hostLocal({ KARMAX_HOST: '[::1]' })).toBe(true);
  });

  it('withdraws host-machine features once the gateway is served to other people', () => {
    expect(hostLocal({ KARMAX_HOST: '0.0.0.0' })).toBe(false);
    expect(hostLocal({ KARMAX_HOST: '::' })).toBe(false);
    expect(hostLocal({ KARMAX_HOST: '192.168.1.5' })).toBe(false);
    expect(hostLocal({ KARMAX_PUBLIC_URL: 'https://karmax.example.com' })).toBe(false);
    expect(hostLocal({ KARMAX_PUBLIC_URL: 'https://laptop.tail1234.ts.net' })).toBe(false);
    expect(hostLocal({ KARMAX_DEPLOYMENT: 'hosted' })).toBe(false);
  });

  it('lets an operator override detection a tunnel would defeat', () => {
    expect(hostLocal({ KARMAX_HOST: '0.0.0.0', KARMAX_HOST_LOCAL: '1' })).toBe(true);
    expect(hostLocal({ KARMAX_HOST_LOCAL: '0' })).toBe(false);
    // A hosted cell is never the operator's own machine, whatever the override says.
    expect(hostLocal({ KARMAX_DEPLOYMENT: 'hosted', KARMAX_HOST_LOCAL: '1' })).toBe(false);
    expect(deploymentConfig({ KARMAX_DEPLOYMENT: 'hosted' }).hostLocal).toBe(false);
  });

  it('loads file-backed secrets without replacing explicit values', () => {
    const env: NodeJS.ProcessEnv = { KARMAX_AUTH_SECRET_FILE: '/auth', KARMAX_VAULT_KEY: 'explicit',
      KARMAX_VAULT_KEY_FILE: '/vault' };
    hydrateSecretFiles(env, (filename) => `${filename}-value\n`);
    expect(env.KARMAX_AUTH_SECRET).toBe('/auth-value');
    expect(env.KARMAX_VAULT_KEY).toBe('explicit');
  });

  // A self-host is booted by hand (`npm start`) with no compose file and no
  // secret manager, so without this an operator setting — an OAuth client, a
  // mailer — lives only as long as the shell that exported it.
  it('loads durable operator settings from the env file, real env winning', () => {
    const env: NodeJS.ProcessEnv = { KARMAX_HOME: '/home', KARMAX_GOOGLE_CLIENT_ID: 'from-shell' };
    const read = () => [
      '# krmax operator settings',
      'KARMAX_GOOGLE_CLIENT_ID=from-file',
      'KARMAX_GOOGLE_CLIENT_SECRET=GOCSPX-secret',
      '',
    ].join('\n');
    expect(hydrateEnvFile(env, read)).toBe('/home/karmax.env');
    expect(env.KARMAX_GOOGLE_CLIENT_SECRET).toBe('GOCSPX-secret');
    expect(env.KARMAX_GOOGLE_CLIENT_ID).toBe('from-shell');
  });

  it('treats a missing env file as the zero-config default', () => {
    const env: NodeJS.ProcessEnv = { KARMAX_HOME: '/home' };
    expect(hydrateEnvFile(env, () => { throw Object.assign(new Error('nope'), { code: 'ENOENT' }); })).toBeUndefined();
    expect(Object.keys(env)).toEqual(['KARMAX_HOME']);
  });
});
