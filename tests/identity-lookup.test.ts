import { describe, expect, it } from 'vitest';
import { IdentityService } from '../src/auth/identity.js';

describe('identity lookup', () => {
  it('fetches one user by primary key', async () => {
    const identity = await IdentityService.open(':memory:', { baseURL: 'http://localhost:4599',
      secret: 'fixture-only-identity-secret-32-characters' });
    try {
      const user = await identity.createUser({ name: 'Alice', email: 'alice@example.com', password: 'fixture-password-123' });
      expect(await identity.userById(user.id)).toMatchObject({ id: user.id, email: user.email, name: 'Alice' });
      expect(await identity.userById('missing')).toBeUndefined();
    } finally { await identity.close(); }
  });
});
