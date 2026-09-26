import { expect, it } from 'vitest';
import { WorldReferenceKeys } from '../src/world/reference-keys.js';

it('keeps references readable after environment key rotation and process restart (WD-1)', async () => {
  const secrets = new Map<string, string>();
  const broker = { ensureHandle: async (id: string, value: string) => { if (!secrets.has(id)) secrets.set(id, value); },
    resolve: (id: string) => secrets.get(id)! } as any;
  const first = await WorldReferenceKeys.create(broker);
  const sealed = first.seal({ sandboxId: 'live' });
  expect(sealed).toMatch(/^KWR2\./);
  const second = await WorldReferenceKeys.create(broker);
  expect(second.open(sealed)).toEqual({ sandboxId: 'live' });
  expect(() => second.open(sealed.slice(0, -8) + 'AAAAAAAA')).toThrow();
  expect(secrets.size).toBe(1);
});
