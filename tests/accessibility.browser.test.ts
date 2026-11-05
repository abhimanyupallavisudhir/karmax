import path from 'node:path';
import { it } from 'vitest';
import { runWebRegression } from './helpers/run-web-regression.js';

// axe-core over the console's main pages and the public site in both looks,
// light and dark, and on a phone (tests/accessibility-check.cjs): sixty page
// loads, too long for the web regression suite's per-file limit.
it('meets WCAG 2.2 AA on the console\'s main pages and the public site, in every look', () => {
  runWebRegression(path.join(process.cwd(), 'tests', 'accessibility-check.cjs'), 300_000);
}, 320_000);
