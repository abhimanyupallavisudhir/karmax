import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assertLoopback, connect, listPages, openPage, pickPage, type CdpTarget } from '../src/autonomy/cdp.js';
import { fakeBrowser } from './helpers/fake-browser.js';

// The host-side CDP plumbing behind credential fill (§5B) and passkeys (§8).
// cdp-fill.mjs and the fill/passkey suites exercise it only through their
// callers; these pin its own guarantees (CI-38d).

afterEach(() => { vi.unstubAllEnvs(); });

async function closedPort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describe('assertLoopback', () => {
  it.each(['http://127.0.0.1:9222', 'http://localhost:9222', 'http://[::1]:9222'])('accepts %s', (url) => {
    expect(assertLoopback(url).origin).toBe(new URL(url).origin);
  });

  it.each([
    'https://127.0.0.1:9222', // DevTools is plain http; anything else is not the local browser
    'http://example.com:9222',
    'http://127.0.0.1.example.com:9222',
    'http://10.0.0.5:9222',
    'ws://127.0.0.1:9222',
  ])('refuses %s', (url) => {
    expect(() => assertLoopback(url)).toThrow(/loopback http endpoint/);
  });
});

describe('listPages', () => {
  it('lists only page targets that can be driven', async () => {
    const browser = await fakeBrowser([
      { url: 'https://github.com/login' },
      { url: 'chrome-extension://abc/background.html', type: 'service_worker' },
      { url: 'https://example.com/', noSocket: true },
      { url: 'https://example.org/' },
    ]);
    try {
      expect((await listPages(browser.url)).map((page) => page.url)).toEqual(['https://github.com/login', 'https://example.org/']);
    } finally {
      await browser.close();
    }
  });

  it('refuses a non-loopback endpoint before making any request', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    await expect(listPages('http://example.com:9222')).rejects.toThrow(/loopback/);
    expect(fetch).not.toHaveBeenCalled();
    fetch.mockRestore();
  });

  it('explains how to get a reachable browser when discovery fails', async () => {
    const browser = await fakeBrowser([], { listStatus: 500 });
    try {
      await expect(listPages(browser.url)).rejects.toThrow(/cannot reach Chrome DevTools at http:\/\/127\.0\.0\.1:\d+.*task's chrome-devtools browser.*HTTP 500/);
    } finally {
      await browser.close();
    }
    await expect(listPages(`http://127.0.0.1:${await closedPort()}`)).rejects.toThrow(/cannot reach Chrome DevTools/);
  });
});

describe('pickPage', () => {
  const pages: CdpTarget[] = [
    { type: 'page', url: 'not a url' },
    { type: 'page', url: 'https://evilgithub.com/login' },
    { type: 'page', url: 'https://gist.github.com/new' },
    { type: 'page', url: 'https://github.com/login' },
  ];

  it('takes the first page when no domain is expected', () => {
    expect(pickPage(pages)).toBe(pages[0]);
    expect(pickPage(pages, [])).toBe(pages[0]);
    expect(pickPage([])).toBeUndefined();
  });

  it('matches the domain or a subdomain, never a lookalike', () => {
    expect(pickPage(pages, ['github.com'])).toBe(pages[2]);
    expect(pickPage(pages, ['*.GitHub.com.'])).toBe(pages[2]);
    expect(pickPage(pages, ['hub.com'])).toBeUndefined();
    expect(pickPage(pages, ['example.com', 'evilgithub.com'])).toBe(pages[1]);
  });
});

describe('connect', () => {
  it.each(['ws://example.com:9222/devtools/page/1', 'ws://10.0.0.5/devtools', 'http://127.0.0.1:9222/devtools'])(
    'will not open a debugger socket to %s', async (url) => {
      await expect(connect(url)).rejects.toThrow(/loopback ws endpoint/);
    });

  it('answers calls in any order and surfaces CDP errors', async () => {
    const browser = await fakeBrowser([{ url: 'https://example.com/' }], { errors: { 'Page.navigate': 'Cannot navigate to invalid URL' } });
    const session = await connect(`ws://127.0.0.1:${browser.port}/devtools/page/0`);
    try {
      const [origin, navigate] = await Promise.allSettled([
        session.call('Runtime.evaluate', { expression: 'location.origin', returnByValue: true }),
        session.call('Page.navigate', { url: 'nope' }),
      ]);
      expect(origin).toEqual({ status: 'fulfilled', value: { result: { value: 'https://example.com' } } });
      expect(navigate).toMatchObject({ status: 'rejected', reason: new Error('CDP error: Cannot navigate to invalid URL') });
    } finally {
      await session.close();
      await browser.close();
    }
  });

  it('times out a call the browser never answers', async () => {
    const browser = await fakeBrowser([{ url: 'https://example.com/' }], { silent: ['Runtime.evaluate'] });
    const session = await connect(`ws://127.0.0.1:${browser.port}/devtools/page/0`, 200);
    try {
      await expect(session.call('Runtime.evaluate', { expression: '1' })).rejects.toThrow('CDP Runtime.evaluate timed out');
    } finally {
      await session.close();
      await browser.close();
    }
  });

  it('fails when nothing listens at the socket', async () => {
    await expect(connect(`ws://127.0.0.1:${await closedPort()}/devtools/page/0`)).rejects.toThrow('CDP connection failed');
  });
});

