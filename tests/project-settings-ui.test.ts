import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const source = fs.readFileSync(path.resolve('web/app.js'), 'utf8');

function extractFunction(name: string): string {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} not found`);
  let depth = 0;
  for (let index = source.indexOf('{', start); index < source.length; index++) {
    if (source[index] === '{') depth++;
    else if (source[index] === '}' && --depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`unterminated ${name}`);
}

describe('Project settings browser source', () => {
  it('formats discovered and revision byte sizes without a missing global', () => {
    const formatBytes = Function(`${extractFunction('formatBytes')}; return formatBytes;`)() as (value: unknown) => string;
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1023)).toBe('1023 B');
    expect(formatBytes(1024)).toBe('1 KB');
    expect(formatBytes(5 * 1024 ** 3)).toBe('5 GB');
    expect(formatBytes(undefined)).toBe('—');
  });

  it('keeps code, secrets, data, services, and environment in one Project pane', () => {
    const settings = source.slice(source.indexOf('function settingsView('), source.indexOf('function cloudEnvironmentCard('));
    expect(settings).toContain('<a href="#project">Project</a>');
    expect(settings).not.toContain('<a href="#project-data">Data</a>');
    for (const id of ['project-git', 'project-secrets', 'project-data', 'project-services', 'project-environment'])
      expect(settings).toContain(`id="${id}"`);
    expect(settings).toContain('Agent-manageable by design');
  });

  it('explains data locations and the Data/Service/S3 boundary', () => {
    const data = source.slice(source.indexOf('async function hydrateProjectData('), source.indexOf('async function hydrateProjectServices('));
    const services = source.slice(source.indexOf('async function hydrateProjectServices('), source.indexOf('async function hydrateProjectEnvironment('));
    expect(data).toContain('Data or Service?');
    expect(data).toContain('Available to tasks at');
    expect(data).toContain('Import from this Karmax machine');
    expect(data).toContain('formatBytes(proposal.bytes)');
    expect(services).toContain('S3 bucket');
    expect(services).toContain('external service');
  });

  it('resets the actual scroll container when switching settings panes', () => {
    expect(source).toContain("$('#main')?.closest('.main')?.scrollTo?.(0, 0)");
  });
});
