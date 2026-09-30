import { expect, it } from 'vitest';
import { requireDocker } from './helpers/docker-gate.js';

it('fails an enabled Docker suite when Docker is unavailable', () => {
  expect(() => requireDocker(false)).toThrow(/Docker is required/);
  expect(() => requireDocker(true)).not.toThrow();
});
