import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const app = fs.readFileSync(path.resolve('web/app.js'), 'utf8');
const css = fs.readFileSync(path.resolve('web/styles.css'), 'utf8');

describe('public landing page', () => {
  it('is the signed-out root while direct auth and invitation routes stay direct', () => {
    expect(app).toContain('return renderLanding()');
    expect(app).toContain("location.pathname === '/login'");
    expect(app).toContain("location.pathname === '/signup'");
    expect(app).toContain('S.pendingInvite || S.justVerified || S.signInError');
    expect(app).toContain("location.pathname === '/login' || location.pathname === '/signup'");
  });

  it('carries the product thesis and each promised capability', () => {
    const landing = app.slice(app.indexOf('function renderLanding()'), app.indexOf('function renderLogin()'));
    expect(landing).toContain('krmax is a fancy <em>to-do list.</em>');
    expect(landing).toContain('managing agents');
    expect(landing).toContain('Parallel, isolated work');
    expect(landing).toContain('Gitignored files');
    expect(landing).toContain('AI subscription or API key');
    expect(landing).toContain('krmax MCP');
    expect(landing).toContain('password vault and payment card');
    expect(landing).toContain('As human-in-the-loop');
    expect(landing).toContain('robust authorization system');
  });

  it('shows a product task list instead of a decorative placeholder', () => {
    expect(app).toContain('aria-label="krmax task list showing agents working in parallel"');
    expect(app).toContain('Three isolated cloud worlds');
    expect(app).toContain('Deploy the marketing site');
    expect(app).toContain('waiting for approval');
  });

  it('is responsive, keyboard-visible, and respects reduced motion', () => {
    expect(app).toContain('class="landing-skip"');
    expect(css).toContain('.landing-page :is(button, a):focus-visible');
    expect(css).toContain('@media (max-width: 680px)');
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
  });
});
