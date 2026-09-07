import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.resolve('web/app.js'), 'utf8');
const styles = fs.readFileSync(path.resolve('web/styles.css'), 'utf8');
const view = source.slice(source.indexOf('function onboardingStep('), source.indexOf('/** Re-point the favicon'));

describe('hosted onboarding UI', () => {
  it('renders the required sequence, with the optional item visibly non-blocking', () => {
    const labels = [
      'Connect GitHub',
      'Add agent logins',
      'Add an E2B API key',
      'Add passwords and a payment card',
      'Create your first project',
    ];
    for (let index = 1; index < labels.length; index++)
      expect(view.indexOf(labels[index - 1]!)).toBeLessThan(view.indexOf(labels[index]!));
    expect(view).toContain('onboarding-optional');
    expect(view).toContain('This never blocks setup.');
    expect(view).toContain('Optional items do not count toward completion.');
  });

  it('links to the real settings anchors and invokes the existing project flow', () => {
    expect(view).toContain('#settings-code');
    expect(view).toContain('#settings-agents');
    expect(view).toContain('#settings-compute');
    expect(view).toContain('#settings-payments');
    expect(view).toContain("addEventListener('click', newProject)");
  });

  it('gives the operator a hosted-only Installation card that shows the guide again', () => {
    const installation = source.slice(source.indexOf('function installationView()'), source.indexOf('function organizationView()'));
    // Hosted-only: a private installation has no guide and gets neither the nav link nor the card.
    expect(installation).toContain(`S.meta?.hosted ? '<a href="#installation-onboarding">Setup guide</a>'`);
    expect(installation).toContain('S.meta?.hosted ? `<div class="settings-section-title" id="installation-onboarding">');
    expect(installation).toContain('wireOnboardingResetCard()');
    expect(installation).toContain("api('/api/settings/installation/onboarding/reset', { method: 'POST' })");
    // It is a whole-installation action behind a confirmation, and it says what it does not touch.
    expect(installation).toContain('if (!confirm(');
    expect(installation).toContain('no projects, tasks, connections, or settings');
  });

  it('loads the newly created organization’s onboarding state before repainting the shell', () => {
    const createOrganization = source.slice(source.indexOf('async function createOrganization()'), source.indexOf('// ── theme'));
    expect(createOrganization).toContain('await refreshOnboarding()');
    expect(createOrganization.indexOf('await refreshOnboarding()')).toBeLessThan(createOrganization.indexOf('renderShell()'));
  });

  it('is hosted-only, server-persisted, live-refreshed, minimizable, and accessible', () => {
    expect(source).toContain("if (!S.meta?.hosted || !organizationId || !S.user)");
    expect(source).toContain("method: 'PUT', body: JSON.stringify({ display })");
    expect(source).toContain('queueMicrotask(() => refreshOnboarding())');
    expect(view).toContain('function pollOnboarding()');
    expect(view).toContain('aria-label="Minimize setup guide"');
    expect(view).toContain('aria-label="Open setup guide"');
    expect(view).toContain('role="progressbar"');
    expect(styles).toContain('.onboarding-minimized');
    expect(styles).toContain('@media (max-width: 760px)');
  });
});
