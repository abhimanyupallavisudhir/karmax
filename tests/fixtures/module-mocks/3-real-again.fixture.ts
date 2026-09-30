import { expect, it } from 'vitest';
import { send } from './consumer.js';

it('inherits nothing from the earlier mock', () => expect(send()).toBe('real'));
