// The store texts in mobile/store/ (wiki features/phone-apps § Publishing): every field
// that is pasted into a store is a fenced block under a heading that ends in its limit,
// "(80)", and must fit it as the stores count (Unicode characters). Also the rules the
// listing states for itself: keywords as Apple wants them, no prices or buying (App
// Store 3.1.1, Play payments), and no feature the apps don't have.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const STORE = path.resolve('mobile/store');

/** Each heading that ends in "(limit)" and the fenced block under it. */
function fields(file: string): Array<{ heading: string; limit: number; text: string }> {
  const lines = fs.readFileSync(path.join(STORE, file), 'utf8').split('\n');
  const out: Array<{ heading: string; limit: number; text: string }> = [];
  for (let index = 0; index < lines.length; index++) {
    const heading = /^#+ (.*)\((\d+)\)\s*$/.exec(lines[index]!);
    if (!heading) continue;
    const open = lines.findIndex((line, at) => at > index && line.startsWith('```'));
    const close = lines.findIndex((line, at) => at > open && line.startsWith('```'));
    expect(open, `a block under "${heading[1]}"`).toBeGreaterThan(index);
    out.push({ heading: heading[1]!.trim(), limit: Number(heading[2]), text: lines.slice(open + 1, close).join('\n') });
  }
  return out;
}
const length = (text: string) => [...text].length;

describe('store texts', () => {
  for (const file of ['listing.md', 'review-notes.md']) {
    it(`${file}: every pasted field fits its store's limit`, () => {
      const found = fields(file);
      expect(found.length).toBeGreaterThan(1);
      for (const field of found) {
        expect(field.text.trim().length, field.heading).toBeGreaterThan(0);
        expect(length(field.text), `${field.heading}: ${length(field.text)} of ${field.limit}`).toBeLessThanOrEqual(field.limit);
      }
    });
  }

  it('says only what the apps do, and sells nothing', () => {
    const listing = fields('listing.md');
    const keywords = listing.find((field) => field.heading === 'Keywords')!.text;
    expect(keywords).not.toMatch(/\s/);
    expect(keywords.toLowerCase()).not.toContain('tavya');
    for (const brand of ['claude', 'codex', 'openai', 'siri', 'google', 'github', 'chatgpt']) expect(keywords.toLowerCase()).not.toContain(brand);
    const words = [...listing, ...fields('review-notes.md')].map((field) => field.text).join('\n');
    expect(words).not.toMatch(/[$€£]\s?\d|\bper month\b|\bsubscribe\b|\bupgrade\b/i);
    expect(words).not.toMatch(/hey tavya|wake word/i);
    // Offline is read-and-keep until offline edits land (sub-task F adds its own line then).
    expect(words).not.toMatch(/edit[^.\n]*offline|offline[^.\n]*edit/i);
  });
});

describe('store screenshots', () => {
  // Each slot's size in pixels, as the stores require it (screenshots/README.md). The
  // pictures are laid out in CSS pixels; painted without the device's ratio they come
  // out a third of the size, and the stores refuse them.
  const SLOTS: Record<string, [number, number]> = {
    'ios/iphone-6.9': [1290, 2796], 'ios/iphone-6.5': [1242, 2688], 'ios/ipad-13': [2064, 2752],
    'android/phone': [1080, 1920], 'android/tablet-7': [1080, 1920], 'android/tablet-10': [1440, 2560],
  };
  const size = (file: string) => { const head = fs.readFileSync(file).subarray(16, 24); return [head.readUInt32BE(0), head.readUInt32BE(4)]; };
  it('are each slot\'s exact size, six to a slot, with the 1024×500 feature graphic', () => {
    for (const [slot, expected] of Object.entries(SLOTS)) {
      const dir = path.join(STORE, 'screenshots', slot);
      const files = fs.readdirSync(dir).filter((name) => name.endsWith('.png'));
      expect(files, slot).toHaveLength(6);
      for (const name of files) expect(size(path.join(dir, name)), `${slot}/${name}`).toEqual(expected);
    }
    expect(size(path.join(STORE, 'screenshots/android/feature-graphic.png'))).toEqual([1024, 500]);
  });
});
