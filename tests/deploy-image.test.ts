import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file: string) => fs.readFileSync(path.join(repoRoot, file), 'utf8');
const tracked = (...args: string[]) => execFileSync('git', ['ls-files', ...args], { cwd: repoRoot, encoding: 'utf8' })
  .trim().split('\n').filter(Boolean);

/** Docker's .dockerignore semantics: `**` spans directories, `*` and `?` stay
 *  inside one path segment, `!` re-includes, and the last matching line wins. */
function dockerIgnored(patterns: string[], file: string): boolean {
  let ignored = false;
  for (const raw of patterns) {
    const negated = raw.startsWith('!');
    const pattern = path.posix.normalize((negated ? raw.slice(1) : raw).replace(/^\/+/, ''));
    const source = pattern.split('/').map((segment) => segment === '**' ? '(?:.*)'
      : segment.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')).join('/')
      .replace(/\(\?:\.\*\)\//g, '(?:.*/)?');
    // A pattern naming a directory excludes everything beneath it.
    if (new RegExp(`^${source}(?:/.*)?$`).test(file)) ignored = !negated;
  }
  return ignored;
}

describe('control-plane image contents', () => {
  const patterns = read('.dockerignore').split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));

  it('leaves the standalone web test suites out of the image (CI-25)', () => {
    const web = tracked('web');
    const suites = web.filter((file) => file.endsWith('.test.cjs'));
    expect(suites.length).toBeGreaterThan(0);
    expect(suites.filter((file) => !dockerIgnored(patterns, file))).toEqual([]);
    // Everything the console serves still reaches the image.
    expect(web.filter((file) => !file.endsWith('.test.cjs') && dockerIgnored(patterns, file))).toEqual([]);
    // And the image CI builds proves it, whatever the matcher above gets wrong.
    const ci = parse(read('.github/workflows/ci.yml')) as { jobs: Record<string, { steps: Array<{ run?: string }> }> };
    expect(ci.jobs['deploy-artifacts']!.steps.map((step) => step.run ?? '').join('\n'))
      .toContain('find /app/web -name "*.test.cjs"');
    for (const file of ['src/main.ts', 'vendor/panagent/package.json', 'package-lock.json', 'tsconfig.json'])
      expect(dockerIgnored(patterns, file), file).toBe(false);
  });

  it('keeps sources the image never copies out of the build context', () => {
    for (const file of ['tests/deploy-image.test.ts', 'benchmarks/results/README.md', 'design/gold-logo-options/gold-check.svg'])
      expect(dockerIgnored(patterns, file), file).toBe(true);
  });

  it('installs production dependencies exactly as CI resolves them (CI-27)', () => {
    const dockerfile = read('deploy/Dockerfile');
    expect(dockerfile).toContain('npm ci --omit=dev');
    expect(dockerfile).not.toContain('--legacy-peer-deps');
  });
});

describe('base images (CI-27)', () => {
  const dockerfiles = tracked('*Dockerfile', '**/*.Dockerfile').filter((file) => fs.existsSync(path.join(repoRoot, file)));

  it('pins every base image by digest, not only by a movable tag', () => {
    expect(dockerfiles).toEqual(expect.arrayContaining(['deploy/Dockerfile', 'deploy/Caddy.Dockerfile', 'environments/browser/Dockerfile']));
    for (const file of dockerfiles) {
      const stages = new Set<string>();
      for (const [, image, stage] of read(file).matchAll(/^FROM\s+(\S+)(?:\s+AS\s+(\S+))?/gim)) {
        if (!stages.has(image!)) expect(image, `${file}: ${image}`).toMatch(/^[^@\s]+:[^@\s]+@sha256:[0-9a-f]{64}$/);
        if (stage) stages.add(stage);
      }
    }
  });

  // A digest never moves, so without an updater the image would stop receiving
  // the base distribution's security fixes.
  it('lets Dependabot refresh every pinned digest', () => {
    const config = parse(read('.github/dependabot.yml')) as { updates: Array<{ 'package-ecosystem': string; directory?: string; directories?: string[] }> };
    const docker = config.updates.filter((update) => update['package-ecosystem'] === 'docker')
      .flatMap((update) => update.directories ?? [update.directory!]);
    for (const file of dockerfiles) expect(docker, file).toContain(`/${path.posix.dirname(file)}`);
  });
});

// RT-35: V8 sizes a heap from the host's memory, so the gateway's limit must
// come from the container's budget, and it can only be set as Node starts.
describe('control-plane process memory', () => {
  it('starts the gateway with the heap limit its memory budget allows', () => {
    const cmd = read('deploy/Dockerfile').split('\n').find((line) => line.startsWith('CMD '))!;
    const argv = JSON.parse(cmd.slice(4)) as string[];
    expect(argv.slice(0, 2)).toEqual(['sh', '-c']);
    const script = argv[2]!;
    expect(script).toContain('src/runtime/memory-budget.ts gateway');
    expect(script).toMatch(/exec node --max-old-space-size="\$heap" --import tsx src\/main\.ts$/);
    // The budget itself answers from this checkout.
    const heap = execFileSync(process.execPath, ['--import', 'tsx', 'src/runtime/memory-budget.ts', 'gateway'],
      { cwd: repoRoot, encoding: 'utf8', env: { ...process.env, KARMAX_WORKER_MODE: 'process', KARMAX_MEMORY_LIMIT_MB: '4096' } });
    expect(heap.trim()).toBe('614');
  });
});
