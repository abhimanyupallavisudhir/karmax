import fs from 'node:fs';
import path from 'node:path';
import { WorkerManager } from '../temporal/worker-pool.js';
import { WorkflowRepoLoader, assertSafePackageName } from './repo.js';
import { PackageStore } from './store.js';
import { ExternalWorkflowRef } from './bundle.js';
import { WORKFLOW_TYPE, qualifiedType } from '../workflows/names.js';
import { MANIFESTS, WorkflowManifest } from '../contrib/manifests.js';
import { bundledStart, StartResolution } from '../platform/resolve-start.js';
import { isolatedGitEnvironment } from '../world/git.js';

/** One installed package, persisted so it can be reloaded at boot from disk. */
interface InstalledRecord {
  /** Missing only on registries written before organizations; those installs
   * migrate to org_personal and retain their historical Temporal type. */
  organizationId?: string;
  name: string;
  version: string;
  sha: string; // the exact commit — the version's true identity (§4.3)
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
 * here: built-ins change only with a platform release. External code is a
 * trusted self-host extension, never a tenant sandbox.
 */
export class WorkflowManager {
  private external = new Map<string, ExternalWorkflowRef>(); // type → bundle ref
  private shaByType = new Map<string, string>(); // type → the commit its code came from
  private shaByPackage = new Map<string, string>(); // organization + manifest name/version → commit
  private stores = new Map<string, PackageStore>();
  private mutation: Promise<unknown> = Promise.resolve();

  private exclusive<T>(run: () => Promise<T>): Promise<T> {
    const next = this.mutation.then(run);
    this.mutation = next.catch(() => {});
    return next;
  }

  constructor(
    private worker: Pick<WorkerManager, 'refresh'>,
    private loader: WorkflowRepoLoader,
    store: PackageStore = PackageStore.withBundled(),
    /** Directory for the persisted install registry; omit to disable persistence (tests). */
    private cacheHome?: string,
    /** Organization Git-profile credentials, resolved only for the install fetch. */
    private gitEnvironment?: (organizationId: string) => Record<string, string> | Promise<Record<string, string>>,
    /** External code shares the control-plane worker; never enable it for SaaS tenants. */
    private hosted = false,
  ) {
    this.stores.set('org_personal', store);
  }

  private get registryFile(): string | undefined {
    return this.cacheHome ? path.join(this.cacheHome, 'installed.json') : undefined;
  }

  /**
   * Read only well-formed records confined to the package cache. Registry paths
   * eventually become worker bundle inputs and must not select arbitrary files.
   */
  private readRegistry(): InstalledRecord[] {
    const f = this.registryFile;
    if (!f || !fs.existsSync(f)) return [];
    let data: unknown;
    try {
      data = JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch {
      return [];
    }
    if (!Array.isArray(data)) return [];
    return data.filter((r): r is InstalledRecord => this.validRecord(r));
  }

  private validRecord(r: unknown): boolean {
    if (!r || typeof r !== 'object') return false;
    const rec = r as Record<string, unknown>;
    const str = (v: unknown) => typeof v === 'string' && v.length > 0 && v.length < 4096;
    if (!str(rec.name) || !str(rec.version) || !str(rec.sha) || !str(rec.dir)) return false;
    if (rec.organizationId !== undefined && !str(rec.organizationId)) return false;
    if (!/^[0-9a-f]{7,64}$/i.test(rec.sha as string)) return false;
    return this.underCacheHome(rec.dir as string);
  }

  /** Is `dir` inside the package cache we control? */
  private underCacheHome(dir: string): boolean {
    if (!this.cacheHome) return false;
    const rel = path.relative(path.resolve(this.cacheHome), path.resolve(dir));
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
  }

  private writeRegistry(records: InstalledRecord[]): void {
    const f = this.registryFile;
    if (!f) return;
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify(records, null, 2));
  }

  /** The package store, for callers that resolve manifests directly. */
  get packages(): PackageStore {
    return this.storeFor('org_personal');
  }

