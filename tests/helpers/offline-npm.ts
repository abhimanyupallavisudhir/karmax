import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach } from 'vitest';
import { PINNED_REMOTE_NODE_VERSION } from '../../src/agent/remote-node.js';

/** registry.npmjs.org is not part of a test. On 2026-10-22 its audit endpoint
 * stopped answering for an hour, and master CI #2262 and every branch with it
 * timed out in the files that reached it: npx waited on the audit, and each
 * disk-backed world installed Node from npm. Call at a file's top level: npm
 * then talks to a local registry that refuses every request at once, and a
 * test that made one fails naming it. */
export function offlineNpmRegistry(): void {
  const requests: string[] = [];
  let server: http.Server;
  let url = '';
  beforeAll(async () => {
    server = http.createServer((req, res) => { requests.push(`${req.method} ${req.url}`); res.writeHead(404).end(); });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  });
  // Per test: a file may restore process.env after each of its tests.
  beforeEach(() => { process.env.npm_config_registry = url; });
  afterEach(() => {
    const made = requests.splice(0);
    if (made.length) throw new Error(`the test reached the npm registry: ${made.join(', ')}`);
  });
  afterAll(async () => {
    delete process.env.npm_config_registry;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
}

/** The paired Node runtime a remote world's bootstrap would install from npm
 * (`npm install node npm` under `.karmax-injection/agent/tools`), laid out the
 * same way but linked to this process's Node and npm. */
export function linkHostNodeRuntime(root: string): void {
  const runtime = path.join(root, `.karmax-injection/agent/tools/node-${PINNED_REMOTE_NODE_VERSION}`);
  if (fs.existsSync(path.join(runtime, 'bin'))) return;
  // npm sits beside node in Node's own layout (CI); else take the one on PATH.
  const npm = [path.dirname(process.execPath), ...(process.env.PATH ?? '').split(path.delimiter)]
    .map((dir) => path.join(dir, 'npm')).find((file) => fs.existsSync(file));
  if (!npm) throw new Error('no npm beside this Node or on PATH');
  const npmCli = fs.realpathSync(npm);
  fs.mkdirSync(path.join(runtime, 'node_modules/node/bin'), { recursive: true });
  fs.symlinkSync(process.execPath, path.join(runtime, 'node_modules/node/bin/node'));
  fs.symlinkSync(path.dirname(path.dirname(npmCli)), path.join(runtime, 'node_modules/npm'));
  fs.mkdirSync(path.join(runtime, 'bin'));
  for (const [name, target] of [['node', 'node/bin/node'], ['npm', 'npm/bin/npm-cli.js'], ['npx', 'npm/bin/npx-cli.js']])
    fs.symlinkSync(`../node_modules/${target}`, path.join(runtime, 'bin', name!));
}
