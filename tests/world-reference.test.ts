import { expect, it } from 'vitest';
import { WorldReferenceKeys, unreadableReferenceWarning } from '../src/world/reference-keys.js';

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

it('names the key each unreadable reference needs (WD-30a)', () => {
  expect(unreadableReferenceWarning([])).toBeUndefined();
  const warning = unreadableReferenceWarning(['KWR2.0123456789abcdef.body', 'S1dSMWxlZ2FjeQ', 'S1dSMWFub3RoZXI', undefined])!;
  expect(warning).toMatch(/^4 world reference\(s\) cannot be opened; their sandboxes will be preserved\./);
  expect(warning).toContain("1 sealed under the vault's world-reference:key:v2");
  expect(warning).toContain('KARMAX_VAULT_KEY');
  expect(warning).toContain('2 legacy reference(s) sealed under KARMAX_WORLD_REF_KEY');
  expect(warning).toContain('1 carry no sealed reference');
});
