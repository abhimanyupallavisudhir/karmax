import fs from 'node:fs';
import vm from 'node:vm';
import { expect, it } from 'vitest';

it('states the browser and environment trust boundary for blind use (AU-14)', () => {
  const source = fs.readFileSync('web/app.js', 'utf8');
  const declaration = source.match(/^const POL_USE_TIP = .+;$/m)![0];
  const tip = vm.runInNewContext(`${declaration}\nPOL_USE_TIP`);
  expect(tip).toMatch(/without returning.*model/i);
  expect(tip).toMatch(/agent can still inspect.*browser.*environment/i);
  expect(tip).not.toMatch(/never sees/);
});
