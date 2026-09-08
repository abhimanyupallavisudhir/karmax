// The .44-wide ribbons on a unit grid leave .56-wide channels for the inlays.
// Reuse the knot's projection so the purple edges fit those channels exactly.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { path } from './generate-check-knot-tilted.mjs';

const base = readFileSync(new URL('../web/brand/check-knot-tilted/icon.svg', import.meta.url), 'utf8');
// --arrow extends only the lower check. The swept-back shoulders sit beyond
// the upper check, with a recessed neck rather than a solid triangular head.
const arrow = process.argv.includes('--arrow');
const checkmarks = [
  [[-.78, 1.22], [.22, 1.22], [.22, -.78], [.78, -.78], [.78, 1.78], [-.78, 1.78]],
  arrow
    ? [[.22, 2.22], [1.22, 2.22], [1.22, -1.42], [.94, -1.25],
      [1.5, -1.8], [2.06, -1.25], [1.78, -1.42], [1.78, 2.78], [.22, 2.78]]
    : [[.22, 2.22], [1.22, 2.22], [1.22, -.22], [1.78, -.22], [1.78, 2.78], [.22, 2.78]],
];
const inlays = `  <path fill="#681B98" d="${path(checkmarks)}"/>\n`;
const svg = base
  .replace('aria-label="Checkmark endless knot tilted in perspective"', `aria-label="${arrow ? 'Perspective knot with two purple checkmarks, the lower ending in a swept arrowhead' : 'Perspective knot with two fitted purple checkmarks'}"`)
  .replace('scripts/generate-check-knot-tilted.mjs; edit the generator.', `scripts/generate-check-knot-purple.mjs${arrow ? ' --arrow' : ''}; edit the generator.`)
  .replace('</svg>', `${inlays}</svg>`);
const directory = new URL(`../web/brand/check-knot-purple${arrow ? '-arrow' : ''}/`, import.meta.url);
mkdirSync(directory, { recursive: true });
writeFileSync(new URL('icon.svg', directory), svg);
