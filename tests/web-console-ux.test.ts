// Source-level regressions for a batch of console bugs: invisible toasts, a
// reconnect backfill that never ran, a duplicated keyframe that froze every
// "working" indicator, silent form failures, an unescaped widget branch, a
// listener leak, and the copy/affordance fixes that went with them.
//
// These are deliberately DOM-free — they assert on the shipped source, like the
// other web/* regressions, because the console has no build step to hook into.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const webDir = path.resolve('web');
const app = fs.readFileSync(path.join(webDir, 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(webDir, 'styles.css'), 'utf8');
const html = fs.readFileSync(path.join(webDir, 'index.html'), 'utf8');

/** The source of one event handler: from its anchor to the end of its callback. */
function handlerAfter(anchor: string): string {
  const at = app.indexOf(anchor);
  expect(at, `anchor not found: ${anchor}`).toBeGreaterThan(-1);
  return app.slice(at, at + 1200);
}

describe('toasts are reachable', () => {
  it('stacks above every scrim, so modal validation errors are visible', () => {
    const toasts = /\.toasts \{[^}]*z-index: (\d+)/.exec(css);
    expect(toasts).not.toBeNull();
    const toastZ = Number(toasts![1]);
    // Every other stacking context that can cover the viewport must sit below it.
    for (const [, z] of css.matchAll(/z-index: ?(\d+)/g)) {
      expect(Number(z)).toBeLessThanOrEqual(toastZ);
    }
  });

  it('gives error toasts a longer dwell and a dismiss button', () => {
    const toastFn = handlerAfter('function toast(msg, err = false, action)');
    expect(toastFn).toContain('toast-dismiss');
    // "Saved" keeps its 3.2s; an error the user may need to read lingers.
    const dwell = /setTimeout\(\(\) => t\.remove\(\), action \? 6500 : err \? (\d+) : 3200\)/.exec(toastFn);
    expect(dwell).not.toBeNull();
    expect(Number(dwell![1])).toBeGreaterThan(3200);
    expect(css).toContain('.toast-dismiss');
  });

  it('announces itself to assistive tech', () => {
    expect(html).toMatch(/<div class="toasts" id="toasts"[^>]*aria-live="polite"/);
    expect(html).toMatch(/<div class="toasts" id="toasts"[^>]*role="status"/);
  });
});

describe('websocket reconnect', () => {
  it('backfills the open task through the real state key', () => {
    expect(app).toContain('if (wsHadDropped) { refreshTasks().catch(() => {}); if (S.selected) refreshTask().catch(() => {}); }');
    // S.taskId never existed — the old guard was permanently false.
    expect(app).not.toMatch(/\bS\.taskId\b/);
  });
});

describe('profile account controls', () => {
  it('edits the existing email row instead of rendering a second email card', () => {
    expect(app).toContain('data-profile-edit="email"');
    expect(app).toContain('id="profile-email-panel"');
    expect(app).toContain('id="profile-email"');
    expect(app).toContain("fetch('/api/auth/change-email'");
    expect(app).toContain('Confirmation link sent to');
    expect(app).not.toContain("row('Account'");
    expect(css).toContain('.profile-edit-panel');
    expect(css).not.toContain('.profile-email-form');
  });

  it('offers a masked password row and a complete change-password panel', () => {
    expect(app).toContain('********');
    expect(app).toContain('data-profile-edit="password"');
    expect(app).toContain('id="profile-password-panel"');
    expect(app).toContain('id="profile-current-password"');
    expect(app).toContain('id="profile-new-password"');
    expect(app).toContain('id="profile-confirm-password"');
    expect(app).toContain("fetch('/api/auth/change-password'");
  });
});

describe('animations', () => {
  it('defines @keyframes pulse exactly once', () => {
    expect([...css.matchAll(/@keyframes pulse(?![-\w])/g)]).toHaveLength(1);
  });

  it('keeps the breathing status dots on the alternating keyframe', () => {
    // A second `@keyframes pulse` silently overrode this one and made the four
    // "agent is working" dots fade-and-snap instead of breathe.
    expect(css).toContain('@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }');
    expect([...css.matchAll(/animation: pulse 1\.4s ease-in-out infinite;/g)].length).toBeGreaterThanOrEqual(4);
    expect(css).toContain('@keyframes pulse-dot');
    expect(css).toContain('animation: pulse-dot 1s ease-in-out infinite alternate');
  });
});

describe('forms report their failures', () => {
  // Each of these used to await bare, with the success toast after the await:
  // on failure the button looked dead and the rejection went unhandled.
  const anchors = [
    "row.querySelector('.resource-toggle').addEventListener",
    "row.querySelector('.resource-delete').addEventListener",
    "box.querySelectorAll('.service-delete')",
    "$('#environment-save')?.addEventListener",
    "$('#main').querySelectorAll('[data-inbox-toggle]')",
    "$('#inbox-read-all')?.addEventListener",
    "$('#save-delivery')?.addEventListener",
  ];
  for (const anchor of anchors) {
    it(`${anchor} surfaces the error`, () => {
      expect(handlerAfter(anchor)).toMatch(/catch \((error|e)\) \{ toast\(/);
    });
  }

  it('replaces dead-end pane errors with a retry', () => {
    expect(app).not.toContain('box.textContent = error.message');
    expect(app).toContain('function paneError(box, error, retry)');
    expect(app).toContain('Couldn’t load this section.');
  });
});

describe('destructive actions confirm first', () => {
  it('confirms before removing a project member', () => {
    expect(handlerAfter("row.querySelector('.project-member-remove')")).toContain('confirm(');
  });

  it('confirms before deleting a project service', () => {
    expect(handlerAfter("box.querySelectorAll('.service-delete')")).toContain('confirm(');
  });
});

describe('widget rendering', () => {
  it('escapes gauge data like every other branch', () => {
    const gauge = app.slice(app.indexOf("case 'gauge': {"), app.indexOf("case 'gauge': {") + 900);
    // Widget data comes from installed workflow packages (external git repos).
    expect(gauge).toContain('esc(g.value)');
    expect(gauge).toContain('esc(g.max)');
    expect(gauge).toContain('Number(g.pct)');
    expect(gauge).not.toContain('${g.pct}%');
    expect(gauge).not.toContain('title="${g.value}');
  });
});

describe('wiki-mention wiring', () => {
  it('scopes its listeners so re-rendered textareas do not leak', () => {
    const fn = app.slice(app.indexOf('function wireWikiMention('), app.indexOf('// ── the path-as-title control'));
    expect(fn).toContain('new AbortController()');
    // The window-level listener is the one that retained detached textareas.
    expect(fn).not.toContain("window.addEventListener('resize', close)");
    expect(fn).toMatch(/window\.addEventListener\('resize',[\s\S]*?\}, \{ signal \}\);/);
    // Every textarea listener rides the signal too, so aborting unwires it fully.
    expect([...fn.matchAll(/ta\.addEventListener\(/g)].length)
      .toBe([...fn.matchAll(/, \{ signal \}\);/g)].length - 1);
    expect(app).toContain('function sweepWikiMentionWirings()');
  });
});

describe('focus is always visible', () => {
  it('rings the task search and the view chips', () => {
    expect(css).toMatch(/\.task-search:focus-visible \{[^}]*outline: 2px solid var\(--accent\)/);
    expect(css).toMatch(/\.view-chip:focus-visible \{[^}]*outline: 2px solid var\(--accent\)/);
  });
});

describe('mobile viewport', () => {
  it('sizes the login card with dvh so it does not jump under the address bar', () => {
    expect(css).toMatch(/\.login-wrap \{[^}]*height: 100dvh/);
  });
});

describe('copy', () => {
  /**
   * INTENDED, and the reason this is not a blanket "never capitalize" rule:
   * `Krmax` is correct in the two *app-name* positions — the PWA manifest
   * (`name`/`short_name`) and `apple-mobile-web-app-title` — because an OS
   * install prompt and a home-screen label are proper-noun slots rendered by
   * the platform, not our prose. `tests/brand.test.ts` owns and asserts that
   * split. Everywhere a human reads the name *in a sentence* it is lowercase
   * `krmax`, matching the wordmark. This test guards the prose half only.
   */
  it('spells the product name one way in prose', () => {
    const proseFiles = fs.readdirSync(webDir)
      .filter((name) => /\.(js|cjs|css)$/.test(name));
    for (const name of proseFiles) {
      const body = fs.readFileSync(path.join(webDir, name), 'utf8');
      expect(body, `${name} capitalizes the product name in prose`).not.toMatch(/Krmax/);
    }
    expect(html).toContain('<title>krmax</title>');
  });

  it('does not leak internal codenames or internal concept names', () => {
    expect(app).not.toContain('jayadratha');
    expect(app).toContain('title="Selected to merge — the other attempts are stopped.">committed<');
    // "layer" is the internal name for the confirmer stack.
    expect(app).not.toContain('Add layer');
    expect(app).not.toContain('No layers');
    expect(app).toContain('No reviewers — this task auto-confirms at Review.');
    expect(app).not.toContain('No account coordinator running');
  });

  it('points empty states at their next action', () => {
    expect(app).toContain('No earlier agent to continue from — this will start fresh.');
    expect(app).toContain('No vault items yet. Add one in ');
    expect(app).toContain('No tags yet. Create one with the 🏷 Tags button.');
  });

  /**
   * An empty state that names a destination is only helpful if the destination
   * exists. "No vault items yet. Add one in Settings → Vault." pointed at a
   * section that has never existed — the vault lives under "Passwords &
   * payments" — which is strictly worse than the vague text it replaced, because
   * it sends the reader somewhere and they find nothing.
   *
   * Assert the invariant rather than the copy: every `Settings → X` the console
   * prints must name a real entry in the settings nav.
   */
  it('only sends people to settings sections that exist', () => {
    // Both the organization (`#settings-*`) and project (`#project-*`) navs —
    // a "Settings → X" pointer may legitimately name either.
    const navLabels = new Set(
      [...app.matchAll(/<a href="#(?:settings|project)-[\w-]+">([^<]+)<\/a>/g)]
        .map((m) => m[1]!.replace(/&amp;/g, '&').trim()),
    );
    expect(navLabels.size).toBeGreaterThan(5); // the parse itself must not silently yield nothing

    // Only karmax's own settings: drop `//` comment lines, and ignore a chained
    // path into some other product's settings (e.g. "Tailscale → Settings → …").
    const source = app.split('\n').filter((line) => !/^\s*\/\//.test(line)).join('\n');
    const pointers = [...source.matchAll(/(.{0,24})Settings → (.{0,60})/g)]
      .filter((m) => !/(Tailscale|Android|iOS|Chrome|macOS|Windows)\s*→?\s*$/.test(m[1]!))
      .map((m) => m[2]!.replace(/&amp;/g, '&'));
    expect(pointers.length).toBeGreaterThan(0);
    for (const rest of pointers) {
      // The destination is whichever real section name the text begins with —
      // the sentence usually continues ("… to spread turns across accounts").
      const hit = [...navLabels].some((label) => rest.startsWith(label));
      expect(hit, `"Settings → ${rest.slice(0, 40)}…" does not name a settings section`).toBe(true);
    }
  });

  it('offers a retry instead of raw server text on the resources pane', () => {
    expect(app).not.toContain('Could not inspect task resources');
    expect(app).toContain('Couldn’t load this task’s resources.');
    expect(app).toContain('resource-review-retry');
  });

  it('states each failure once and briefly', () => {
    expect(app).toContain("const EMAIL_SEND_FAILED = 'Couldn’t send the email. Outbound email may not be set up.';");
    expect(app).not.toContain('Could not send confirmation email');
    expect(app).not.toContain('Precedence + enable/disable');
    expect(app).toContain('Drag to reorder, toggle to disable — for this task only.');
  });
});
