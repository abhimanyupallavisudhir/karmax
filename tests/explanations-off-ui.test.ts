import { afterAll, describe, expect, it } from 'vitest';
import { closeConsoleBrowser, consolePage } from './helpers/console-page.js';

afterAll(closeConsoleBrowser);

// "Explain this" follows the server's feature flag: off hides the button and
// the Explanation model settings, but keeps the TeX toggle beside each message.
describe('Explain this, behind /api/meta explanationsEnabled', () => {
  for (const enabled of [false, true]) {
    it(`${enabled ? 'shows' : 'hides'} the button and the settings card when ${enabled ? 'on' : 'off'}`, async () => {
      const ui = await consolePage();
      const counts = await ui.run<{ run: number; more: number; tex: number; card: string }>(`
        S.meta = { ...S.meta, explanationsEnabled: ${enabled} };
        $('#main').innerHTML = explainMessageAffordance({ sourceKey: 'message:1', conversationRole: 'do' }, { taskId: 't1' });
        ({ run: $('#main').querySelectorAll('.explain-run').length, more: $('#main').querySelectorAll('.explain-more').length,
           tex: $('#main').querySelectorAll('.tex-toggle').length, card: explanationSettingsCard('project') })
      `);
      expect(counts.run).toBe(enabled ? 1 : 0);
      expect(counts.more).toBe(enabled ? 1 : 0);
      expect(counts.tex).toBe(1);
      expect(counts.card.includes('Explanation model')).toBe(enabled);
      expect(ui.errors).toEqual([]);
      await ui.close();
    });
  }
});
