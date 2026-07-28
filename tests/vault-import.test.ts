import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * "Select all → Import" from a `pass` store looked like a dead button: one
 * blocking request decrypted ~600 entries (ten minutes of GPG on a real store)
 * with no feedback, and a single unreadable entry threw the whole batch away.
 * The client now imports in batches and reports progress.
 */
const app = readFileSync(fileURLToPath(new URL('../web/app.js', import.meta.url)), 'utf8');

function importFromConnector() {
  const source = app.match(/async function importFromConnector\([\s\S]*?\n}/)?.[0];
  expect(source, 'importFromConnector() should exist in web/app.js').toBeTruthy();
  return new Function(`${source}; return importFromConnector;`)() as (
    sync: (batch: string[]) => Promise<any>,
    externalIds: string[],
    onProgress?: (p: any) => void,
    batchSize?: number,
  ) => Promise<{ imported: number; skipped: number; failures: any[]; done: number; total: number }>;
}

describe('connector import (web)', () => {
  const ids = Array.from({ length: 25 }, (_, i) => `sites/${i}.com`);

  it('splits the selection into batches and reports progress as they land', async () => {
    const batches: string[][] = [];
    const progress: Array<{ done: number; total: number }> = [];
    const result = await importFromConnector()(
      async (batch) => { batches.push(batch); return { count: batch.length, skipped: 0, failures: [] }; },
      ids,
      (p) => progress.push({ done: p.done, total: p.total }),
      10,
    );
    expect(batches.map((b) => b.length)).toEqual([10, 10, 5]);
    expect(progress.map((p) => p.done)).toEqual([0, 10, 20, 25]);
    expect(progress.every((p) => p.total === 25)).toBe(true);
    expect(result.imported).toBe(25);
  });

  it('accumulates what landed, what was unchanged, and what failed', async () => {
    const result = await importFromConnector()(
      async (batch) => batch[0] === 'sites/0.com'
        ? { count: 9, skipped: 1, failures: [{ externalId: 'sites/3.com', error: 'gpg: no secret key' }] }
        : { count: batch.length, skipped: 0, failures: [] },
      ids,
      undefined,
      10,
    );
    expect(result).toMatchObject({ imported: 24, skipped: 1, done: 25, total: 25 });
    expect(result.failures).toEqual([{ externalId: 'sites/3.com', error: 'gpg: no secret key' }]);
  });

  it('stops on a systemic failure so the reason reaches the user', async () => {
    let calls = 0;
    await expect(importFromConnector()(
      async () => { calls++; throw new Error('your GPG key is locked'); },
      ids, undefined, 10,
    )).rejects.toThrow(/GPG key is locked/);
    expect(calls).toBe(1);
  });

  it('disables and relabels the Import button while the import runs', () => {
    const handler = app.match(/go\.addEventListener\('click',[\s\S]*?\n {4}\}\);/)?.[0];
    expect(handler, 'the Import button handler should exist').toBeTruthy();
    expect(handler).toMatch(/go\.disabled = true/);
    expect(handler).toMatch(/Importing \$\{p\.done\}\/\$\{p\.total\}…/);
    expect(handler).toMatch(/finally \{ go\.disabled = false; go\.textContent = 'Import'; \}/);
  });
});
