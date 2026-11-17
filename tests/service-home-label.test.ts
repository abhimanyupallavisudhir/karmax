import crypto from 'node:crypto';
import { expect, it } from 'vitest';
import { serviceHomeLabel } from '../src/world/services.js';

// tavya.io and its staging instance share provider accounts and the same data
// home (/var/lib/karmax): without KARMAX_INSTANCE each one's sweep would list,
// bill and reap the other's sandboxes and VMs.
it('labels worlds per installation, unchanged for one that does not name itself', () => {
  const home = '/var/lib/karmax';
  const legacy = crypto.createHash('sha256').update(home).digest('hex').slice(0, 12);
  expect(serviceHomeLabel(home, undefined)).toBe(legacy);
  expect(serviceHomeLabel(home, '')).toBe(legacy);
  expect(serviceHomeLabel(home, 'staging')).not.toBe(legacy);
  expect(serviceHomeLabel(home, 'staging')).toMatch(/^[0-9a-f]{12}$/);
  expect(serviceHomeLabel(home, 'staging')).not.toBe(serviceHomeLabel(home, 'canary'));
});
