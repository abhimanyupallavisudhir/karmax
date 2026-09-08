// The .44-wide ribbons on a unit grid leave .56-wide channels for the inlays.
// Reuse the knot's projection so the purple edges fit those channels exactly.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { path } from './generate-check-knot-tilted.mjs';

const base = readFileSync(new URL('../web/brand/check-knot-tilted/icon.svg', import.meta.url), 'utf8');
const checkmarks = [
  [[-.78, 1.22], [.22, 1.22], [.22, -.78], [.78, -.78], [.78, 1.78], [-.78, 1.78]],
  [[.22, 2.22], [1.22, 2.22], [1.22, -.22], [1.78, -.22], [1.78, 2.78], [.22, 2.78]],
];
const inlays = `  <path fill="#681B98" d="${path(checkmarks)}"/>\n`;
const svg = base
  .replace('aria-label="Checkmark endless knot tilted in perspective"', 'aria-label="Perspective knot with two fitted purple checkmarks"')
  .replace('scripts/generate-check-knot-tilted.mjs; edit the generator.', 'scripts/generate-check-knot-purple.mjs; edit the generator.')
  .replace('</svg>', `${inlays}</svg>`);
const directory = new URL('../web/brand/check-knot-purple/', import.meta.url);
mkdirSync(directory, { recursive: true });
writeFileSync(new URL('icon.svg', directory), svg);
