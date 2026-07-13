import { describe, expect, it } from 'vitest';
import { mergeModels } from '../src/agent/models.js';

describe('provider model discovery', () => {
  it('unions account-specific catalogs without duplicating model ids', () => {
    expect(mergeModels([
      [{ id: 'shared', displayName: 'Shared' }, { id: 'account-a' }],
      [{ id: 'shared', displayName: 'Duplicate' }, { id: 'account-b' }],
    ])).toEqual([
      { id: 'shared', displayName: 'Shared' },
      { id: 'account-a' },
      { id: 'account-b' },
    ]);
  });
});
