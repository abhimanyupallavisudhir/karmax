import { describe, expect, it, vi } from 'vitest';
import { OPENCODE_VERSION } from '../src/agent/acp-packages.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deploymentConfig, hostLocal, hydrateEnvFile, hydrateSecretFiles, validateDeployment } from '../src/config/deployment.js';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** A complete managed (multi-node, S3) hosted cell. */
function managedCell(): NodeJS.ProcessEnv {
  const secret = 'x'.repeat(32);
  return {
    KARMAX_DEPLOYMENT: 'hosted', KARMAX_PUBLIC_URL: 'https://karmax.example', KARMAX_PREVIEW_ORIGIN: 'https://preview.karmax.example',
    KARMAX_AUTH_SECRET: secret, KARMAX_VAULT_KEY: secret, KARMAX_WORLD_REF_KEY: secret,
    KARMAX_DATABASE_URL: 'postgres://karmax.example/karmax', KARMAX_TEMPORAL_ADDRESS: 'temporal.example:7233',
    KARMAX_OBJECT_STORE: 's3', KARMAX_S3_ENDPOINT: 'https://objects.example', KARMAX_S3_BUCKET: 'karmax',
    KARMAX_S3_ACCESS_KEY_ID: 'key', KARMAX_S3_SECRET_ACCESS_KEY: secret, KARMAX_CLOUD_WORLD_PROVIDER: 'e2b',
  };
}

