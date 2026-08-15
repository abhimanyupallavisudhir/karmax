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
    expect(landing).toContain('Your Integrated Management Environment');
    expect(landing).toContain('<strong>VS Code</strong><span>was a fancy <b>text editor.</b>');
    expect(landing).toContain('<strong>krmax</strong><span>is a fancy <b>to-do list.</b>');
    expect(landing).toContain('The <em>correct</em> interface');
    expect(landing).toContain('managing agents');
    expect(landing).toContain('manually coding/working');
    expect(landing).toContain('Agents work parallelly in isolated cloud worlds.');
    expect(landing).toContain('Yes, we handle gitignored files.');
    expect(landing).toContain('secrets, databases, big files');
    expect(landing).toContain('Bring your own key');
    expect(landing).toContain('or OpenAI/Claude subscription');
    expect(landing).toContain('krmax MCP lets agents access and manage your krmax projects');
    expect(landing).toContain('Connect a password vault and a payment card, and agents can Just Do Things.');
    expect(landing).toContain('As human-in-the-loop');
    expect(landing).toContain('<strong>authorization system</strong>');
    expect(landing).toContain('Leave the permanent');
    expect(landing).toContain('Everything is a to-do list.');
    expect(landing).not.toContain('No new AI subscription');
    expect(landing).not.toContain('The whole idea');
    expect(landing).not.toContain('Human in the loop');
  });

  it('uses a faithful krmax task list to advertise implemented features', () => {
    expect(app).toContain('aria-label="krmax task list showing agents working in parallel"');
    expect(app).toContain('krmax.io / krmax');
    expect(app).toContain('<span>Queues</span><span>Wiki</span><span>Settings</span>');
    expect(app).toContain('Support e2b cloud environments for agents');
    expect(app).toContain('Support Github auto-merge, merge queues in addition to native merge queue');
    expect(app).toContain('Password vault: implement git-backed <code>unix pass</code> importer');
    expect(app).toContain('Let agents create accounts with agentmail.to');
    expect(app).toContain('Add spending limits for agents');
    expect(app).toContain('MathJaX support in agent conversations');
    expect(app).toContain('Wiki-based agent memory');
    expect(app.match(/class="product-stage done">done/g)).toHaveLength(7);
    expect(app).not.toContain('Three isolated cloud worlds');
    expect(app).not.toContain('One calm list');
  });

  it('is responsive, keyboard-visible, and respects reduced motion', () => {
    expect(app).toContain('class="landing-skip"');
    expect(css).toContain('.landing-page :is(button, a):focus-visible');
    expect(css).toContain('@media (max-width: 680px)');
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
  });
});
