import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const originalTemporalCli = process.env.TEMPORAL_CLI;

afterEach(() => {
  if (originalTemporalCli === undefined) delete process.env.TEMPORAL_CLI;
  else process.env.TEMPORAL_CLI = originalTemporalCli;
  delete process.env.FAKE_TEMPORAL_COUNTER;
  vi.resetModules();
});

describe('ephemeral Temporal dev-server startup', () => {
  it('retries a child that exits before opening its gRPC port', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-temporal-retry-'));
    const binary = path.join(home, 'temporal.mjs');
    const counter = path.join(home, 'attempts');
    fs.writeFileSync(binary, `#!/usr/bin/env node
import fs from 'node:fs';
import net from 'node:net';
const counter = process.env.FAKE_TEMPORAL_COUNTER;
const attempt = Number(fs.existsSync(counter) ? fs.readFileSync(counter, 'utf8') : '0') + 1;
fs.writeFileSync(counter, String(attempt));
if (attempt === 1) process.exit(2);
const portIndex = process.argv.indexOf('--port');
const server = net.createServer(() => {});
server.listen(Number(process.argv[portIndex + 1]), '127.0.0.1');
process.on('SIGTERM', () => server.close(() => process.exit(0)));
`);
    fs.chmodSync(binary, 0o755);
    process.env.TEMPORAL_CLI = binary;
    process.env.FAKE_TEMPORAL_COUNTER = counter;
    vi.resetModules();

    try {
      const { startDevServer } = await import('../src/temporal/dev-server.js');
      const server = await startDevServer({ headless: true, logLevel: 'never' });
      expect(fs.readFileSync(counter, 'utf8')).toBe('2');
      await server.stop();
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