describe('openPage', () => {
  it('opens the page for the expected domain and reports its live origin', async () => {
    const browser = await fakeBrowser([{ url: 'https://example.com/' }, { url: 'https://accounts.github.com/login' }]);
    try {
      const { session, origin } = await openPage(browser.url, { expectDomains: ['github.com'] });
      expect(origin).toBe('https://accounts.github.com');
      expect(browser.calls).toEqual([{ page: 1, method: 'Runtime.evaluate', params: { expression: 'location.origin', returnByValue: true } }]);
      expect(browser.openSockets).toBe(1);
      await session.close();
    } finally {
      await browser.close();
    }
  });

  it('opens the first page when no domain is expected', async () => {
    const browser = await fakeBrowser([{ url: 'about:blank', origin: 'null' }, { url: 'https://example.com/' }]);
    try {
      const { session, origin } = await openPage(browser.url);
      expect(origin).toBe('null');
      await session.close();
    } finally {
      await browser.close();
    }
  });

  it('refuses, and hangs up, when the live origin differs from the listed url', async () => {
    const browser = await fakeBrowser([{ url: 'https://github.com/login', origin: 'https://evil.example' }]);
    try {
      await expect(openPage(browser.url, { expectDomains: ['github.com'] }))
        .rejects.toThrow('refusing: the page origin (https://evil.example) does not match the expected domains (github.com)');
      await vi.waitFor(() => expect(browser.closedSockets).toBe(1));
      expect(browser.openSockets).toBe(0);
    } finally {
      await browser.close();
    }
  });

  it('refuses a page whose live origin has no host', async () => {
    const browser = await fakeBrowser([{ url: 'https://github.com/login', origin: 'null' }]);
    try {
      await expect(openPage(browser.url, { expectDomains: ['github.com'] })).rejects.toThrow(/page origin \(null\) does not match/);
    } finally {
      await browser.close();
    }
  });

  it('says what to do when no page matches', async () => {
    const browser = await fakeBrowser([{ url: 'https://example.com/' }]);
    try {
      await expect(openPage(browser.url, { expectDomains: ['github.com', 'gitlab.com'] }))
        .rejects.toThrow('no open page matches github.com, gitlab.com — navigate to the login page first');
      expect(browser.calls).toEqual([]);
    } finally {
      await browser.close();
    }
    const empty = await fakeBrowser([]);
    try {
      await expect(openPage(empty.url)).rejects.toThrow('no open page at the CDP endpoint');
    } finally {
      await empty.close();
    }
  });
});

describe('default CDP endpoint', () => {
  // The port is read once, at import. It names the browser the MCP launcher
  // opens and, inside a task's world, the one fills reach; fills never take a
  // URL from the environment or the agent (AU-14/AU-32).
  beforeEach(() => { vi.resetModules(); });

  it('is the loopback port 9222 unless configured', async () => {
    vi.stubEnv('KARMAX_CDP_PORT', '');
    const defaults = await import('../src/autonomy/cdp-endpoint.js');
    const { WORLD_CDP_URL } = await import('../src/autonomy/task-browser.js');
    expect(defaults.DEFAULT_CDP_PORT).toBe(9222);
    expect(WORLD_CDP_URL).toBe('http://127.0.0.1:9222');
    expect(() => assertLoopback(WORLD_CDP_URL)).not.toThrow();
  });

  it('follows KARMAX_CDP_PORT', async () => {
    vi.stubEnv('KARMAX_CDP_PORT', '9333');
    const defaults = await import('../src/autonomy/cdp-endpoint.js');
    const { WORLD_CDP_URL } = await import('../src/autonomy/task-browser.js');
    expect(defaults.DEFAULT_CDP_PORT).toBe(9333);
    expect(WORLD_CDP_URL).toBe('http://127.0.0.1:9333');
  });

  it('ignores a KARMAX_CDP_PORT that is not a number', async () => {
    vi.stubEnv('KARMAX_CDP_PORT', 'chrome');
    const defaults = await import('../src/autonomy/cdp-endpoint.js');
    expect(defaults.DEFAULT_CDP_PORT).toBe(9222);
  });
});
