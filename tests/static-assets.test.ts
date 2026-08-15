import { describe, expect, it } from 'vitest';
import { staticAssetHeaders } from '../src/gateway/server.js';

describe('console static assets', () => {
  it('revalidates unversioned JavaScript after a deploy', () => {
    expect(staticAssetHeaders('/srv/krmax/web/app.js')).toEqual({
      'content-type': 'text/javascript; charset=utf-8',
      'cache-control': 'no-cache',
    });
  });
});
