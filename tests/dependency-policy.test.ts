import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const lock = JSON.parse(fs.readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8')) as {
  packages: Record<string, { version?: string; dependencies?: Record<string, string>; devDependencies?: Record<string, string> }>;
};
const minimums: Record<string, string> = {
  '@daytona/sdk': '0.218.0',
  '@temporalio/client': '1.24.0',
  'better-auth': '1.7.6',
  'e2b': '2.51.0',
  'nodemailer': '10.0.12',
  'vitest': '4.1.11',
};

describe('dependency security floor', () => {
  it.each(Object.entries(minimums))('%s resolves at or above %s', (name, minimum) => {
    const actual = lock.packages[`node_modules/${name}`]?.version;
    expect(actual).toBeDefined();
    const parts = (version: string) => version.split('.').map(Number);
    const [a, b, c] = parts(actual!);
    const [x, y, z] = parts(minimum);
    expect(a! * 1_000_000 + b! * 1_000 + c!).toBeGreaterThanOrEqual(x! * 1_000_000 + y! * 1_000 + z!);
  });
});

it('declares every directly imported package, including tooling and replay fixtures', () => {
  const root = lock.packages['']!;
  expect(root.dependencies?.dotenv ?? root.devDependencies?.dotenv).toBeDefined();
  expect(root.dependencies?.['@temporalio/proto'] ?? root.devDependencies?.['@temporalio/proto']).toBeDefined();
});

it('keeps the lockfile usable by clean CI installs', () => {
  const result = spawnSync('npm', ['ci', '--dry-run', '--ignore-scripts', '--offline', '--no-audit', '--no-fund'], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
    timeout: 30_000,
  });
  expect(result.status, result.stderr).toBe(0);
});
