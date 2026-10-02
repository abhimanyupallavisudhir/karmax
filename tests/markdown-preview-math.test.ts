import { afterAll, describe, expect, it } from 'vitest';
import { closeConsoleBrowser, consolePage } from './helpers/console-page.js';

afterAll(closeConsoleBrowser);

const SOURCE = '# Report\n\nInline $x^2$ and \\(y_1\\), display:\n\n$$\\int_0^1 f$$\n\n\\[a+b\\]\n\nSee [other](other/page).';

// Markdown file previews and wiki pages follow the same math preference as
// conversations, each with its own TeX button that flips it everywhere.
describe('Markdown preview math', () => {
  it('typesets an opened Markdown file and toggles it from the reader’s TeX button', async () => {
    const ui = await consolePage();
    await ui.run(`
      S.taskTab = 'checkin';
      const v = { taskId: 't1' };
      window.renderTaskPage = () => {
        $('#main').innerHTML = explainMessageAffordance({ sourceKey: 'message:1', conversationRole: 'do' }, v);
        wireExplainMessages(v);
      };
      renderTaskPage();
      showArtifactReader(${JSON.stringify(SOURCE)}, 'markdown', 'report.md', new Blob(['x']));
    `);
    const reader = ui.page.locator('.artifact-reader');
    const toggle = reader.getByRole('button', { name: 'Typeset math' });
    expect(await toggle.getAttribute('aria-pressed')).toBe('true');
    await reader.locator('.artifact-reader-content mjx-container').first().waitFor();
    expect(await reader.locator('.artifact-reader-content .md-math').count()).toBe(4);

    await toggle.click();
    expect(await ui.run<string | null>("localStorage.getItem('karmax-mathjax')")).toBe('0');
    expect(await toggle.getAttribute('aria-pressed')).toBe('false');
    expect(await reader.locator('mjx-container, .md-math').count()).toBe(0);
    expect(await reader.locator('.artifact-reader-content').innerText()).toContain('$x^2$');
    // The conversation behind the reader follows the same preference.
    expect(await ui.page.locator('#main .tex-toggle').getAttribute('aria-pressed')).toBe('false');
    await expect.poll(() => ui.page.evaluate(() => (globalThis as any).document.activeElement?.getAttribute('aria-label'))).toBe('Typeset math');

    await toggle.click();
    await reader.locator('.artifact-reader-content mjx-container').first().waitFor();
    expect(await reader.locator('.artifact-reader-content .md-math').count()).toBe(4);
    expect(ui.errors).toEqual([]);
    await ui.close();
  });

  it('keeps plain-text previews free of a TeX button', async () => {
    const ui = await consolePage();
    await ui.run(`showArtifactReader('$x$', 'text', 'notes.txt', new Blob(['x']))`);
    await ui.page.locator('.artifact-reader').waitFor();
    expect(await ui.page.locator('.artifact-reader .tex-toggle').count()).toBe(0);
    await ui.close();
  });

  it('repaints wiki pages in place and keeps their local links working', async () => {
    const ui = await consolePage();
    await ui.run(`
      window.openWikiEntry = (_proj, path) => { window.openedWiki = path; };
      const pane = document.getElementById('main');
      renderWikiPage({ scope: 'project', id: 'p1' }, { id: 'p1' }, pane,
        { name: 'Notes', kind: 'skill', path: 'notes', content: ${JSON.stringify(SOURCE)}, labels: [] });
    `);
    const page = ui.page.locator('#main');
    await page.locator('.wiki-md mjx-container').first().waitFor();
    await page.getByRole('button', { name: 'Typeset math' }).click();
    expect(await page.locator('.wiki-md .md-math').count()).toBe(0);
    expect(await page.locator('.wiki-md').innerText()).toContain('$x^2$');
    await page.getByRole('link', { name: 'other' }).click();
    expect(await ui.run<string>('window.openedWiki')).toBe('other/page');
    await page.getByRole('button', { name: 'Typeset math' }).click();
    await page.locator('.wiki-md mjx-container').first().waitFor();
    expect(ui.errors).toEqual([]);
    await ui.close();
  });

  it('typesets the wiki editor preview and toggles it from the editor bar', async () => {
    const ui = await consolePage();
    await ui.run(`
      renderWikiEditor({ scope: 'project', id: 'p1' }, { id: 'p1' }, document.getElementById('main'),
        { name: 'Notes', kind: 'skill', path: 'notes', content: ${JSON.stringify(SOURCE)}, labels: [] });
    `);
    const page = ui.page.locator('#main');
    await page.getByRole('button', { name: 'Preview' }).click();
    await page.locator('#wiki-preview mjx-container').first().waitFor();
    await page.getByRole('button', { name: 'Typeset math' }).click();
    expect(await page.locator('#wiki-preview .md-math').count()).toBe(0);
    expect(await page.locator('#wiki-preview').innerText()).toContain('$x^2$');
    expect(ui.errors).toEqual([]);
    await ui.close();
  });
});
