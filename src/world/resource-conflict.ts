/** Files a task changed that a newer published version also changed, differently. */
export class ResourceConflictError extends Error {
  constructor(readonly resource: string, readonly paths: string[], source = 'a newer published version') {
    super(`${resource}: ${paths.length === 1 ? 'a file was' : `${paths.length} files were`} changed both by this task and in ${source}`
      + ` (${paths.slice(0, 5).join(', ')}${paths.length > 5 ? ', …' : ''}). Keep one version: rename or remove this task's copy.`);
    this.name = 'ResourceConflictError';
  }
}

/** A save that found files still changing after every retry. `paths` are
 * those that changed between its saves (resource-relative, at most a few
 * dozen), `total` how many did in all. */
export class ResourceKeptChangingError extends Error {
  constructor(readonly resource: string, readonly paths: string[], readonly total = paths.length) {
    super(keptChangingMessage(resource, paths, total));
    this.name = 'ResourceKeptChangingError';
  }
}

const SHOWN = 5;
const SQLITE_SIDE_FILE = /-(wal|shm|journal)$/;

function keptChangingMessage(resource: string, paths: string[], total: number): string {
  const head = `${resource} kept changing while it was being saved`;
  const listed = total ? `: ${total === 1 ? '1 file' : `${total} files`} changed between saves (${paths.slice(0, SHOWN).join(', ')}${total > SHOWN ? ', …' : ''})` : '';
  // An open SQLite database rewrites its side files on every transaction;
  // saving them without the database (or the database without them) would
  // keep a copy that is stale or cannot be opened.
  const culprit = paths.some((file) => SQLITE_SIDE_FILE.test(file))
    ? 'A SQLite database in it is held open (its -wal/-shm/-journal files keep changing): stop the program using it, or close the database, then try again.'
    : 'Something is still writing into it, usually a server or job: stop it, then try again.';
  return `${head}${listed}. ${culprit}`;
}
