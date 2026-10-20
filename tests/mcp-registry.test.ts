import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RegistryIndex, registryEntry, registryServer } from '../src/mcp/connections/registry.js';

describe('Untrusted Official Registry records', () => {
  it.each([null, false, 'text', { remotes: {} }, { remotes: [null] }, { packages: {} }, { packages: [null] }, { packages: [{ registryType: 'npm', identifier: 'tool', version: '1.2.3', transport: { type: 'stdio' }, environmentVariables: {} }] }])('handles malformed metadata without crashing discovery: %j', (record) => {
    expect(() => registryEntry(record)).not.toThrow();
  });
  it.each(['latest', 'beta', '*', '^1.0.0', '1.0.0 || 2.0.0', 'https://evil.example/package.tgz', '1.0.0;touch /tmp/x'])('never imports mutable or injected npm version %s', (version) => {
    expect(registryEntry({ packages: [{ registryType: 'npm', identifier: 'tool', version, transport: { type: 'stdio' } }] }).options).toEqual([]);
  });
  it('imports a pinned Python command but refuses package-manager flags as its executable', () => {
    const pkg = { registryType: 'pypi', identifier: 'example_tool', version: '1.2.3', transport: { type: 'stdio' } };
    expect(registryEntry({ packages: [pkg] }).options[0]?.transport).toEqual({ type: 'stdio', command: 'uvx', args: ['--index-url', 'https://pypi.org/simple', '--from', 'example_tool==1.2.3', 'example_tool'] });
    expect(registryEntry({ packages: [{ ...pkg, runtimeHint: '--python=attacker' }] }).options).toEqual([]);
  });
  it('does not import private, non-HTTPS, or unresolved templated endpoints', () => {
    for (const url of ['http://public.example/mcp', 'https://169.254.169.254/metadata', 'https://[::1]/', 'https://{tenant}.example/mcp', 'https://tools.example/{tenant}'])
      expect(registryEntry({ remotes: [{ type: 'streamable-http', url }] }).options).toEqual([]);
  });
});

const OFFICIAL = 'io.modelcontextprotocol.registry/official';
const record = (name: string, extra: Record<string, unknown> = {}, status = 'active') => ({
  server: { name, version: '1.0.0', remotes: [{ type: 'streamable-http', url: `https://${name.replace(/[^a-z0-9]+/g, '-')}.example/mcp` }], ...extra },
  _meta: { [OFFICIAL]: { status, isLatest: true } },
});
/** A stand-in for the Official Registry: plain pages, `updated_since` deltas,
 * exact lookups and its own (slow, name-only) search, each request recorded. */
function fakeRegistry(servers: any[], pageSize = 2) {
  const calls: URL[] = [];
  let delta: any[] = [];
  const fetch = async (href: string) => {
    const url = new URL(href); calls.push(url);
    const exact = url.pathname.match(/^\/v0\.1\/servers\/([^/]+)\/versions\/latest$/);
    if (exact) {
      const found = servers.find((s) => s.server.name === decodeURIComponent(exact[1]!));
      return found ? Response.json(found) : Response.json({ title: 'Not Found', status: 404 }, { status: 404 });
    }
    const search = url.searchParams.get('search');
    const pool = search !== null ? servers.filter((s) => s.server.name.includes(search)) : url.searchParams.get('updated_since') ? delta : servers;
    const start = Number(url.searchParams.get('cursor') ?? 0);
    const page = pool.slice(start, start + pageSize);
    return Response.json({ servers: page, metadata: { count: page.length, ...(start + pageSize < pool.length ? { nextCursor: String(start + pageSize) } : {}) } });
  };
  return { fetch, calls, setDelta: (d: any[]) => { delta = d; } };
}

