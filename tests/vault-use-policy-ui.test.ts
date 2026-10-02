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

it('warns that blind use can still leak and agent sees reaches the model provider', () => {
  const source = fs.readFileSync('web/app.js', 'utf8');
  const tip = (name: string) => vm.runInNewContext(`${source.match(new RegExp(`^const ${name} = .+;$`, 'm'))![0]}\n${name}`);
  expect(tip('POL_USE_TIP')).toMatch(/leak.*malicious/i);
  expect(tip('POL_REVEAL_TIP')).toMatch(/model provider.*training data/i);
});
