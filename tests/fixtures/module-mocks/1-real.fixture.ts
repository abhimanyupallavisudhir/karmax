import { expect, it } from 'vitest';
import { send } from './consumer.js';

it('loads the consumer with the real transport', () => expect(send()).toBe('real'));
