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

const esc = (value: unknown) => String(value);
const markup = Function('esc', `${extractFunction('organizationPlanMarkup')}; return organizationPlanMarkup;`)(esc);

describe('hosted plan organization UI', () => {
  it('shows plan limits and explains shared queued concurrency', () => {
    const free = markup({
      deployment: 'hosted', planName: 'Free', currentMonthlyPriceCents: 0,
      maxMembers: 1, unlimitedProjects: true, maxActiveAgentRuns: 1,
      activeAgentRuns: 1, queuedAgentRuns: 2,
    });
    expect(free).toContain('Free');
    expect(free).toContain('$0/month');
    expect(free).toContain('1 user');
    expect(free).toContain('Unlimited projects');
    expect(free).toContain('1 active agent run');
    expect(free).toContain('1 active · 2 queued');
    expect(free).toContain('shared maximum');
    expect(free).toContain('waits in queue');
  });

  it('renders Team per-active-user pricing returned by the server', () => {
    const team = markup({
      deployment: 'hosted', planName: 'Team', currentMonthlyPriceCents: 2_900,
      maxMembers: null, unlimitedProjects: true, maxActiveAgentRuns: 10,
      activeAgentRuns: 3, queuedAgentRuns: 0,
    });
    expect(team).toContain('Team');
    expect(team).toContain('$29/month');
    expect(team).toContain('Unlimited users');
    expect(team).toContain('10 active agent runs');
  });

  it('makes private-install behavior explicit instead of showing hosted limits', () => {
    const privateInstall = markup({ deployment: 'private' });
    expect(privateInstall).toContain('Private installation');
    expect(privateInstall).toContain('Hosted plan restrictions are not applied');
  });

  it('loads the server entitlement view from Organization settings', () => {
    const organization = extractFunction('organizationView');
    const hydration = extractFunction('hydrateOrganizationView');
    expect(organization).toContain('href="#settings-plan"');
    expect(organization).toContain('id="org-plan"');
    expect(hydration).toContain('/entitlements');
    expect(hydration).toContain('organizationPlanMarkup(entitlements)');
  });
});
