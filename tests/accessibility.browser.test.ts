import path from 'node:path';
import { it } from 'vitest';
import { runWebRegression } from './helpers/run-web-regression.js';

// axe-core over the console's main pages in both looks, light and dark, and on a
// phone (tests/accessibility-check.cjs): forty page loads, too long for the
// web regression suite's per-file limit.
it('meets WCAG 2.2 AA on the console\'s main pages, in every look', () => {
  runWebRegression(path.join(process.cwd(), 'tests', 'accessibility-check.cjs'), 300_000);
}, 320_000);
