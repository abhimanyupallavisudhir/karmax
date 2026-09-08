// Run after generate-check-knot-tilted.mjs. The arrow paths follow the supplied
// sketch in the finished icon's 512px coordinate system; the knot is unchanged.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const base = readFileSync(new URL('../web/brand/check-knot-tilted/icon.svg', import.meta.url), 'utf8');
const arrows = `  <g fill="#681B98" stroke="#681B98" stroke-linejoin="round">
    <path d="M136 190L183 224L282 140" fill="none" stroke-width="26" stroke-linecap="round"/>
    <path d="M305 120L266 131L290 159Z" stroke-width="2"/>
    <path d="M136 256L183 290L316 191" fill="none" stroke-width="26" stroke-linecap="round"/>
    <path d="M339 174L300 181L322 211Z" stroke-width="2"/>
  </g>
`;
const svg = base
  .replace('aria-label="Checkmark endless knot tilted in perspective"', 'aria-label="Perspective knot with two purple checkmark arrows"')
  .replace('scripts/generate-check-knot-tilted.mjs; edit the generator.', 'scripts/generate-check-knot-purple.mjs; edit the generator.')
  .replace('</svg>', `${arrows}</svg>`);
const directory = new URL('../web/brand/check-knot-purple/', import.meta.url);
mkdirSync(directory, { recursive: true });
writeFileSync(new URL('icon.svg', directory), svg);
