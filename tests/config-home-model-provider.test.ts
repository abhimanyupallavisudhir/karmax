import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConfigHomeManager } from '../src/autonomy/config-homes.js';

describe('OpenCode login model-provider metadata', () => {
  it('persists the provider selected by the credential connection flow', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-opencode-login-'));
    try {
      const homes = new ConfigHomeManager(root);
      const home = homes.ensure('opencode', 'grok');
      homes.setModelProvider(home, 'xai');
      fs.mkdirSync(path.join(home, 'data', 'opencode'), { recursive: true });
      fs.writeFileSync(path.join(home, 'data', 'opencode', 'auth.json'), JSON.stringify({ xai: { type: 'oauth' } }));

      expect(homes.modelProvider(home)).toBe('xai');
      expect(homes.list()).toEqual([expect.objectContaining({
        provider: 'opencode',
        account: 'grok',
        loggedIn: true,
        modelProvider: 'xai',
      })]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('infers a single provider from historical OpenCode auth files', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-opencode-legacy-'));
    try {
      const homes = new ConfigHomeManager(root);
      const home = homes.ensure('opencode', 'legacy');
      fs.mkdirSync(path.join(home, 'data', 'opencode'), { recursive: true });
      fs.writeFileSync(path.join(home, 'data', 'opencode', 'auth.json'), JSON.stringify({ xai: { type: 'oauth' } }));
      expect(homes.modelProvider(home)).toBe('xai');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