  /** Every workflow available to one organization (built-ins + its installs). */
  list(organizationId = 'org_personal'): WorkflowSummary[] {
    const store = this.storeFor(organizationId);
    const bundled = new Set(MANIFESTS.map((m) => m.name));
    const names = [...new Set(store.list().map((p) => p.name))].sort();
    return names.map((name) => {
      const latest = store.resolve(name)!;
      return { name, description: latest.description, versions: store.versions(name), latest: latest.version, source: bundled.has(name) ? 'bundled' : 'external' };
    });
  }

  /**
   * Install (or add a version of) a workflow from a git repo, then roll the
   * worker to serve it. Refuses to shadow a built-in name.
   */
  async install(spec: { url: string; ref?: string; name?: string }, organizationId = 'org_personal'): Promise<{ name: string; version: string }> {
    return this.exclusive(() => this.installExclusive(spec, organizationId));
  }

  private async installExclusive(spec: { url: string; ref?: string; name?: string }, organizationId: string): Promise<{ name: string; version: string }> {
    if (this.hosted) throw new Error('External workflow code is disabled in hosted deployments');
    // Peek at the name to reject built-in collisions before doing the fetch when possible.
    if (spec.name && isBuiltInWorkflowName(spec.name)) throw new Error(`"${spec.name}" is a built-in workflow; built-ins change only with a platform release`);
    // Load + validate WITHOUT registering yet — a rejected package must not touch state.
    const pkg = await this.loader.load(spec, undefined, organizationId, {
      ...(organizationId === 'org_personal' ? {} : isolatedGitEnvironment()),
      ...((await this.gitEnvironment?.(organizationId)) ?? {}),
    });
    if (isBuiltInWorkflowName(pkg.manifest.name)) throw new Error(`"${pkg.manifest.name}" is a built-in workflow; built-ins change only with a platform release`);
    if (!pkg.workflowEntry) throw new Error(`package "${pkg.manifest.name}" ships no workflow module (workflow.ts|js|mjs)`);
    const type = externalWorkflowType(organizationId, pkg.manifest.name, pkg.manifest.version);
    // Version identity is load-bearing: a task pinned to name@version replays that
    // version's code forever (§21b). Re-publishing the same version from a
    // different commit would swap code under in-flight executions, so refuse it —
    // an edit must bump the version (§4.3/§4.4). Re-installing the same commit is
    // an idempotent no-op.
    const packageKey = `${organizationId}:${qualifiedType(pkg.manifest.name, pkg.manifest.version)}`;
    const priorSha = this.shaByPackage.get(packageKey);
    if (priorSha && priorSha !== pkg.sha) {
      throw new Error(`${pkg.manifest.name}@${pkg.manifest.version} was already published from commit ${priorSha.slice(0, 8)}; bump the version to publish new code`);
    }
    if (priorSha === pkg.sha) return { name: pkg.manifest.name, version: pkg.manifest.version }; // no-op
    // The three maps ARE the bundle input, so a package that fails to compile must
    // not be left in them: `worker.refresh` would then rebuild the same broken
    // bundle on every subsequent install and wedge the manager permanently.
    // Snapshot, mutate, and roll back if the roll fails.
    const snapshot = { external: new Map(this.external), shaByType: new Map(this.shaByType), shaByPackage: new Map(this.shaByPackage) };
    this.external.set(type, { type, entryFile: pkg.workflowEntry, exportName: manifestExport(pkg.manifest) });
    this.shaByType.set(type, pkg.sha);
    this.shaByPackage.set(packageKey, pkg.sha);
    try {
      await this.worker.refresh([...this.external.values()]);
    } catch (e) {
      this.external = snapshot.external;
      this.shaByType = snapshot.shaByType;
      this.shaByPackage = snapshot.shaByPackage;
      // Best-effort: put the worker back on the last bundle that did build.
      await this.worker.refresh([...this.external.values()]).catch(() => {});
      throw e;
    }
    this.storeFor(organizationId).register(pkg.manifest);
    this.persist(organizationId, pkg.manifest.name, pkg.manifest.version, pkg.sha, pkg.dir);
    return { name: pkg.manifest.name, version: pkg.manifest.version };
  }

