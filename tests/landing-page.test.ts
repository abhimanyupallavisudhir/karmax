import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const app = fs.readFileSync(path.resolve('web/app.js'), 'utf8');
const css = fs.readFileSync(path.resolve('web/styles.css'), 'utf8');

function renderLandingMarkup() {
  const landing = app.slice(app.indexOf('function renderLanding()'), app.indexOf('function renderLogin()'));
  const root = { innerHTML: '' };
  const document = { title: '', body: { classList: { add() {} } } };
  const render = new Function('$', 'document', 'window', 'siteName', 'siteNameMarkup', 'brandMark', 'esc', 'location',
    `${landing}; renderLanding();`);
  render((selector: string) => selector === '#app' ? root : undefined, document, {},
    () => 'tavya', () => 'tavya', () => '<img class="mark">', (value: string) => value, { host: 'tavya.io' });
  return { html: root.innerHTML, document };
}

describe('public landing page', () => {
  it('renders Tavya in the homepage and representative screenshot, including its address bar', () => {
    const landing = app.slice(app.indexOf('function renderLanding()'), app.indexOf('function renderLogin()'));
    const root = { innerHTML: '' };
    const document = { title: '', body: { classList: { add() {} } } };
    const render = new Function('$', 'document', 'window', 'siteName', 'siteNameMarkup', 'brandMark', 'esc', 'location',
      `${landing}; renderLanding();`);
    render((selector: string) => selector === '#app' ? root : undefined, document, {},
      () => 'tavya', () => 'tavya', () => '<img class="mark">', (value: string) => value, { host: 'tavya.io' });
    expect(document.title).toBe('tavya — the to-do list for agents');
    expect(root.innerHTML).toContain('tavya.io / tavya');
    expect(root.innerHTML).toContain('<strong>tavya</strong></div>');
    expect(root.innerHTML).toContain('<div class="product-project active"><span>◇</span> tavya</div>');
    // The existing issue-tracker URL is a repository identifier, not branding.
    expect(root.innerHTML.replace(/href="[^"]*"/g, '')).not.toMatch(/krmax/i);
  });

  it('is the signed-out root while direct auth and invitation routes stay direct', () => {
    expect(app).toContain('return renderLanding()');
    expect(app).toContain("location.pathname === '/login'");
    expect(app).toContain("location.pathname === '/signup'");
    expect(app).toContain('S.pendingInvite || S.justVerified || S.signInError');
    expect(app).toContain("location.pathname === '/login' || location.pathname === '/signup'");
  });

  it('carries the product thesis and each promised capability', () => {
    const landing = app.slice(app.indexOf('function renderLanding()'), app.indexOf('function renderLogin()'));
    expect(landing).toContain('<strong>vscode</strong><span>was a fancy <b>text editor.</b>');
    expect(landing).toContain('<strong>${siteNameMarkup()}</strong><span>is a fancy <b>to-do list.</b>');
    expect(landing).toContain('The <em>correct</em> interface');
    expect(landing).toContain('managing agents');
    expect(landing).toContain('manually coding/working');
    expect(landing).toContain('Agents work parallelly in isolated cloud worlds.');
    expect(landing).toContain('Yes, gitignored files are handled correctly.');
    expect(landing).toContain('secrets, databases, big files');
    expect(landing).toContain('Bring your own key or OpenAI/Claude subscription');
    expect(landing).toContain('${siteNameMarkup()} MCP lets agents access and manage your ${siteNameMarkup()} projects');
    expect(landing).toContain('Connect your apps and a payment card, and let agents Just Do Things.');
    expect(landing).not.toContain('password vault and a payment card');
    expect(landing).toContain('buy me a website and deploy to it');
    expect(landing).toContain('run the experiment on vast.ai');
    expect(landing).toContain('As human-in-the-loop');
    expect(landing).toContain('<strong>authorization system</strong>');
    expect(landing).toContain('Leave the permanent');
    expect(landing.match(/Just do things\./g)).toHaveLength(2);
    expect(landing).not.toContain('Everything is a to-do list.');
    expect(landing).not.toContain('No new AI subscription');
    expect(landing).not.toContain('The whole idea');
    expect(landing).not.toContain('Human in the loop');
    expect(landing).not.toContain('Your Integrated Management Environment');
    expect(landing).not.toContain('<em>underclass</em>');
  });

  it('uses a faithful, installation-branded task list to advertise implemented features', () => {
    expect(app).toContain('aria-label="${siteNameMarkup()} task list showing agents working in parallel"');
    expect(app).toContain('${esc(location.host)} / ${siteNameMarkup()}');
    expect(app).toContain('<div class="product-wordmark">${brandMark()}<strong>${siteNameMarkup()}</strong></div>');
    expect(app).toContain('<div class="product-project active"><span>◇</span> ${siteNameMarkup()}</div>');
    expect(app).toContain('<span>Queues</span><span>Wiki</span><span>Settings</span>');
    expect(app).toContain('Support e2b cloud environments for agents');
    expect(app).toContain('Support Github auto-merge, merge queues in addition to native merge queue');
    expect(app).toContain('Password vault: implement git-backed <code>unix pass</code> importer');
    expect(app).toContain('Let agents create accounts with agentmail.to');
    expect(app).toContain('Add spending limits for agents');
    expect(app).toContain('MathJaX support in agent conversations');
    expect(app).toContain('Wiki-based agent memory');
    expect(renderLandingMarkup().html.match(/class="product-stage done">done/g)).toHaveLength(7);
    expect(app).not.toContain('Three isolated cloud worlds');
    expect(app).not.toContain('One calm list');
  });

  it('lists capabilities as a checklist, so an item without detail is just a shorter row', () => {
    const { html } = renderLandingMarkup();
    const checklist = html.slice(html.indexOf('<ul class="landing-checklist">'), html.indexOf('</ul>'));
    expect(checklist.match(/<li><span class="landing-tick">/g)).toHaveLength(5);
    expect(checklist).not.toMatch(/<article/);
    expect(css).not.toMatch(/\.landing-checks[^-]/);
  });

  it('defaults to the dark theme and lets visitors switch to light with the console preference', () => {
    const { html } = renderLandingMarkup();
    expect(html).toContain('id="landing-theme"');
    const base = css.slice(css.indexOf('.landing-page {'), css.indexOf('}', css.indexOf('.landing-page {')));
    expect(base).toContain('--l-bg: #0e1015');
    expect(css).toContain('html[data-theme="light"] .landing-page {');
    expect(css).toContain('body.landing-active { color-scheme: dark;');
    expect(app).toContain("localStorage.setItem('karmax-theme', next)");
    // First paint already matches for signed-out visitors, never for signed-in ones.
    const index = fs.readFileSync(path.resolve('web/index.html'), 'utf8');
    expect(index).toContain("localStorage.getItem('karmax-theme') !== 'light' && !localStorage.getItem('karmax-signed-in')");
    expect(css).toContain('html.landing-boot body:not(:has(#app > *))');
    expect(app).toContain("if (signedOut) localStorage.removeItem('karmax-signed-in');");
    // The landing ignores the console's blue/serif leftovers and uses its tokens.
    expect(css).not.toContain('--land-');
  });

  it('is responsive, keyboard-visible, and respects reduced motion', () => {
    expect(app).toContain('class="landing-skip"');
    expect(css).toContain('.landing-page :is(button, a):focus-visible');
    expect(css).toContain('@media (max-width: 680px)');
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
  });

  it('sends public GitHub links to the issue tracker, never the private repository', () => {
    const landing = app.slice(app.indexOf('function renderLanding()'), app.indexOf('function renderLogin()'));
    expect(landing.match(/https:\/\/github\.com\/abhimanyupallavisudhir\/krmax-issues\/issues/g)).toHaveLength(2);
    expect(landing).not.toContain('github.com/abhimanyupallavisudhir/karmax');
  });
});
