import { expect, it } from 'vitest';
import { gunzipSync } from 'node:zlib';
import { encodePortableDelta, type DeltaFile } from '../src/world/checkpoint-encoding.js';

it('retains version-1 restore compatibility for binary, deleted, and escaped filenames', async () => {
  const files: DeltaFile[] = [
    { repo: 'main', path: 'quotes"and\nlines', data: Buffer.from([0, 255, 1]).toString('base64') },
    { repo: 'other', path: 'deleted', deleted: true },
    { repo: '', path: 'empty', data: '' },
  ];
  async function* source() { yield* files; }
  expect(JSON.parse(gunzipSync(await encodePortableDelta(source())).toString())).toEqual({ version: 1, files });
  async function* empty() {}
  expect(JSON.parse(gunzipSync(await encodePortableDelta(empty())).toString())).toEqual({ version: 1, files: [] });
});

it('fails the checkpoint when a lazy file read fails instead of publishing a partial delta', async () => {
  async function* source() {
    yield { repo: '', path: 'first', data: 'YQ==' };
    throw Error('sandbox read failed');
  }
  await expect(encodePortableDelta(source())).rejects.toThrow('sandbox read failed');
});
