import { WorkerManager } from '../temporal/worker-pool.js';
import { WorkflowRepoLoader } from './repo.js';
import { PackageStore } from './store.js';
import { ExternalWorkflowRef } from './bundle.js';
import { WORKFLOW_TYPE, qualifiedType } from '../workflows/names.js';
import { MANIFESTS, WorkflowManifest } from '../contrib/manifests.js';
import { bundledStart, StartResolution } from '../platform/resolve-start.js';

export interface WorkflowSummary {
  name: string;
  description: string;
  versions: string[];
  latest: string;
  /** `bundled` = compiled-in built-in; `external` = installed from a git repo. */
  source: 'bundled' | 'external';
}

/**
 * Ties workflow-package loading (git repo → validated manifest → code in the
 * worker bundle) to the running platform (PLAN-dynamic-repos §21d). Installing a
 * package loads it, registers it, and rolls the worker (§21e) so new tasks can
 * run it. The bundled built-ins remain compiled-in; installs bring *new*
 * workflow names. Upgrading a built-in over git is deliberately out of scope
 * here — that needs the built-ins to first become loadable packages, and goes
 * through the reviewed-PR edit gate (§4.4), not a blind overwrite.
 */
export class WorkflowManager {
  private external = new Map<string, ExternalWorkflowRef>(); // type → bundle ref

  constructor(
    private worker: WorkerManager,
    private loader: WorkflowRepoLoader,
    private store: PackageStore = PackageStore.withBundled(),
  ) {}

  /** The package store, for callers that resolve manifests directly. */
  get packages(): PackageStore {
    return this.store;
  }

  /** Every registered workflow (built-in + installed), with versions. */
  list(): WorkflowSummary[] {
    const bundled = new Set(MANIFESTS.map((m) => m.name));
    const names = [...new Set(this.store.list().map((p) => p.name))].sort();
    return names.map((name) => {
      const latest = this.store.resolve(name)!;
      return { name, description: latest.description, versions: this.store.versions(name), latest: latest.version, source: bundled.has(name) ? 'bundled' : 'external' };
    });
  }

  /**
   * Install (or add a version of) a workflow from a git repo, then roll the
   * worker to serve it. Refuses to shadow a built-in name.
   */
  async install(spec: { url: string; ref?: string; name?: string }): Promise<{ name: string; version: string }> {
    // Peek at the name to reject built-in collisions before doing the fetch when possible.
    if (spec.name && WORKFLOW_TYPE[spec.name]) throw new Error(`"${spec.name}" is a built-in workflow; edit it through the PR gate, not install`);
    const pkg = await this.loader.load(spec, this.store);
    if (WORKFLOW_TYPE[pkg.manifest.name]) {
      // Roll back the store registration to keep state consistent.
      this.store.retire(pkg.manifest.name, pkg.manifest.version);
      throw new Error(`"${pkg.manifest.name}" is a built-in workflow; edit it through the PR gate, not install`);
    }
    if (!pkg.workflowEntry) throw new Error(`package "${pkg.manifest.name}" ships no workflow module (workflow.ts|js|mjs)`);
    const type = qualifiedType(pkg.manifest.name, pkg.manifest.version);
    this.external.set(type, { type, entryFile: pkg.workflowEntry, exportName: manifestExport(pkg.manifest) });
    await this.worker.refresh([...this.external.values()]);
    return { name: pkg.manifest.name, version: pkg.manifest.version };
  }

  /** Resolve how to start `workflow` (built-in or installed) at an optional version. */
  resolveStart(workflow: string, version?: string): StartResolution | undefined {
    const builtIn = bundledStart(workflow, version);
    if (builtIn) return builtIn;
    const m = this.store.resolve(workflow, version);
    if (m && this.external.has(qualifiedType(workflow, m.version))) {
      return { startType: qualifiedType(workflow, m.version), manifest: m };
    }
    return undefined;
  }
}

/** The workflow module's export to use as the durable function (default when unset). */
function manifestExport(m: WorkflowManifest): string | undefined {
  return (m as { entrypoint?: string }).entrypoint;
}
