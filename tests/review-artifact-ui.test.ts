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

  it('consumes reader Escape before the shell can close the selected task', () => {
    const listeners: Record<string, (event: any) => void> = {};
    const control = { classList: { add: vi.fn() }, addEventListener: vi.fn(), focus: vi.fn() };
    const dialog = {
      setAttribute: vi.fn(), querySelector: () => control,
      addEventListener: (name: string, handler: (event: any) => void) => { listeners[name] = handler; },
      showModal: vi.fn(), close: vi.fn(),
    };
    const closeTask = vi.fn();
    let shellKeydown: (event: any) => void;
    const context = vm.createContext({
      document: { activeElement: null, createElement: () => dialog,
        body: { appendChild: vi.fn() },
        addEventListener: (_name: string, handler: (event: any) => void) => { shellKeydown = handler; } },
      URL: { createObjectURL: () => 'blob:test' }, esc: (s: string) => s,
      renderMarkdown: () => '', closeTask, S: { selected: 'task-1' },
      $: () => ({ childElementCount: 0 }), resetChord: vi.fn(), inRail: () => false,
      focusedEnterAction: () => null,
    });
    vm.runInContext(source + '\n' + app.slice(app.indexOf('function closeTopOverlay()'),
      app.indexOf('// -- the dispatcher')) + '\n' + app.slice(app.indexOf('function bindKeys()'),
      app.indexOf('// -- global search:')), context);
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
    // The next Escape, after the reader is gone, still closes the task normally.
    shellKeydown!({ key: 'Escape', defaultPrevented: false });
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

  it('renders HTML artifacts inside a sandboxed frame, never as a bare same-origin blob', async () => {
    // A `blob:` URL carries the console's origin; an agent-authored page opened
    // bare would run with the console session. The frame has no allow-same-origin.
    const frame: Record<string, unknown> = { style: {}, setAttribute: vi.fn() };
    const popup = { document: { title: '', createElement: () => frame, body: { style: {}, appendChild: vi.fn() } } };
    const t = setup('text/html', '<script>alert(1)</script>', 'report.html');
    t.open.mockReturnValueOnce(popup);
    await t.run();
    expect(t.show).not.toHaveBeenCalled();
    expect(t.open).toHaveBeenCalledWith('', '_blank', 'noopener=no');
    expect(t.open).not.toHaveBeenCalledWith('blob:test', '_blank', 'noopener');
    expect(frame.setAttribute).toHaveBeenCalledWith('sandbox', expect.not.stringContaining('allow-same-origin'));
    expect(frame.src).toBe('blob:test');
    expect(popup.document.body.appendChild).toHaveBeenCalledWith(frame);
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
