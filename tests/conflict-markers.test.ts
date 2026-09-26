import { expect, it } from 'vitest';
import { conflictMarkerFiles } from '../src/world/conflict-markers.js';

it('bounds grep argv and preserves literal Unicode/newline paths (WD-10)', async () => {
  const files = ['日本語\n file', ...Array.from({ length: 4000 }, (_, i) => `file-${i}`)];
  let calls = 0;
  const found = await conflictMarkerFiles(async args => {
    calls++;
    const paths = args.slice(args.indexOf('--') + 1);
    expect(paths.length).toBeLessThanOrEqual(128);
    expect(args).toContain('-z');
    return { code: paths.includes(files[0]!) ? 0 : 1, stderr: '', stdout: paths.includes(files[0]!) ? `HEAD:${files[0]}\0` : '' };
  }, 'HEAD', files);
  expect(found).toEqual([files[0]]);
  expect(calls).toBeGreaterThan(2);
});
it('fails closed on a grep execution error (WD-10)', async () => {
  await expect(conflictMarkerFiles(async () => ({ code: 128, stdout: '', stderr: 'E2BIG' }), 'HEAD', ['file']))
    .rejects.toThrow('E2BIG');
});