  /**
   * Reload previously-installed packages from disk and roll the worker once so
   * they're served again after a restart (SPEC §4.2). Loads from the cached
   * snapshot — no network — so an unreachable origin doesn't break boot. A
   * snapshot that has gone missing is skipped (reported to `onWarn`).
   */
  async restore(onWarn: (msg: string) => void = () => {}): Promise<number> {
    return this.exclusive(() => this.restoreExclusive(onWarn));
  }

  private async restoreExclusive(onWarn: (msg: string) => void): Promise<number> {
    if (this.hosted) {
      if (this.readRegistry().length) onWarn('External workflow restore disabled in hosted deployments; existing external executions require migration');
      return 0;
    }
    const records = this.readRegistry();
    const external = new Map(this.external), shaByType = new Map(this.shaByType), shaByPackage = new Map(this.shaByPackage);
    const manifests: { organizationId: string; manifest: WorkflowManifest }[] = [];
    let loaded = 0;
    for (const r of records) {
      try {
        // Reassert confinement before reading the manifest and selecting code.
        if (!this.underCacheHome(r.dir)) throw new Error('snapshot outside the workflow cache');
        if (!fs.existsSync(r.dir)) throw new Error('snapshot missing');
        // A version is "pinned by commit SHA", so the record must point at the
        // snapshot that commit produced (`<nameDir>/<sha>`) and not at some other
        // directory. NOTE: this does not re-hash the tree — nothing on disk
        // records the expected content hash — so an attacker with write access to
        // the cache can still edit a snapshot in place. Confining `dir` and
        // matching the SHA closes the registry-rewrite path; hardening the cache
        // contents themselves needs a stored tree digest (not yet recorded).
        if (path.basename(r.dir) !== r.sha) throw new Error('snapshot directory does not match its pinned commit');
        const { manifest, workflowEntry } = await this.loader.inspect(r.dir);
        if (!workflowEntry) throw new Error('no workflow module');
        const organizationId = r.organizationId ?? 'org_personal';
        if (isBuiltInWorkflowName(manifest.name)) throw new Error('shadows a built-in workflow');
        // Legacy personal installs already have running executions pinned to the
        // old unqualified package type. Keep that export forever; new records are
        // tenant-qualified so two organizations may install the same name/version
        // from different commits without code or replay collisions.
        const type = r.organizationId
          ? externalWorkflowType(organizationId, manifest.name, manifest.version)
          : qualifiedType(manifest.name, manifest.version);
        external.set(type, { type, entryFile: workflowEntry, exportName: manifestExport(manifest) });
        shaByType.set(type, r.sha);
        shaByPackage.set(`${organizationId}:${qualifiedType(manifest.name, manifest.version)}`, r.sha);
        manifests.push({ organizationId, manifest });
        loaded++;
      } catch (e) {
        onWarn(`could not restore workflow ${r.name}@${r.version}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (external.size) await this.worker.refresh([...external.values()]);
    this.external = external; this.shaByType = shaByType; this.shaByPackage = shaByPackage;
    for (const { organizationId, manifest } of manifests) this.storeFor(organizationId).register(manifest);
    return loaded;
  }

  /** Remove one tenant's selectable packages after all of its task executions
   * have been terminated as part of organization deletion. */
  async removeOrganization(organizationId: string): Promise<void> {
    return this.exclusive(() => this.removeOrganizationExclusive(organizationId));
  }

  private async removeOrganizationExclusive(organizationId: string): Promise<void> {
    if (organizationId === 'org_personal') throw new Error('cannot remove personal organization workflows');
    const records = this.readRegistry();
    const removed = records.filter((record) => record.organizationId === organizationId);
    for (const record of removed) {
      const type = externalWorkflowType(organizationId, record.name, record.version);
      this.external.delete(type);
      this.shaByType.delete(type);
      this.shaByPackage.delete(`${organizationId}:${qualifiedType(record.name, record.version)}`);
    }
    this.stores.delete(organizationId);
    this.writeRegistry(records.filter((record) => record.organizationId !== organizationId));
    if (removed.length) await this.worker.refresh([...this.external.values()]);
    if (this.cacheHome) {
      // Validate rather than scrub: the old `.replace()` left dots intact, so an
      // id of `..` would have made this recursive rmSync delete the cache root.
      const safe = assertSafePackageName(organizationId, 'organization id');
      fs.rmSync(path.join(this.cacheHome, 'organizations', safe), { recursive: true, force: true });
    }
  }

  private persist(organizationId: string, name: string, version: string, sha: string, dir: string): void {
    const records = this.readRegistry().filter((r) =>
      !((r.organizationId ?? 'org_personal') === organizationId && r.name === name && r.version === version),
    );
    records.push({ organizationId, name, version, sha, dir });
    this.writeRegistry(records);
  }

  /**
   * Task-form schemas include hidden workflows: existing drafts still need their
   * fields to display and save correctly. Creation-picker visibility is separate.
   * Coordinators are excluded (not user-startable).
   */
  schemas(organizationId = 'org_personal'): { name: string; description: string; params: unknown; stages: unknown }[] {
    const store = this.storeFor(organizationId);
    return [...new Set(store.list().map((p) => p.name))]
      .map((name) => store.resolve(name)!)
      .filter((m) => m.kind !== 'coordinator')
      .map((m) => ({ name: m.name, description: m.description, params: m.params, stages: m.stages }));
  }

  /** Resolve how to start `workflow` (built-in or installed) at an optional version. */
  resolveStart(workflow: string, version?: string, organizationId = 'org_personal'): StartResolution | undefined {
    const builtIn = bundledStart(workflow, version);
    if (builtIn) return builtIn;
    const m = this.storeFor(organizationId).resolve(workflow, version);
    const scopedType = m ? externalWorkflowType(organizationId, workflow, m.version) : undefined;
    const legacyType = organizationId === 'org_personal' && m ? qualifiedType(workflow, m.version) : undefined;
    const type = scopedType && this.external.has(scopedType)
      ? scopedType
      : legacyType && this.external.has(legacyType) ? legacyType : undefined;
    if (m && type) {
      return { startType: type, manifest: m };
    }
    return undefined;
  }

  private storeFor(organizationId: string): PackageStore {
    let store = this.stores.get(organizationId);
    if (!store) {
      store = PackageStore.withBundled();
      this.stores.set(organizationId, store);
    }
    return store;
  }
}

/**
 * Names a package may never install under.
 *
 * `WORKFLOW_TYPE` alone was not enough: its keys are only the five *task*
 * workflows, so the bundled coordinator manifests (`merge-queue`, `agent-queue`,
 * `account-coordinator`) were installable — and a second `agent-queue` manifest
 * shadowing the built-in one drives the global "Concurrent agent turns" form.
 * Using a Set (rather than indexing an object) also stops `constructor`,
 * `__proto__` and friends from testing truthy through the prototype chain.
 */
const BUILT_IN_WORKFLOW_NAMES: ReadonlySet<string> = new Set([
  ...Object.keys(WORKFLOW_TYPE),
  ...MANIFESTS.map((m) => m.name),
]);

export function isBuiltInWorkflowName(name: string): boolean {
  return BUILT_IN_WORKFLOW_NAMES.has(name);
}

/** Internal Temporal workflow types are tenant-qualified. Human-facing manifest
 * names stay unchanged within each organization. */
export function externalWorkflowType(organizationId: string, name: string, version: string): string {
  return `external:${organizationId}:${qualifiedType(name, version)}`;
}

/** The workflow module's export to use as the durable function (default when unset). */
function manifestExport(m: WorkflowManifest): string | undefined {
  return (m as { entrypoint?: string }).entrypoint;
}
