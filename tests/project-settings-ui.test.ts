import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const source = fs.readFileSync(path.resolve('web/app.js'), 'utf8');
const styles = fs.readFileSync(path.resolve('web/styles.css'), 'utf8');

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
  it('uses the same name-first heading hierarchy for project and organization settings', () => {
    const project = source.slice(source.indexOf('function settingsView('), source.indexOf('function cloudEnvironmentCard('));
    const organization = source.slice(source.indexOf('function organizationView('), source.indexOf('function pendingInvitationRow('));

    expect(project).toContain('<h1 class="page-title">${esc(proj.name)}</h1><p class="settings-intro">Project settings</p>');
    expect(organization).toContain('<h1 class="page-title">${esc(org?.name || \'Organization\')}</h1>');
    expect(organization).toContain('<p class="settings-intro">Organization settings</p>');
  });

  it('places permission-gated rename controls in Advanced settings', () => {
    const project = source.slice(source.indexOf('function settingsView('), source.indexOf('function cloudEnvironmentCard('));
    const organization = source.slice(source.indexOf('function organizationView('), source.indexOf('function pendingInvitationRow('));
    const projectWiring = extractFunction('wireSettingsView');
    const organizationWiring = extractFunction('hydrateOrganizationView');

    expect(project).toContain('id="project-name"');
    expect(project).toContain('value="${esc(projectPath(proj))}"');
    expect(project).not.toContain('id="project-folder"');
    expect(project).toContain('id="rename-project"');
    expect(project).toContain('data-settings-access="projectDelete"');
    expect(project).toContain('data-settings-access="projectTransfer"');
    expect(project.indexOf('id="move-project"')).toBeGreaterThan(project.indexOf('id="project-advanced"'));
    expect(project.indexOf('id="move-project"')).toBeLessThan(project.indexOf('id="project-experimental"'));
    expect(organization).toContain('id="organization-name"');
    expect(organization).toContain('id="rename-organization"');
    expect(projectWiring).toContain("method: 'PATCH'");
    expect(projectWiring).toContain('JSON.stringify({ name })');
    expect(projectWiring).not.toContain('JSON.stringify({ name, folder })');
    expect(organizationWiring).toContain("method: 'PATCH'");
  });

  it('creates projects in a native escapable path dialog', () => {
    const dialog = extractFunction('newProject');
    expect(dialog).toContain('class="modal-card new-project-dialog"');
    expect(dialog).toContain('role="dialog" aria-modal="true"');
    expect(dialog).toContain('placeholder="e.g. Work/Clients/Website"');
    expect(dialog).toContain("if (event.key === 'Escape') close()");
    expect(dialog).toContain("if (event.target === event.currentTarget) close()");
    expect(dialog).toContain("$('#modal-root').appendChild(host)");
    expect(dialog).not.toContain("prompt('Project name')");
  });

  it('edits project paths and folder names inline from the sidebar', () => {
    const rows = extractFunction('railProjectRows');
    const projectEdit = extractFunction('editRailProject');
    const folderEdit = extractFunction('editRailFolder');
    const inlineEdit = extractFunction('beginRailInlineEdit');

    expect(rows).toContain('data-project-edit=');
    expect(rows).toContain('data-folder-edit=');
    expect(projectEdit).toContain('value: projectPath(project)');
    expect(projectEdit).toContain("method: 'PATCH'");
    expect(projectEdit).toContain('JSON.stringify({ name })');
    expect(folderEdit).toContain('/folder`');
    expect(folderEdit).toContain('JSON.stringify({ folder, name })');
    expect(inlineEdit).toContain("event.key !== 'Escape'");
    expect(inlineEdit).toContain('class="rail-edit-confirm"');
    expect(inlineEdit).toContain('class="rail-edit-cancel"');
    expect(styles).toContain('.rail .rail-edit-action { margin: -3px -4px -3px auto; opacity: 0;');
    expect(styles).toContain('.rail .proj:hover .rail-edit-action');
  });

  it('keeps the post-delete fallback inside the deleted project’s organization', () => {
    const projectWiring = extractFunction('wireSettingsView');

    expect(projectWiring).toContain('firstProjectForOrganization(deletedOrganizationId)');
    expect(projectWiring).toContain("globalRoute('insights', organizationById(deletedOrganizationId))");
    expect(projectWiring).not.toContain('const next = S.projects[0]');
  });

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
    expect(settings).not.toContain('Agent-manageable by design');
  });

  it('keeps organization repository and storage controls in one Projects pane', () => {
    const organization = source.slice(source.indexOf('function organizationView('), source.indexOf('function pendingInvitationRow('));
    expect(organization).toContain('<a href="#settings-code">Projects</a>');
    expect(organization).not.toContain('<a href="#settings-storage">Data storage</a>');
    expect(organization).toContain('id="settings-code"><div>Projects');
    expect(organization).toContain('<div class="section-h">Git &amp; GitHub</div>');
    expect(organization).toContain('<div class="section-h" id="settings-storage">Data storage</div>');
  });

  it('explains data locations and the Data/Service/S3 boundary', () => {
    const data = source.slice(source.indexOf('async function hydrateProjectData('), source.indexOf('async function hydrateProjectServices('));
    const services = source.slice(source.indexOf('async function hydrateProjectServices('), source.indexOf('async function hydrateProjectEnvironment('));
    expect(data).toContain('Data or Service?');
    expect(data).toContain('Storage field only decides where those encrypted revisions live');
    expect(data).toContain('Mount at path <small>(repo-relative)</small>');
    expect(data).toContain('Import from local path');
    expect(data).toContain('formatBytes(proposal.bytes)');
    expect(services).toContain('S3 bucket');
    expect(services).toContain('external service');
  });

  it('keeps forms concise and offers optional base-image suggestions', () => {
    for (const removed of [
      'The repositories this project works on, and the identity it commits with.',
      'Sensitive values injected only when a task needs them. Values are never shown again.',
      'No versioned data yet.',
      'A human-readable name in Project settings.',
      'The destination path inside every task world',
      'Expensive installation commands baked into a reusable build',
      'No build yet.',
    ]) expect(source).not.toContain(removed);
    expect(source).toContain('Local repo, GitHub, or Git URL');
    expect(source).toContain('Base image <small>(optional)</small>');
    expect(source).toContain('list="environment-image-options"');
    expect(source).toContain('python:3.13-slim');
    expect(source).toContain('uv sync');
    expect(source).toContain('uv run python manage.py migrate');
  });

  it('opens GitHub repository creation from a button beside Save repositories', () => {
    const access = source.slice(source.indexOf('async function hydrateProjectAccess('), source.indexOf('async function hydrateWorkflowPins('));
    const dialog = source.slice(source.indexOf('function openNewGithubRepositoryDialog('), source.indexOf('async function hydrateProjectAccess('));
    const save = access.indexOf('>Save repositories</button>');
    const open = access.indexOf('>New repository...</button>');

    expect(save).toBeGreaterThan(-1);
    expect(open).toBeGreaterThan(save);
    expect(access.slice(save, open)).not.toContain('</div>');
    expect(access).not.toContain('<details class="settings-disclosure compact"><summary><b>Create a new GitHub repository</b>');
    expect(access).toContain("openNewGithubRepositoryDialog(proj, gitConnections, event.currentTarget)");
    for (const label of ['GitHub account', 'Repository name', 'Description', 'Private repository']) expect(dialog).toContain(label);
    expect(dialog).toContain('role="dialog" aria-modal="true"');
    expect(dialog).toContain("if (event.key === 'Escape') close()");
    expect(dialog).toContain("opener?.focus?.()");
  });

  it('resets the actual scroll container when switching settings panes', () => {
    expect(source).toContain("$('#main')?.closest('.main')?.scrollTo?.(0, 0)");
  });
});
