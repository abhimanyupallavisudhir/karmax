import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const app = fs.readFileSync(path.resolve('web/app.js'), 'utf8');
const gateway = fs.readFileSync(path.resolve('src/gateway/server.ts'), 'utf8');
const manifests = fs.readFileSync(path.resolve('src/contrib/manifests.ts'), 'utf8');

describe('concise settings UI', () => {
  it('uses plain section names without the removed explanatory copy', () => {
    for (const removed of [
      'Workspaces you own or have been added to. Select one to switch to it.',
      'Where tasks run, how large each world is, and the monthly ceiling',
      "This organization's logins and API keys.",
      'Connect a Claude, Codex, or explicitly supported OpenCode subscription.',
      'Stored encrypted in the vault; the key is never shown again.',
      'Choose where tasks run, how large each world is, when idle worlds pause',
    ]) expect(app).not.toContain(removed);

    expect(app).toContain('>Where tasks run</a>');
    expect(app).toContain('>Codex/Claude</a>');
  });

  it('removes the legacy local-file setting from current workflow forms', () => {
    expect(manifests).not.toContain("label: 'Legacy local file copies'");
  });

  it('keeps Advanced controls hidden until a server-derived permission check allows them', () => {
    expect(app).toContain('data-settings-access');
    expect(app).toContain('/api/settings/access');
    expect(gateway).toContain("p === '/api/settings/access'");
  });

  it('does not announce connector success before verified status is returned', () => {
    expect(app).not.toContain("toast('Connected'); renderConnectors()");
    expect(app).toContain("toast(`${connection.label} connected`)");
  });
});
