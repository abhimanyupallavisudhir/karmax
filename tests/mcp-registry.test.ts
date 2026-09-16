import { describe, expect, it } from 'vitest';
import { registryEntry } from '../src/mcp/connections/registry.js';

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
