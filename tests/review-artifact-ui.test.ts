import fs from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const app = fs.readFileSync('web/app.js', 'utf8');
const source = app.slice(app.indexOf('function artifactTextKind('), app.indexOf('// Approve ONE branch'));

describe('review artifact reader', () => {
  function setup(type: string, body = 'hello', target = 'notes.txt') {
    const show = vi.fn();
    const open = vi.fn();
    const fetch = vi.fn(async () => new Response(body, { headers: { 'content-type': type } }));
    const context = vm.createContext({
      S: { token: 'test-token' }, feedbackFetch: fetch, window: { open },
      URL: { createObjectURL: () => 'blob:test', revokeObjectURL: vi.fn() },
      setTimeout: vi.fn(), toast: vi.fn(),
    });
    vm.runInContext(source, context);
    context.showArtifactReader = show;
    return { context, show, open, fetch, run: () => context.openArtifact('/artifact', false, target) };
  }

  it.each([false, true])('consumes reader Escape before full screen or the task (full screen: %s)', (fullscreen) => {
    const listeners: Record<string, (event: any) => void> = {};
    const control = { classList: { add: vi.fn() }, addEventListener: vi.fn(), focus: vi.fn() };
    const dialog = {
      setAttribute: vi.fn(), querySelector: () => control,
      addEventListener: (name: string, handler: (event: any) => void) => { listeners[name] = handler; },
      showModal: vi.fn(), close: vi.fn(),
    };
    const closeTask = vi.fn();
    const pane = { classList: { toggle: vi.fn() } };
    const state = { selected: 'task-1', conversationFullscreen: fullscreen };
    const root = { childElementCount: 0 };
    const select = (selector: string) => {
      if (selector === '#overlay-root' || selector === '#modal-root') return root;
      if (selector === '.ck-pane') return pane;
      if (selector === '.ck-fullscreen') return state.conversationFullscreen ? pane : null;
      return null;
    };
    let shellKeydown: (event: any) => void;
    const context = vm.createContext({
      document: { activeElement: null, createElement: () => dialog,
        body: { appendChild: vi.fn() },
        addEventListener: (_name: string, handler: (event: any) => void) => { shellKeydown = handler; } },
      URL: { createObjectURL: () => 'blob:test' }, esc: (s: string) => s,
      renderMarkdown: () => '', texToggleHtml: () => '', mountMarkdownSurface: vi.fn(), wireTexToggles: vi.fn(), closeTask, S: state,
      $: select, resetChord: vi.fn(), inRail: () => false,
      focusedEnterAction: () => null,
    });
    vm.runInContext(source + '\n' + app.slice(app.indexOf('function closeTopOverlay()'),
      app.indexOf('// -- the dispatcher')) + '\n' + app.slice(app.indexOf('function bindKeys()'),
      app.indexOf('// -- global search:')), context);
    const fullscreenStart = app.indexOf('function setConversationFullscreen(');
    vm.runInContext(app.slice(fullscreenStart, app.indexOf('\n}', fullscreenStart) + 2), context);
    context.showArtifactReader('report', 'markdown', 'report.md', {});
    context.bindKeys();
    const event = { key: 'Escape', defaultPrevented: false, stopPropagation: vi.fn(),
      preventDefault() { this.defaultPrevented = true; } };
    listeners.keydown!(event);
    // Even if another listener forwards this event, the shell must leave the task open.
    shellKeydown!(event);
    expect(dialog.close).toHaveBeenCalledOnce();
    expect(event.stopPropagation).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(true);
    expect(closeTask).not.toHaveBeenCalled();
    expect(state.conversationFullscreen).toBe(fullscreen);
    const nextEscape = () => ({ key: 'Escape', defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; } });
    if (fullscreen) {
      // Once the reader is gone, Escape exits full screen without closing the task.
      const exitEvent = nextEscape();
      shellKeydown!(exitEvent);
      expect(exitEvent.defaultPrevented).toBe(true);
      expect(state.conversationFullscreen).toBe(false);
      expect(pane.classList.toggle).toHaveBeenCalledWith('ck-fullscreen', false);
      expect(closeTask).not.toHaveBeenCalled();
    }
    // With neither reader nor full screen open, Escape closes the task normally.
    shellKeydown!(nextEscape());
    expect(closeTask).toHaveBeenCalledOnce();
  });

  it.each([
    ['text/markdown; charset=utf-8', 'report.md', 'markdown'],
    ['text/plain', 'REPORT.MD', 'markdown'],
    ['application/octet-stream', 'report.markdown', 'markdown'],
    ['text/plain', 'notes.txt', 'text'],
    ['text/csv', 'data.csv', 'text'],
    ['application/json', 'data.json', 'text'],
  ])('renders %s (%s) within the UI', async (type, name, kind) => {
    const t = setup(type, 'content', name);
    await t.run();
    expect(t.show).toHaveBeenCalledWith('content', kind, name, expect.any(Blob));
    expect(t.open).not.toHaveBeenCalled();
    expect(t.fetch).toHaveBeenCalledWith('/artifact', { headers: { authorization: 'Bearer test-token' } });
  });

  it('keeps inert binary artifacts on the existing open path', async () => {
    for (const type of ['application/pdf', 'image/png']) {
      const t = setup(type, 'content', 'report');
      await t.run();
      expect(t.show).not.toHaveBeenCalled();
      expect(t.open).toHaveBeenCalledWith('blob:test', '_blank', 'noopener');
    }
  });

  it('opens HTML artifacts as their own sandboxed document, never as a same-origin blob', async () => {
    // A `blob:` URL carries the console's origin and its policy; the artifact's
    // own URL is served under a `sandbox` policy that gives it an opaque origin.
    const popup: Record<string, unknown> = { opener: 'console' };
    const t = setup('text/html', '<script>alert(1)</script>', 'report.html');
    t.open.mockReturnValueOnce(popup);
    await t.run();
    expect(t.show).not.toHaveBeenCalled();
    expect(t.open).toHaveBeenCalledWith('/artifact', '_blank');
    expect(t.open).toHaveBeenCalledTimes(1);
    expect(popup.opener).toBeNull();
  });

  it('downloads an HTML artifact when a popup blocker stops its window', async () => {
    const anchor = { click: vi.fn(), remove: vi.fn() } as Record<string, any>;
    const t = setup('text/html', '<p>report</p>', 'report.html');
    t.context.document = { createElement: () => anchor, body: { appendChild: vi.fn() } };
    t.open.mockReturnValueOnce(null);
    await t.run();
    expect(anchor.href).toBe('blob:test');
    expect(anchor.download).toBe('report.html');
    expect(anchor.click).toHaveBeenCalled();
    expect(t.open).toHaveBeenCalledTimes(1);
  });

  it('opens external URLs without fetching them with credentials', async () => {
    const t = setup('text/plain');
    await t.context.openArtifact('https://example.com/report.md', true);
    expect(t.fetch).not.toHaveBeenCalled();
    expect(t.open).toHaveBeenCalledWith('https://example.com/report.md', '_blank', 'noopener');
  });

  it('reports a failed fetch without opening a reader', async () => {
    const t = setup('text/plain');
    t.fetch.mockImplementationOnce(async () => new Response('', { status: 404 }));
    await t.run();
    expect(t.show).not.toHaveBeenCalled();
    expect(t.context.toast).toHaveBeenCalledWith('could not open artifact', true);
  });
});
