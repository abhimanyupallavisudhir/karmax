import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { staticAssetHeaders, staticAssetRevision } from '../src/gateway/server.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('console static assets', () => {
  it('revalidates unversioned JavaScript after a deploy', () => {
    expect(staticAssetHeaders('/srv/krmax/web/app.js')).toEqual({
      'content-type': 'text/javascript; charset=utf-8',
      'cache-control': 'no-cache',
    });
  });

  it('changes the console revision when a deploy replaces app.js', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-static-revision-'));
    dirs.push(dir);
    const file = path.join(dir, 'app.js');
    fs.writeFileSync(file, 'const revision = 1;');
    const first = staticAssetRevision(file);
    fs.writeFileSync(file, 'const revision = 200;');
    const second = staticAssetRevision(file);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(second).not.toBe(first);
  });
});
