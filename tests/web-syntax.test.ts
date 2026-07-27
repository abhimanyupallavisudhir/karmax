import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

describe('browser application', () => {
  it('is valid JavaScript', () => {
    const file = path.resolve('web/app.js');
    const source = fs.readFileSync(file, 'utf8');

    expect(() => new vm.Script(source, { filename: file })).not.toThrow();
  });
});
