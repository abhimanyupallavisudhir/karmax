import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { importWithPanagent, publicConversationShare } from '../src/agent/panagent.js';
import * as network from '../src/mcp/connections/http.js';

beforeEach(() => { vi.spyOn(network, 'publicFetch').mockRejectedValue(new Error('Unexpected share request')); });
afterEach(() => vi.restoreAllMocks());

const importShare = (url: string) => importWithPanagent({ source: { url }, provider: 'claude',
  forkHome: '/unused', worldPath: '/work', mode: 'context', native: false });

describe('Karmax conversation share acquisition', () => {
  it.each(['https://user:pass@chatgpt.com/share/abc', 'https://claude.ai:8443/share/abc',
    'https://claude.ai/share/abc#secret', 'file:///etc/passwd', 'https://127.0.0.1/share/abc'])('rejects %s at validation and acquisition', async url => {
    expect(publicConversationShare(url)).toBeUndefined();
    await expect(importShare(url)).rejects.toThrow(/public HTTPS.*share/);
    expect(network.publicFetch).not.toHaveBeenCalled();
  });
  it('stops at the guarded fetch when DNS or redirect validation fails', async () => {
    vi.mocked(network.publicFetch).mockRejectedValue(new Error('Endpoint redirects are not allowed'));
    await expect(importShare('https://chatgpt.com/share/abc')).rejects.toThrow(/redirects/);
    expect(network.publicFetch).toHaveBeenCalledOnce();
  });
  it.each(['chatgpt.com', 'claude.ai'])('converts guarded %s HTML locally into context and native history', async host => {
    vi.mocked(network.publicFetch).mockImplementation(async () => new Response('<html><div data-message-author-role="user">Guarded share message</div></html>'));
    const result = await importShare(`https://${host}/share/abc`);
    expect(result.kind).toBe('context');
    expect(result.warnings?.some(warning => warning.code === 'dom_fallback')).toBe(true);
    if (result.kind === 'context') expect(result.message.text).toContain('Guarded share message');
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'share-home-'));
    try {
      const native = await importWithPanagent({ source: { url: `https://${host}/share/abc` }, provider: 'claude',
        forkHome: home, worldPath: '/work', mode: 'context', native: true });
      expect(native.kind).toBe('native');
      expect(native.warnings?.some(warning => warning.code === 'dom_fallback')).toBe(true);
      expect(network.publicFetch).toHaveBeenCalledTimes(2);
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });
});
