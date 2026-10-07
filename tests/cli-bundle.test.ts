import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';

it('bundles the CLI into one file that needs nothing but Node', () => {
  execFileSync(process.execPath, ['scripts/build-cli.mjs'], { stdio: 'pipe' });
  const bundle = path.resolve('cli/dist/tavya.mjs');
  const source = fs.readFileSync(bundle, 'utf8');
  expect(source.startsWith('#!/usr/bin/env node')).toBe(true);
  const imports = [...source.matchAll(/^import\s[^;]*?from\s*"([^"]+)"|\bimport\(\s*"([^"]+)"\s*\)|\brequire\(\s*"([^"]+)"\s*\)/gm)]
    .map((match) => match[1] ?? match[2] ?? match[3]!);
  expect(imports.length).toBeGreaterThan(0);
  expect(imports.filter((specifier) => !specifier.startsWith('node:'))).toEqual([]);
  const version = JSON.parse(fs.readFileSync('cli/package.json', 'utf8')).version;
  expect(execFileSync(process.execPath, [bundle, '--version'], { encoding: 'utf8' }).trim()).toBe(version);
  expect(execFileSync(process.execPath, [bundle, '--help'], { encoding: 'utf8' })).toContain('clone <org>/<project>');
});
