import fs from 'node:fs';
import path from 'node:path';
import { WorkerManager } from '../temporal/worker-pool.js';
import { WorkflowRepoLoader } from './repo.js';
import { PackageStore } from './store.js';
import { ExternalWorkflowRef } from './bundle.js';
import { WORKFLOW_TYPE, qualifiedType } from '../workflows/names.js';
import { MANIFESTS, WorkflowManifest } from '../contrib/manifests.js';
import { bundledStart, StartResolution } from '../platform/resolve-start.js';

/** One installed package, persisted so it can be reloaded at boot from disk. */
interface InstalledRecord {
  name: string;
  version: string;
  dir: string; // immutable snapshot dir (holds manifest + workflow code)
}

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
    /** Directory for the persisted install registry; omit to disable persistence (tests). */
    private cacheHome?: string,
  ) {}

  private get registryFile(): string | undefined {
    return this.cacheHome ? path.join(this.cacheHome, 'installed.json') : undefined;
  }

  private readRegistry(): InstalledRecord[] {
    const f = this.registryFile;
    if (!f || !fs.existsSync(f)) return [];
    try {
      const data = JSON.parse(fs.readFileSync(f, 'utf8'));
      return Array.isArray(data) ? data : [];
    } catch {
      return [];
    }
  }

  private writeRegistry(records: InstalledRecord[]): void {
    const f = this.registryFile;
    if (!f) return;
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify(records, null, 2));
  }

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
    this.persist(pkg.manifest.name, pkg.manifest.version, pkg.dir);
    return { name: pkg.manifest.name, version: pkg.manifest.version };
  }

  /**
   * Reload previously-installed packages from disk and roll the worker once so
   * they're served again after a restart (SPEC §4.2). Loads from the cached
   * snapshot — no network — so an unreachable origin doesn't break boot. A
   * snapshot that has gone missing is skipped (reported to `onWarn`).
   */
  async restore(onWarn: (msg: string) => void = () => {}): Promise<number> {
    const records = this.readRegistry();
    let loaded = 0;
    for (const r of records) {
      try {
        if (!fs.existsSync(r.dir)) throw new Error('snapshot missing');
        const { manifest, workflowEntry } = await this.loader.inspect(r.dir);
        if (!workflowEntry) throw new Error('no workflow module');
        this.store.register(manifest);
        const type = qualifiedType(manifest.name, manifest.version);
        this.external.set(type, { type, entryFile: workflowEntry, exportName: manifestExport(manifest) });
        loaded++;
      } catch (e) {
        onWarn(`could not restore workflow ${r.name}@${r.version}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (this.external.size) await this.worker.refresh([...this.external.values()]);
    return loaded;
  }

  private persist(name: string, version: string, dir: string): void {
    const records = this.readRegistry().filter((r) => !(r.name === name && r.version === version));
    records.push({ name, version, dir });
    this.writeRegistry(records);
  }

  /**
   * Task-form parameter schemas for every selectable workflow — built-in and
   * installed (§10.4/§21d) — so an installed workflow is pickable in the New Task
   * form, not just via the API. Coordinators are excluded (not user-startable).
   */
  schemas(): { name: string; description: string; params: unknown; stages: unknown }[] {
    return [...new Set(this.store.list().map((p) => p.name))]
      .map((name) => this.store.resolve(name)!)
      .filter((m) => m.kind !== 'coordinator')
      .map((m) => ({ name: m.name, description: m.description, params: m.params, stages: m.stages }));
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