describe('deployment profiles', () => {
  it('ships both subscription-login CLIs in production dependencies', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    const dockerfile = fs.readFileSync(path.join(repoRoot, 'deploy', 'Dockerfile'), 'utf8');
    expect(pkg.dependencies['@anthropic-ai/claude-agent-sdk']).toBe('0.3.281');
    const browserImage = fs.readFileSync(path.join(repoRoot, 'environments/browser/Dockerfile'), 'utf8');
    expect(browserImage).toContain('ARG CODEX_VERSION=0.156.1');
    expect(browserImage).toContain('ARG CLAUDE_CODE_VERSION=2.1.281');
    // Remote OpenCode runs the pinned package; the template bakes that version.
    expect(browserImage).toContain(`ARG OPENCODE_VERSION=${OPENCODE_VERSION}`);
    expect(pkg.dependencies['@openai/codex']).toBe('0.156.1');
    expect(pkg.dependencies.pg).toBeTruthy();
    expect(dockerfile).toContain('npm ci --omit=dev');
  });

  it('keeps local development zero-config', () => {
    expect(validateDeployment({})).toEqual({ hosted: false, singleNode: false, cellId: 'local', hostLocal: true });
  });

  it('fails closed when a hosted cell lacks durable or isolated services', () => {
    expect(() => validateDeployment({ KARMAX_DEPLOYMENT: 'hosted', KARMAX_PUBLIC_URL: 'http://localhost' })).toThrow([
      'hosted deployment is unsafe:',
      '- KARMAX_PUBLIC_URL must be an https URL',
      '- KARMAX_PREVIEW_ORIGIN must be an https URL',
      '- KARMAX_AUTH_SECRET must contain at least 32 characters',
      '- KARMAX_VAULT_KEY must contain at least 32 characters',
      '- KARMAX_WORLD_REF_KEY must contain at least 32 characters',
      '- KARMAX_DATABASE_URL must point at PostgreSQL',
      '- KARMAX_TEMPORAL_ADDRESS must point at a durable Temporal service',
      '- managed hosted deployments must use KARMAX_OBJECT_STORE=s3',
    ].join('\n'));
  });

  // One broken setting on an otherwise complete managed cell names exactly that setting.
  it.each([
    [{ KARMAX_PUBLIC_URL: 'not a url' }, 'KARMAX_PUBLIC_URL must be an https URL'],
    [{ KARMAX_PREVIEW_ORIGIN: 'http://preview.karmax.example' }, 'KARMAX_PREVIEW_ORIGIN must be an https URL'],
    [{ KARMAX_AUTH_SECRET: 'x'.repeat(31) }, 'KARMAX_AUTH_SECRET must contain at least 32 characters'],
    [{ KARMAX_VAULT_KEY: undefined }, 'KARMAX_VAULT_KEY must contain at least 32 characters'],
    [{ KARMAX_WORLD_REF_KEY: '' }, 'KARMAX_WORLD_REF_KEY must contain at least 32 characters'],
    [{ KARMAX_DATABASE_URL: 'mysql://db/karmax' }, 'KARMAX_DATABASE_URL must point at PostgreSQL'],
    [{ KARMAX_TEMPORAL_ADDRESS: '' }, 'KARMAX_TEMPORAL_ADDRESS must point at a durable Temporal service'],
    [{ KARMAX_S3_BUCKET: undefined }, 'KARMAX_S3_BUCKET is required when KARMAX_OBJECT_STORE=s3'],
    [{ KARMAX_S3_SECRET_ACCESS_KEY: '' }, 'KARMAX_S3_SECRET_ACCESS_KEY is required when KARMAX_OBJECT_STORE=s3'],
    [{ KARMAX_CLOUD_WORLD_PROVIDER: 'worktree' }, 'KARMAX_CLOUD_WORLD_PROVIDER must be e2b or daytona'],
    [{ KARMAX_SINGLE_NODE: '1', KARMAX_OBJECT_STORE: 'memory' }, 'single-node KARMAX_OBJECT_STORE must be local or s3'],
  ])('refuses a managed cell with %j', (change, failure) => {
    expect(() => validateDeployment({ ...managedCell(), ...change })).toThrow(`hosted deployment is unsafe:\n- ${failure}`);
    try { validateDeployment({ ...managedCell(), ...change }); } catch (error) {
      expect((error as Error).message.split('\n')).toHaveLength(2);
    }
  });

  it('accepts postgresql:// URLs, a single-node cell on S3, and defaults the world provider to E2B', () => {
    expect(validateDeployment({ ...managedCell(), KARMAX_DATABASE_URL: 'PostgreSQL://db/karmax', KARMAX_CLOUD_WORLD_PROVIDER: ' ' }))
      .toMatchObject({ hosted: true, cloudWorldProvider: 'e2b' });
    expect(validateDeployment({ ...managedCell(), KARMAX_SINGLE_NODE: '1' })).toMatchObject({ singleNode: true });
    // KARMAX_SINGLE_NODE means nothing to a local install.
    expect(deploymentConfig({ KARMAX_SINGLE_NODE: '1', KARMAX_CELL_ID: '  lab  ' })).toEqual({ hosted: false, singleNode: false,
      cellId: 'lab', hostLocal: true });
  });

  it('will not take payments before the launch checklist is complete', () => {
    expect(() => validateDeployment({ ...managedCell(), KARMAX_PAID_LAUNCH: '1', KARMAX_LEGAL_ENTITY_NAME: 'Tavya Ltd' }))
      .toThrow(/KARMAX_PAID_LAUNCH=1 requires the explicit launch checklist: KARMAX_FOUNDER_REVIEWED_POLICY_VERSION, KARMAX_LEGAL_ENTITY_COUNTRY,/);
    expect(validateDeployment({ ...managedCell(), KARMAX_PAID_LAUNCH: '0' }).hosted).toBe(true);
  });

  it('accepts a complete E2B hosted cell', () => {
    const secret = 'x'.repeat(32);
    const env = {
      KARMAX_DEPLOYMENT: 'hosted', KARMAX_CELL_ID: 'eu-1', KARMAX_PUBLIC_URL: 'https://karmax.example',
      KARMAX_PREVIEW_ORIGIN: 'https://preview.karmax.example',
      KARMAX_AUTH_SECRET: secret, KARMAX_VAULT_KEY: secret, KARMAX_WORLD_REF_KEY: secret,
      KARMAX_DATABASE_URL: 'postgres://karmax.example/karmax',
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
      KARMAX_VAULT_KEY: secret, KARMAX_WORLD_REF_KEY: secret,
      KARMAX_DATABASE_URL: 'postgres://postgresql/karmax', KARMAX_TEMPORAL_ADDRESS: 'temporal:7233',
      KARMAX_OBJECT_STORE: 'local', KARMAX_CLOUD_WORLD_PROVIDER: 'daytona',
    };
    expect(validateDeployment(env)).toEqual({ hosted: true, singleNode: true, cellId: 'cell-1', hostLocal: false,
      cloudWorldProvider: 'daytona' });
  });

  it('never lets a hosted cell fall back to node-local SQLite', () => {
    const secret = 'x'.repeat(32);
    expect(() => validateDeployment({
      KARMAX_DEPLOYMENT: 'hosted', KARMAX_SINGLE_NODE: '1', KARMAX_PUBLIC_URL: 'https://karmax.example',
      KARMAX_PREVIEW_ORIGIN: 'https://preview.karmax.example', KARMAX_AUTH_SECRET: secret,
      KARMAX_VAULT_KEY: secret, KARMAX_WORLD_REF_KEY: secret, KARMAX_TEMPORAL_ADDRESS: 'temporal:7233',
      KARMAX_OBJECT_STORE: 'local', KARMAX_CLOUD_WORLD_PROVIDER: 'e2b',
    })).toThrow(/KARMAX_DATABASE_URL must point at PostgreSQL/);
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
      KARMAX_DATABASE_URL: 'postgres://karmax.example/karmax',
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

  it('recognizes any 127/8 address and refuses a public URL it cannot parse', () => {
    expect(hostLocal({ KARMAX_HOST: '127.8.9.10', KARMAX_PUBLIC_URL: 'http://127.0.0.1:4505' })).toBe(true);
    expect(hostLocal({ KARMAX_PUBLIC_URL: 'http://[::1]:4505' })).toBe(true);
    expect(hostLocal({ KARMAX_PUBLIC_URL: 'karmax.example.com' })).toBe(false);
    expect(hostLocal({ KARMAX_HOST: '127.0.0.1.nip.io' })).toBe(false);
  });

  it('lets an operator override detection a tunnel would defeat', () => {
    expect(hostLocal({ KARMAX_HOST: '0.0.0.0', KARMAX_HOST_LOCAL: '1' })).toBe(true);
    expect(hostLocal({ KARMAX_HOST: '0.0.0.0', KARMAX_HOST_LOCAL: 'true' })).toBe(true);
    expect(hostLocal({ KARMAX_HOST_LOCAL: '0' })).toBe(false);
    // Spelling "off" any other way must not switch host features on.
    for (const off of ['false', 'no', 'off', 'FALSE']) expect(hostLocal({ KARMAX_HOST_LOCAL: off })).toBe(false);
    // An override it cannot read leaves detection in charge.
    expect(hostLocal({ KARMAX_HOST: '0.0.0.0', KARMAX_HOST_LOCAL: 'maybe' })).toBe(false);
    expect(hostLocal({ KARMAX_HOST_LOCAL: '  ' })).toBe(true);
    // A hosted cell is never the operator's own machine, whatever the override says.
    expect(hostLocal({ KARMAX_DEPLOYMENT: 'hosted', KARMAX_HOST_LOCAL: '1' })).toBe(false);
    expect(deploymentConfig({ KARMAX_DEPLOYMENT: 'hosted' }).hostLocal).toBe(false);
  });

  it('loads file-backed secrets without replacing explicit values', () => {
    const env: NodeJS.ProcessEnv = { KARMAX_AUTH_SECRET_FILE: '/auth', KARMAX_DATABASE_URL_FILE: '/database', KARMAX_VAULT_KEY: 'explicit',
      KARMAX_VAULT_KEY_FILE: '/vault', KARMAX_GITHUB_OAUTH_CLIENT_SECRET_FILE: '/github-oauth' };
    hydrateSecretFiles(env, (filename) => `${filename}-value\n`);
    expect(env.KARMAX_AUTH_SECRET).toBe('/auth-value');
    expect(env.KARMAX_DATABASE_URL).toBe('/database-value');
    expect(env.KARMAX_VAULT_KEY).toBe('explicit');
    expect(env.KARMAX_GITHUB_OAUTH_CLIENT_SECRET).toBe('/github-oauth-value');
  });

  it('reads provider and payment secrets from files too, but no arbitrary variable', () => {
    const env: NodeJS.ProcessEnv = { E2B_API_KEY_FILE: '/e2b', STRIPE_WEBHOOK_SECRET_FILE: ' /stripe ', ANTHROPIC_API_KEY_FILE: '  ',
      KARMAX_PUBLIC_URL_FILE: '/url', OPENAI_API_KEY: '' , OPENAI_API_KEY_FILE: '/openai' };
    const read = vi.fn((filename: string) => `${filename}-value\r\n`);
    hydrateSecretFiles(env, read);
    expect(env).toMatchObject({ E2B_API_KEY: '/e2b-value', STRIPE_WEBHOOK_SECRET: '/stripe-value', OPENAI_API_KEY: '/openai-value' });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.KARMAX_PUBLIC_URL).toBeUndefined();
    expect(read.mock.calls.map(([filename]) => filename).sort()).toEqual(['/e2b', '/openai', '/stripe']);
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

  it('reads the env file from ~/.karmax by default and understands quoting', () => {
    const env: NodeJS.ProcessEnv = {};
    const read = vi.fn(() => 'KARMAX_MAIL_FROM="Tavya <hello@tavya.example>" # sender\nKARMAX_NOTE=\'a # b\'\n');
    expect(hydrateEnvFile(env, read)).toBe(path.join(os.homedir(), '.karmax', 'karmax.env'));
    expect(read).toHaveBeenCalledWith(path.join(os.homedir(), '.karmax', 'karmax.env'));
    expect(env).toEqual({ KARMAX_MAIL_FROM: 'Tavya <hello@tavya.example>', KARMAX_NOTE: 'a # b' });
    // Without a reader there is nothing to load.
    expect(hydrateEnvFile({ KARMAX_HOME: '/home' })).toBeUndefined();
  });

  it('treats a missing env file as the zero-config default', () => {
    const env: NodeJS.ProcessEnv = { KARMAX_HOME: '/home' };
    expect(hydrateEnvFile(env, () => { throw Object.assign(new Error('nope'), { code: 'ENOENT' }); })).toBeUndefined();
    expect(Object.keys(env)).toEqual(['KARMAX_HOME']);
  });
});

it('passes production worker isolation and the optional template override through both Compose profiles', () => {
  for (const profile of ['turnkey', 'hosted']) {
    const yaml = fs.readFileSync(path.join(repoRoot, `deploy/compose.${profile}.yml`), 'utf8');
    expect(yaml).toContain('KARMAX_WORKER_MODE: ${KARMAX_WORKER_MODE:-process}');
    expect(yaml).toContain('KARMAX_E2B_TEMPLATE: ${KARMAX_E2B_TEMPLATE:-}');
  }
});
