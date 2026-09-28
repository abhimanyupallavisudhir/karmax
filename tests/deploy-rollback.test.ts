import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { afterEach, expect, it } from 'vitest';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const operator = fs.readFileSync(new URL('../deploy/karmax', import.meta.url), 'utf8');

function update(previousEpoch: string | undefined, targetEpoch: string, ready = false, failure = '', flags: string[] = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-rollback-')); roots.push(root);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q', '-b', 'master');
  git('config', 'user.name', 'Rollback Test'); git('config', 'user.email', 'rollback@example.test');
  fs.mkdirSync(path.join(root, 'deploy'));
  fs.writeFileSync(path.join(root, 'fixture'), 'previous');
  if (previousEpoch !== undefined) fs.writeFileSync(path.join(root, 'deploy/data-epoch'), previousEpoch);
  git('add', '.'); git('commit', '-qm', 'previous');
  const previous = git('rev-parse', 'HEAD');
  fs.writeFileSync(path.join(root, 'fixture'), 'target');
  fs.writeFileSync(path.join(root, 'deploy/data-epoch'), targetEpoch);
  git('add', '.'); git('commit', '-qm', 'target');
  const target = git('rev-parse', 'HEAD');
  git('update-ref', 'refs/remotes/origin/master', target); git('checkout', '-q', '--detach', previous);
  fs.mkdirSync(path.join(root, 'deploy'), { recursive: true });
  fs.writeFileSync(path.join(root, 'deploy/.turnkey.env'), '');
  // Exercise the real updater against a real Git history. Only infrastructure
  // effects are stubbed; failed readiness must select the safe recovery branch.
  const script = operator.slice(0, operator.indexOf('\nusage() {')) + `
need_docker() { :; }
git() {
  case "$*" in *"fetch --prune origin master") return 0 ;; esac
  command git "$@"
}
dc() {
  printf '%s\\n' "$*" >> "$ROOT_DIR/operations"
  case "$*" in *vault-preflight*) [ "${failure}" != vault ]; return ;; esac
  [ "${failure}" != build ] || [ "$*" != "build --pull app" ]
}
cmd_backup_candidate() { destination="$DEPLOY_DIR/backups/fixture"; mkdir -p "$destination"; [ "${failure}" != backup ]; }
ready_calls=0
wait_ready() { ready_calls=$((ready_calls + 1)); [ "${ready ? '1' : '0'}" = 1 ] || [ "$ready_calls" -gt 1 ]; }
cmd_update "$@"
`;
  const file = path.join(root, 'deploy/fixture-updater'); fs.writeFileSync(file, script);
  const result = spawnSync('sh', [file, ...flags, target], { cwd: root, encoding: 'utf8' });
  const operations = fs.existsSync(path.join(root, 'operations')) ? fs.readFileSync(path.join(root, 'operations'), 'utf8') : '';
  return { ...result, operations, head: git('rev-parse', 'HEAD'), previous, target };
}

it('stops instead of starting legacy code against migrated state', () => {
  const result = update(undefined, '2\n');
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('code-only rollback refused');
  expect(result.operations).toContain('stop app');
  expect(result.operations.match(/up -d/g)).toHaveLength(1);
  expect(result.head).toBe(result.target);
});
it('retains automatic rollback within the same data epoch', () => {
  const result = update('2\n', '2\n');
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('production was restored');
  expect(result.operations.match(/up -d/g)).toHaveLength(2);
  expect(result.head).toBe(result.previous);
});
it('completes a healthy epoch transition', () => {
  const result = update(undefined, '2\n', true);
  expect(result.status).toBe(0);
  expect(result.head).toBe(result.target);
  expect(result.operations).not.toContain('stop app');
});
it('rejects a malformed epoch before changing the deployment', () => {
  const result = update('2\n', 'not-an-epoch\n');
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('invalid data epoch');
  expect(result.head).toBe(result.previous);
  expect(result.operations).toBe('');
});

it('refuses a forward Git commit that would downgrade the data epoch', () => {
  const result = update('2\n', '1\n');
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('refusing data epoch downgrade');
  expect(result.head).toBe(result.previous);
  expect(result.operations).toBe('');
});

it('terminates a readiness probe whose server accepts the request but never replies', async () => {
  const expression = operator.split('wait_ready() {')[1]!.match(/node -e "([^"]+)"/)![1]!;
  let requested = false;
  const server = createServer(() => { requested = true; });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const child = spawn(process.execPath, ['-e', expression.replace('127.0.0.1:4505', `127.0.0.1:${port}`)], { stdio: 'ignore' });
  const watchdog = setTimeout(() => child.kill('SIGKILL'), 10_000);
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject); child.once('exit', resolve);
    });
    expect(requested).toBe(true);
    expect(code).toBe(1);
  } finally {
    clearTimeout(watchdog);
    child.kill();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

it.each(['build', 'backup'])('keeps the previous deployment when candidate %s fails before startup', failure => {
  const result = update(undefined, '2\n', false, failure);
  expect(result.status).toBe(1);
  expect(result.head).toBe(result.previous);
  expect(result.operations).not.toContain('up -d');
  expect(result.operations).not.toContain('stop app');
});

// The vault binding (AU-27), the CVC split (AU-31) and the per-item usage
// records rewrite data the previous release cannot read. A readiness failure
// after that first boot must stop, not restart the previous image against it.
it('puts the one-way vault migration behind its own data epoch', () => {
  const epoch = Number(fs.readFileSync(new URL('../deploy/data-epoch', import.meta.url), 'utf8').trim());
  expect(epoch).toBeGreaterThanOrEqual(3);
  const readme = fs.readFileSync(new URL('../deploy/README.md', import.meta.url), 'utf8');
  expect(readme).toMatch(/Epoch 3[^]*vault[^]*one-way/);
  expect(readme).toContain('entries.pre-v2');
});

// #367 review item 4: automatic rollback cannot cross epoch 3, so a first
// boot that would refuse the vault key, stop on an unreadable entry or
// quarantine one is caught with the new image before the switch.
it('keeps the previous app serving when the vault preflight finds anything', () => {
  const result = update('2\n', '3\n', true, 'vault');
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('vault preflight');
  expect(result.stderr).toContain('--accept-vault-findings');
  const operations = result.operations.split('\n');
  const preflight = operations.findIndex(line => line.includes('vault-preflight'));
  expect(preflight).toBeGreaterThan(operations.findIndex(line => line === 'build --pull app'));
  expect(result.operations).not.toContain('up -d');
  expect(result.head).toBe(result.previous);
});

it('proceeds past the vault preflight only when told to', () => {
  const result = update('2\n', '3\n', true, 'vault', ['--accept-vault-findings']);
  expect(result.status, result.stderr).toBe(0);
  expect(result.head).toBe(result.target);
  expect(result.operations).toContain('vault-preflight');
});
