import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('edge dependency build retries', () => {
  it.each([0, 2, 9])('bounds retries when xcaddy fails %i times', (failures) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caddy-build-'));
    try {
      fs.writeFileSync(path.join(root, 'xcaddy'), `#!/bin/sh
count=0
[ ! -f "$TEST_ROOT/count" ] || count=$(cat "$TEST_ROOT/count")
count=$((count + 1))
echo "$count" > "$TEST_ROOT/count"
echo "$*" >> "$TEST_ROOT/args"
echo "build attempt $count"
if [ "$count" -le "$FAILURES" ]; then exit 42; fi
` , { mode: 0o755 });
      fs.writeFileSync(path.join(root, 'sleep'), '#!/bin/sh\necho "$1" >> "$TEST_ROOT/delays"\n', { mode: 0o755 });
      const result = spawnSync('sh', ['deploy/build-caddy.sh'], { encoding: 'utf8',
        env: { ...process.env, PATH: `${root}:${process.env.PATH}`, TEST_ROOT: root, FAILURES: String(failures) } });
      expect(result.status, result.stderr).toBe(failures < 3 ? 0 : 42);
      const attempts = Math.min(failures + 1, 3);
      expect(Number(fs.readFileSync(path.join(root, 'count'), 'utf8'))).toBe(attempts);
      expect(fs.readFileSync(path.join(root, 'args'), 'utf8').trim().split('\n'))
        .toEqual(Array(attempts).fill('build --with github.com/mholt/caddy-ratelimit@v0.1.0'));
      expect(result.stdout).toContain(`build attempt ${attempts}`);
      expect(fs.existsSync(path.join(root, 'delays')) ? fs.readFileSync(path.join(root, 'delays'), 'utf8') : '')
        .toBe(attempts === 1 ? '' : '5\n10\n');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});
