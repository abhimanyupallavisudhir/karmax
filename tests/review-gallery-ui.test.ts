import { afterAll, describe, expect, it } from 'vitest';
import { closeConsoleBrowser, consolePage, type ApiCall } from './helpers/console-page.js';

afterAll(closeConsoleBrowser);

// Review files show as a gallery: images (and videos) as real thumbnails,
// anything else as a file tile; the viewer steps through them with ‹ › and
// the arrow keys. Commands stay buttons, web pages stay links.
const svg = (fill: string) => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200"><rect width="320" height="200" fill="${fill}"/></svg>`)}`;
const actions = [
  { kind: 'open', label: 'Header', target: 'out/header.png' },
  { kind: 'run', label: 'Run tests', command: 'npm test' },
  { kind: 'open', label: 'Report', target: 'out/report.md' },
  { kind: 'open', label: 'Footer', target: 'out/footer.png' },
  { kind: 'open', label: 'Docs', target: 'https://example.com/docs' },
];
const resolved: Record<number, unknown> = {
  0: { kind: 'open', url: svg('#2a6'), name: 'header.png', mediaType: 'image/svg+xml' },
  2: { kind: 'open', url: `data:text/markdown,${encodeURIComponent('# Report\n\nAll good.')}`, name: 'report.md', mediaType: 'text/markdown' },
  3: { kind: 'open', url: svg('#a26'), name: 'footer.png', mediaType: 'image/svg+xml' },
};

async function review() {
  const ui = await consolePage({ api: ({ method, path, body }: ApiCall) =>
    method === 'POST' && path === '/api/tasks/t1/review-action' ? resolved[body.index] : undefined });
  await ui.run(`S.view = { taskId: 't1', title: 'Change', stage: 'review', status: 'waiting', messages: [], state: {}, actions: [],
      reviewInfo: { caption: 'Check the header', actions: ${JSON.stringify(actions)} } };
    document.getElementById('main').innerHTML = conversationReviewInfo(S.view);
    wireReviewActions(S.view); loadReviewThumbnails(S.view);`);
  const resolves = () => ui.calls.filter((call) => call.path === '/api/tasks/t1/review-action').map((call) => call.body.index);
  return { ui, resolves };
}

describe('Review gallery', () => {
  it('shows images as thumbnails, other files as tiles, and commands and pages as buttons', async () => {
    const { ui, resolves } = await review();
    const tiles = ui.page.locator('.review-gallery .review-tile');
    expect(await tiles.locator('.review-tile-label').allInnerTexts()).toEqual(['Header', 'Report', 'Footer']);
    await expect.poll(() => ui.page.locator('.review-tile[data-tile="image"] img').count()).toBe(2);
    await expect.poll(() => ui.page.locator('.review-tile[data-tile="image"] img').first().evaluate((img: any) => img.naturalWidth)).toBe(320);
    expect(await ui.page.locator('.review-tile[data-tile="md"] .review-tile-file').innerText()).toBe('MD');
    expect(resolves().sort()).toEqual([0, 3]); // only images are fetched up front
    expect(await ui.page.getByRole('button', { name: /Run tests/ }).count()).toBe(1);
    expect(await ui.page.getByRole('link', { name: /Docs/ }).getAttribute('href')).toBe('https://example.com/docs');
    expect(ui.errors).toEqual([]);
    await ui.close();
  });

  it('steps through every file in the viewer with the arrows, reusing the thumbnails’ URLs', async () => {
    const { ui, resolves } = await review();
    await expect.poll(() => ui.page.locator('.review-tile img').count()).toBe(2);
    await ui.page.getByRole('button', { name: 'Header' }).click();
    const viewer = ui.page.locator('dialog.artifact-reader');
    await viewer.locator('img').waitFor();
    expect(await viewer.locator('h2').innerText()).toBe('header.png');
    expect(await viewer.locator('.artifact-reader-count').innerText()).toBe('1 / 3');
    await viewer.getByRole('button', { name: 'Next' }).click();
    await viewer.locator('.md').waitFor();
    expect(await viewer.locator('h2').innerText()).toBe('report.md');
    expect(await viewer.locator('.artifact-reader-content').innerText()).toContain('All good.');
    await ui.page.keyboard.press('ArrowRight');
    await expect.poll(() => viewer.locator('h2').innerText()).toBe('footer.png');
    expect(await viewer.locator('.artifact-reader-count').innerText()).toBe('3 / 3');
    await ui.page.keyboard.press('ArrowRight'); // wraps around
    await expect.poll(() => viewer.locator('h2').innerText()).toBe('header.png');
    await ui.page.keyboard.press('ArrowLeft');
    await expect.poll(() => viewer.locator('h2').innerText()).toBe('footer.png');
    expect(await ui.page.locator('dialog.artifact-reader').count()).toBe(1);
    expect(resolves().sort()).toEqual([0, 2, 3]); // each file resolved once
    await ui.page.keyboard.press('Escape');
    await expect.poll(() => viewer.count()).toBe(0);
    expect(ui.errors).toEqual([]);
    await ui.close();
  });
});
