import { WORKFLOW_TYPE, pinnedType } from '../workflows/names.js';
import { manifest as manifestFor, WorkflowManifest } from '../contrib/manifests.js';

/** How to start a task for a workflow: the Temporal type + the manifest to wire it. */
export interface StartResolution {
  startType: string;
  manifest: WorkflowManifest;
}

/**
 * Resolve a built-in workflow to its version-pinned start type (§21b). Shared by
 * the platform API's default path and the WorkflowManager, so bundled and
 * externally-loaded workflows resolve through one code path. Returns undefined
 * for a name that isn't a built-in (the manager then checks installed packages).
 */
export function bundledStart(workflow: string, version?: string): StartResolution | undefined {
  const type = WORKFLOW_TYPE[workflow];
  const m = manifestFor(workflow);
  if (!type || !m) return undefined;
  return { startType: pinnedType(type, version ?? m.version), manifest: m };
}