describe('Official Registry index', () => {
  const servers = [
    record('com.googleapis.run/mcp', { title: 'Google Cloud Run', description: 'Deploy applications to Cloud Run' }),
    record('com.googleapis.sqladmin/mcp', { description: 'Create, manage, and query your Google Cloud SQL resources.' }),
    record('ai.example/google-ads', { description: 'Manage ad campaigns' }),
    record('com.mintmcp/gmail', { description: 'A MCP server for Gmail' }),
    record('ai.thirdparty/console', { title: 'Search Console for Google', description: 'Hosted, no Google Cloud project needed' }),
    record('io.github.someone/gcloud-old', { description: 'Google Cloud helper' }, 'deprecated'),
    record('io.github.local/google-cloud-cli', { description: 'Run gcloud locally', remotes: undefined, packages: [{ registryType: 'npm', identifier: 'gcloud-cli', version: '1.0.0', transport: { type: 'stdio' } }] }),
  ];
  const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-registry-')), 'registry.json.gz');

  it('finds servers by every word of their name, title or description, the vendor\'s own first, without the registry\'s own search', async () => {
    const registry = fakeRegistry(servers);
    const index = new RegistryIndex({ fetch: registry.fetch, file: tmp() });
    await index.refresh();
    const result = await index.search('google cloud');
    expect(result.servers.map((s: any) => s.name)).toEqual(['com.googleapis.run/mcp', 'com.googleapis.sqladmin/mcp', 'io.github.local/google-cloud-cli', 'ai.thirdparty/console']);
    expect(registry.calls.some((u) => u.searchParams.has('search'))).toBe(false);
    expect((await index.search('GMAIL')).servers.map((s: any) => s.name)).toEqual(['com.mintmcp/gmail']);
    expect((await index.search('gcloud-old')).servers).toEqual([]); // deprecated
    const handles = new RegistryIndex({ fetch: fakeRegistry([record('io.github.github30/notes', { description: 'Posts notes to GitHub' }),
      record('io.github.github/github-mcp-server', { title: 'GitHub' }), record('io.github.acme/github', { title: 'GitHub' })]).fetch, file: tmp() });
    await handles.refresh(); // a GitHub handle that merely starts with a word is nobody's brand
    expect((await handles.search('github')).servers.map((s: any) => s.name)).toEqual(['io.github.github/github-mcp-server', 'io.github.acme/github', 'io.github.github30/notes']);
    expect((await index.search('com.mintmcp/gmail')).servers[0]).toMatchObject({ name: 'com.mintmcp/gmail', options: [{ transport: { type: 'http', url: 'https://com-mintmcp-gmail.example/mcp' } }] });
  });

  it('pages results with a cursor', async () => {
    const many = Array.from({ length: 45 }, (_, i) => record(`com.example/tool-${String(i).padStart(2, '0')}`));
    const index = new RegistryIndex({ fetch: fakeRegistry(many, 100).fetch, file: tmp() });
    await index.refresh();
    const first = await index.search('tool');
    expect(first.servers).toHaveLength(20); expect(first.nextCursor).toBeTruthy();
    const second = await index.search('tool', first.nextCursor);
    const third = await index.search('tool', second.nextCursor);
    expect(third.nextCursor).toBeUndefined();
    expect(new Set([...first.servers, ...second.servers, ...third.servers].map((s: any) => s.name)).size).toBe(45);
  });

  it('keeps up with deltas: new servers appear and deprecated ones disappear', async () => {
    let now = 1_000_000_000_000;
    const registry = fakeRegistry(servers);
    const index = new RegistryIndex({ fetch: registry.fetch, file: tmp(), now: () => now });
    await index.refresh();
    registry.setDelta([record('com.example/brand-new', { description: 'Fresh' }), record('com.mintmcp/gmail', {}, 'deprecated')]);
    now += 60 * 60_000; registry.calls.length = 0;
    await index.refresh();
    expect(registry.calls).toHaveLength(1);
    expect(registry.calls[0]!.searchParams.get('updated_since')).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect((await index.search('brand')).servers.map((s: any) => s.name)).toEqual(['com.example/brand-new']);
    expect((await index.search('gmail')).servers).toEqual([]);
  });

  it('reloads its snapshot after a restart instead of reading the whole registry again', async () => {
    const file = tmp(), registry = fakeRegistry(servers);
    await new RegistryIndex({ fetch: registry.fetch, file }).refresh();
    registry.calls.length = 0;
    const restarted = new RegistryIndex({ fetch: registry.fetch, file });
    expect((await restarted.search('google cloud')).servers).toHaveLength(4);
    await restarted.idle();
    expect(registry.calls.every((u) => u.searchParams.has('updated_since'))).toBe(true);
  });

  it('answers through the registry\'s own search until its first read finishes', async () => {
    const registry = fakeRegistry(servers);
    let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
    const slow = async (href: string) => { if (!new URL(href).searchParams.has('search')) await gate; return registry.fetch(href); };
    const index = new RegistryIndex({ fetch: slow, file: tmp() });
    expect((await index.search('gmail')).servers.map((s: any) => s.name)).toEqual(['com.mintmcp/gmail']);
    release(); await index.idle();
    expect((await index.search('google cloud')).servers).toHaveLength(4);
  });

  it('resolves an exact name with one lookup, and only active servers', async () => {
    const registry = fakeRegistry(servers);
    expect(await registryServer('com.mintmcp/gmail', registry.fetch)).toMatchObject({ name: 'com.mintmcp/gmail', version: '1.0.0' });
    expect(registry.calls).toHaveLength(1);
    expect(await registryServer('com.nope/nothing', registry.fetch)).toBeUndefined();
    expect(await registryServer('io.github.someone/gcloud-old', registry.fetch)).toBeUndefined();
    await expect(registryServer('not a name', registry.fetch)).rejects.toThrow(/MCP Registry name/);
  });
});
