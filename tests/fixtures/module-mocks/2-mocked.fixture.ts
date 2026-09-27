import { expect, it, vi } from 'vitest';
import { send } from './consumer.js';

vi.mock('./transport.js', () => ({ transport: () => 'mocked' }));

it('reaches a module an earlier file already loaded', () => expect(send()).toBe('mocked'));
