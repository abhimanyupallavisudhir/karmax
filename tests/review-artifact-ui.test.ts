import fs from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const app = fs.readFileSync('web/app.js', 'utf8');
const source = app.slice(app.indexOf('function artifactTextKind('), app.indexOf('// Approve ONE branch'));
const wire = app.slice(app.indexOf('function wireReviewActions('), app.indexOf('const resourceReviewCache'));
const button = app.slice(app.indexOf('function reviewActionBtn('), app.indexOf('function promptText('));

describe('review artifact viewer', () => {
  const signed = (name: string) => `/api/artifact-content/token/${name}`;
  function setup() {
    const show = vi.fn(() => ({}));
    const open = vi.fn();
    const fetch = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => new Response('content', { headers: { 'content-type': 'application/octet-stream' } }));
    const anchor = { click: vi.fn(), remove: vi.fn() } as Record<string, any>;
    const context = vm.createContext({
      S: { token: 'test-token' }, feedbackFetch: fetch, fetch, window: { open }, Response,
      document: { createElement: () => anchor, body: { appendChild: vi.fn() } },
      setTimeout: vi.fn(), toast: vi.fn(), esc: (value: string) => value,
    });
    vm.runInContext(source, context);
    context.showArtifactViewer = show;
    return { context, show, open, fetch, anchor };
  }

  // The 2026-10-18 bug: a 91.5 MB video was fetched whole after the click's
  // `await`, then `window.open` ran long after the browser's popup allowance,
  // and was blocked without a word.
  it.each([
    ['video/mp4', 'explainer.mp4', 'video'],
    ['image/png', 'still.png', 'image'],
    ['audio/mpeg', 'voice.mp3', 'audio'],
    ['application/pdf', 'paper.pdf', 'pdf'],
    ['text/html; charset=utf-8', 'report.html', 'page'],
    ['image/svg+xml', 'chart.svg', 'image'],
  ])('shows %s in the page from its signed URL, with no popup and no fetch', async (mediaType, name, view) => {
    const t = setup();
    const refresh = vi.fn();
    await t.context.openArtifact({ url: signed(name), name, mediaType, bytes: 91_503_508 }, refresh);
    expect(t.show).toHaveBeenCalledWith({ name, url: signed(name), view, refresh });
    expect(t.open).not.toHaveBeenCalled();
    expect(t.fetch).not.toHaveBeenCalled();
  });

  it('opens from a click without window.open, even when resolving the action is slow', async () => {
    const t = setup();
    let click!: () => Promise<void>;
    const btn = { disabled: false, isConnected: true, textContent: 'Watch the video',
      getAttribute: (attr: string) => ({ 'data-idx': '0', 'data-kind': 'open' })[attr],
      addEventListener: (_type: string, handler: () => Promise<void>) => { click = handler; } };
    const resolved = { kind: 'open', external: false, url: signed('explainer.mp4'), name: 'explainer.mp4', mediaType: 'video/mp4', bytes: 91_503_508 };
    const api = vi.fn(async () => { await new Promise((resolve) => setImmediate(resolve)); return resolved; });
    Object.assign(t.context, { api, document: { getElementById: (id: string) => ({ 'review-actions': { querySelectorAll: () => [btn] } })[id] ?? null } });
    vm.runInContext(wire, t.context);
    t.context.wireReviewActions({ taskId: 'task-1', reviewInfo: { actions: [{ kind: 'open', target: 'out/explainer.mp4' }] } });
    await click();
    expect(api).toHaveBeenCalledWith('/api/tasks/task-1/review-action', { method: 'POST', body: JSON.stringify({ index: 0 }) });
    expect(t.show).toHaveBeenCalledWith(expect.objectContaining({ url: resolved.url, view: 'video' }));
    expect(t.open).not.toHaveBeenCalled();
    // The viewer can ask for a fresh URL when the first one expires mid-viewing.
    await (t.show.mock.calls[0] as any)[0].refresh();
    expect(api).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['application/octet-stream', 'report.md', 'markdown'],
    ['text/plain; charset=utf-8', 'REPORT.MD', 'markdown'],
    ['text/plain; charset=utf-8', 'notes.txt', 'text'],
    ['text/csv; charset=utf-8', 'data.csv', 'text'],
    ['application/json; charset=utf-8', 'data.json', 'text'],
  ])('reads %s (%s) in the page, fetched without credentials', async (mediaType, name, view) => {
    const t = setup();
    await t.context.openArtifact({ url: signed(name), name, mediaType });
    expect(t.fetch).toHaveBeenCalledWith(signed(name));
    expect(t.show).toHaveBeenCalledWith({ name, url: signed(name), view, text: 'content' });
    expect(t.open).not.toHaveBeenCalled();
  });

  it('downloads other types natively from the signed URL after checking it', async () => {
    const t = setup();
    await t.context.openArtifact({ url: signed('data.bin'), name: 'data.bin', mediaType: 'application/octet-stream' });
    expect(t.fetch).toHaveBeenCalledWith(signed('data.bin'), { method: 'HEAD' });
    expect(t.anchor.href).toBe(signed('data.bin'));
    expect(t.anchor.download).toBe('data.bin');
    expect(t.anchor.click).toHaveBeenCalled();
    expect(t.show).not.toHaveBeenCalled();
  });

  it('downloads text too large to lay out instead of reading it', async () => {
    const t = setup();
    await t.context.openArtifact({ url: signed('huge.csv'), name: 'huge.csv', mediaType: 'text/csv', bytes: 50 * 1024 * 1024 });
    expect(t.fetch).toHaveBeenCalledWith(signed('huge.csv'), { method: 'HEAD' });
    expect(t.anchor.click).toHaveBeenCalled();
    expect(t.show).not.toHaveBeenCalled();
  });

  it('says when a file cannot be opened or downloaded, never failing silently', async () => {
    const t = setup();
    t.fetch.mockImplementation(async () => new Response('', { status: 403 }));
    await expect(t.context.openArtifact({ url: signed('data.bin'), name: 'data.bin', mediaType: 'application/octet-stream' }))
      .rejects.toThrow('Could not download data.bin');
    await expect(t.context.openArtifact({ url: signed('notes.md'), name: 'notes.md', mediaType: 'application/octet-stream' }))
      .rejects.toThrow('Could not open notes.md');
    expect(t.anchor.click).not.toHaveBeenCalled();
    expect(t.show).not.toHaveBeenCalled();
  });

  it('renders a web page target as a plain link, so the click itself opens it', () => {
    const context = vm.createContext({ esc: (value: string) => value });
    vm.runInContext(button + source, context);
    const html = context.reviewActionBtn({ kind: 'open', label: 'Docs', target: 'https://example.com/report' }, 0);
    expect(html).toMatch(/^<a class="btn sm" href="https:\/\/example\.com\/report" target="_blank" rel="noopener"/);
    expect(context.reviewActionBtn({ kind: 'open', label: 'Video', target: 'out/a.mp4' }, 1)).toContain('<button');
  });

  it.each([false, true])('consumes reader Escape before full screen or the task (full screen: %s)', (fullscreen) => {
    const listeners: Record<string, (event: any) => void> = {};
    const control = { classList: { add: vi.fn() }, addEventListener: vi.fn(), focus: vi.fn() };
    const links = [] as unknown[];
    const dialog = {
      setAttribute: vi.fn(), querySelector: () => control, querySelectorAll: () => links,
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
      document: { activeElement: null, createElement: () => dialog, querySelector: () => null,
        body: { appendChild: vi.fn() },
        addEventListener: (_name: string, handler: (event: any) => void) => { shellKeydown = handler; } },
      URL: { createObjectURL: () => 'blob:test' }, esc: (s: string) => s,
      renderMarkdown: () => '', texToggleHtml: () => '', mountMarkdownSurface: vi.fn(), wireTexToggles: vi.fn(), closeTask, S: state,
      $: select, resetChord: vi.fn(), inRail: () => false,
      focusedEnterAction: () => null,
    });
    vm.runInContext(source + '\n' + app.slice(app.indexOf('function closeTopOverlay()'),
      app.indexOf('// -- the dispatcher')) + '\n' + app.slice(app.indexOf('function bindKeys()'),
      app.indexOf('// -- the ⌘K palette')), context);
    for (const name of ['setConversationFullscreen', 'takesTypedKeys']) {
      const start = app.indexOf(`function ${name}(`);
      vm.runInContext(app.slice(start, app.indexOf('\n}', start) + 2), context);
    }
    context.showArtifactViewer({ name: 'report.md', url: '/api/artifact-content/t/report.md', view: 'markdown', text: 'report' });
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

});
