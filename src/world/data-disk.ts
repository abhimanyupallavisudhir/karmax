import type { DataDiskNeed } from '../domain/computer-limits.js';
import { credentialResource, snapshotResource } from '../domain/resource-drivers.js';
import type { ResourceAttachment } from '../domain/types.js';
import type { Store } from '../store/db.js';

/**
 * The disk a world needs for the project data its setup restores (wiki
 * features/resource-storage, *World setup*).
 *
 * Setup restores every resource's version in full before the agent starts
 * (resources.ts `materialize`). A computer whose disk cannot hold it fills up
 * mid-restore, and then nothing in the world can even record how it ended:
 * rw-data #8 (tavya-error 3b4ed193f5ec0941, 2026-11-20) restored 31.3 GB into
 * an E2B sandbox (22 GB of disk at most), each of three attempts filled the
 * disk after ~4 min, and the restore job, unable to write its exit record,
 * looked lost — "the sandbox was restarted" — until it went to a person.
 *
 * So the size of what is restored is known before any machine is made: "Any"
 * passes over an account whose disks can't hold it, a named provider that
 * can't is refused at once (`computer-unfit`), and the machine made is asked
 * for a disk that holds it (computer-limits.ts `diskHolding`).
 */

/** Restored data takes more than its bytes: every file rounds up to whole
 * blocks (168k files there), and restic writes beside what it replaces. */
const DATA_SLACK = 1.1;
/** Room beside the data: the checkouts, the agent's tools and its own work. */
const DATA_ROOM_GB = 5;

/** The disk (GB of 2^30 bytes) that holds `bytes` of data with room to work. */
export function dataDiskGb(bytes: number): number {
  return Math.ceil((bytes * DATA_SLACK) / 2 ** 30) + DATA_ROOM_GB;
}

/** A resource whose world gets its listing and fetches its parts itself
 * (`tavya-data`), rather than all of it at setup. */
export function onDemandResource(attachment: ResourceAttachment): boolean {
  return Boolean(attachment.onDemand) && snapshotResource(attachment.driver) && attachment.target.kind === 'path'
    && attachment.source.shape !== 'file';
}

/**
 * What a new world of `projectId` restores at setup, as `materialize` chooses
 * it: every data resource but on-demand ones, at the version `revisions` names
 * (a sub-task's parent's, a fork's, a checkpoint's), else its current one.
 * Undefined when it restores nothing.
 */
export async function setupDataNeed(store: Pick<Store, 'listResourceAttachments' | 'getResourceRevision'>, projectId: string,
  revisions: Record<string, string | undefined> = {}): Promise<DataDiskNeed | undefined> {
  let bytes = 0;
  for (const attachment of await store.listResourceAttachments(projectId)) {
    if (!snapshotResource(attachment) || credentialResource(attachment) || onDemandResource(attachment)) continue;
    const revisionId = Object.prototype.hasOwnProperty.call(revisions, attachment.id) ? revisions[attachment.id] : attachment.currentRevisionId;
    const revision = revisionId ? await store.getResourceRevision(revisionId) : undefined;
    bytes += Math.max(0, Number(revision?.bytes) || 0);
  }
  return bytes > 0 ? { bytes, diskGb: dataDiskGb(bytes) } : undefined;
}
