/** Files a task changed that a newer published version also changed, differently. */
export class ResourceConflictError extends Error {
  constructor(readonly resource: string, readonly paths: string[], source = 'a newer published version') {
    super(`${resource}: ${paths.length === 1 ? 'a file was' : `${paths.length} files were`} changed both by this task and in ${source}`
      + ` (${paths.slice(0, 5).join(', ')}${paths.length > 5 ? ', …' : ''}). Keep one version: rename or remove this task's copy.`);
    this.name = 'ResourceConflictError';
  }
}
