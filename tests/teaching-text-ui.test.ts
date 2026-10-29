import { afterAll, describe, expect, it } from 'vitest';
import { closeConsoleBrowser, consolePage } from './helpers/console-page.js';

afterAll(closeConsoleBrowser);

// Keep what teaches (owner, 2026-10-29): text that shows people the syntax they
// can write themselves (audience tokens, wiki references, capability ids, event
// types, accepted formats) stays visible; a cleanup may shorten, never hide it.
describe('console text that teaches', () => {
  it('shows audiences, scopes, capabilities and wiki references as they are written', async () => {
    const ui = await consolePage();
    const out = await ui.run<Record<string, string>>(`(() => {
      const main = document.getElementById('main');
      main.innerHTML = audienceComboHtml('aud', '@creator, @team:leaders', 'Audience');
      const audience = main.querySelector('.audience-combo');
      const tree = roleCapabilityTree([{ label: 'Tasks', capabilities: [{ id: 'task:create', label: 'Create tasks', description: 'x' }] }], ['task:*']);
      main.innerHTML += '<div class="prompt-context-row"><input type="hidden" id="v"><span class="pc-chips"></span><textarea class="prompt-context"></textarea></div>';
      wireContextChips(document.getElementById('v'), ['[[proj:tag:default]]'], undefined);
      return {
        audience: audience.querySelector('input').value,
        overlay: String(!!audience.querySelector('.audience-face')),
        responder: displayParam({ type: 'responder' }, { kind: 'human', audience: ['@creator'] }),
        scope: authorizationSummary({ level: 'administrator', scope: 'organization' }, []),
        tree,
        chip: main.querySelector('.pc-chip').textContent,
      };
    })()`);
    expect(out.audience).toBe('@creator, @team:leaders');
    expect(out.overlay).toBe('false');
    expect(out.responder).toBe('@creator');
    expect(out.scope).toMatch(/· @organization$/);
    expect(out.tree).toContain('<code>task:create</code>');
    expect(out.chip).toContain('[[proj:tag:default]]');
    expect(ui.errors).toEqual([]);
    await ui.close();
  });
});
