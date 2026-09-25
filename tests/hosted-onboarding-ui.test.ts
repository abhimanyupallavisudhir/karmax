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
      'Add an E2B or Daytona API key',
      'Connect apps, and add payments and a payment card',
      'Buy paid plan',
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
    expect(view).toContain('#settings-connections');
    expect(view).toContain('#settings-plan');
    expect(view).toContain('Manage E2B/Daytona');
    expect(view).toContain("key === 'paidPlan'");
    expect(view).toContain("addEventListener('click', newProject)");
  });

  it('loads the newly created organization’s onboarding state before repainting the shell', () => {
    const createOrganization = source.slice(source.indexOf('async function createOrganization()'), source.indexOf('// ── theme'));
    expect(createOrganization).toContain('await refreshOnboarding()');
    expect(createOrganization.indexOf('await refreshOnboarding()')).toBeLessThan(createOrganization.indexOf('renderShell()'));
  });

  it('is hosted-only, server-persisted, live-refreshed, minimizable, and accessible', () => {
    expect(source).toContain("if (!S.meta?.hosted || !organizationId || !S.user)");
    expect(source).toContain("method: 'PUT', body: JSON.stringify({ display, finishReplay })");
    expect(source).toContain('queueMicrotask(() => refreshOnboarding())');
    expect(view).toContain('function pollOnboarding()');
    expect(view).toContain('aria-label="Minimize setup guide"');
    expect(view).toContain('aria-label="Close setup guide"');
    expect(view).toContain("setOnboardingDisplay('closed')");
    expect(view).toContain('aria-label="Open setup guide"');
    expect(view).toContain('role="progressbar"');
    expect(styles).toContain('.onboarding-minimized');
    expect(styles).toContain('@media (max-width: 760px)');
  });

  it('keeps window controls together in the header, not a Minimize button in the footer', () => {
    const head = view.slice(view.indexOf('class="onboarding-head"'), view.indexOf('class="onboarding-progress"'));
    expect(head.indexOf('id="onboarding-minimize"')).toBeGreaterThan(-1);
    expect(head.indexOf('id="onboarding-minimize"')).toBeLessThan(head.indexOf('id="onboarding-close"'));
    expect(head).toContain('ICON.minimize');
    expect(head).toContain('ICON.close');
    const foot = view.slice(view.indexOf('class="onboarding-foot"'));
    expect(foot.slice(0, foot.indexOf('</section>'))).not.toContain('Minimize');
    expect(view).not.toContain('onboarding-minimize-foot');
  });
});
