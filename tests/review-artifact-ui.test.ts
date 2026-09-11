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

  it('keeps binary and HTML artifacts on the existing open path', async () => {
    for (const type of ['application/pdf', 'image/png', 'text/html']) {
      const t = setup(type, 'content', 'report');
      await t.run();
      expect(t.show).not.toHaveBeenCalled();
      expect(t.open).toHaveBeenCalledWith('blob:test', '_blank', 'noopener');
    }
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
