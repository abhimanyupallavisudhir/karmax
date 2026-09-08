// The .44-wide ribbons on a unit grid leave .56-wide channels for the inlays.
// Reuse the knot's projection so the purple edges fit those channels exactly.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { path, iconPoint } from './generate-check-knot-tilted.mjs';

const base = readFileSync(new URL('../web/brand/check-knot-tilted/icon.svg', import.meta.url), 'utf8');
// --arrow extends only the lower check. The swept-back shoulders sit beyond
// the upper check, with a recessed neck rather than a solid triangular head.
const arrow = process.argv.includes('--arrow');
const checkmarks = [
  [[-.78, 1.22], [.22, 1.22], [.22, -.78], [.78, -.78], [.78, 1.78], [-.78, 1.78]],
  [[.22, 2.22], [1.22, 2.22], [1.22, -.22], [1.78, -.22], [1.78, 2.78], [.22, 2.78]],
];
function arrowPath() {
  // Construct the head AFTER projection: mirroring in the knot's grid gives
  // unequal visible wings. Measure the actual shaft width normal to its axis.
  const start = iconPoint([1.5, 0]), station = iconPoint([1.5, -1.2]);
  const length = Math.hypot(station[0] - start[0], station[1] - start[1]);
  const axis = station.map((v, i) => (v - start[i]) / length);
  const normal = [-axis[1], axis[0]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
  const cut = u => {
    const a = iconPoint([u, 0]), b = iconPoint([u, -2]);
    const delta = b.map((v, i) => v - a[i]);
    const t = dot(station.map((v, i) => v - a[i]), axis) / dot(delta, axis);
    return a.map((v, i) => v + t * delta[i]);
  };
  const left = cut(1.22), right = cut(1.78);
  const middle = left.map((v, i) => (v + right[i]) / 2);
  const width = Math.hypot(right[0] - left[0], right[1] - left[1]);
  const headPoint = (forward, side) => middle.map((v, i) => v + width * (forward * axis[i] + side * normal[i]));
  const polygon = [
    ...[[.22, 2.22], [1.22, 2.22]].map(iconPoint),
    left, headPoint(-.15, -.95), headPoint(1.2, 0), headPoint(-.15, .95), right,
    ...[[1.78, 2.78], [.22, 2.78]].map(iconPoint),
  ];
  return polygon.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(3)} ${y.toFixed(3)}`).join('') + 'Z';
}
const inlays = `  <path fill="#681B98" d="${arrow ? path([checkmarks[0]]) + arrowPath() : path(checkmarks)}"/>\n`;
const svg = base
  .replace('aria-label="Checkmark endless knot tilted in perspective"', `aria-label="${arrow ? 'Perspective knot with two purple checkmarks, the lower ending in a swept arrowhead' : 'Perspective knot with two fitted purple checkmarks'}"`)
  .replace('scripts/generate-check-knot-tilted.mjs; edit the generator.', `scripts/generate-check-knot-purple.mjs${arrow ? ' (arrow variant)' : ''}; edit the generator.`)
  .replace('</svg>', `${inlays}</svg>`);
const directory = new URL(`../web/brand/check-knot-purple${arrow ? '-arrow' : ''}/`, import.meta.url);
mkdirSync(directory, { recursive: true });
writeFileSync(new URL('icon.svg', directory), svg);
