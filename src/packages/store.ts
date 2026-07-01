import { WorkflowManifest, MANIFESTS } from '../contrib/manifests.js';
import { parseManifest, safeParseManifest } from './schema.js';

export interface PackageRef {
  name: string;
  version: string;
}

/**
 * The workflow package store (PLAN item 21, Phase 21a). Holds validated workflow
 * manifests keyed by `name@version` — the substrate for version-pinned execution
 * and (later) loading packages from versioned git repos. In this phase it is
 * seeded from the bundled `MANIFESTS`; nothing in the running system consumes it
 * yet, so behavior is unchanged. 21b wires version-qualified execution onto it,
 * 21c adds git-repo resolution.
 */
export class PackageStore {
  private pkgs = new Map<string, Map<string, WorkflowManifest>>(); // name → version → manifest

  /** A store preloaded with the bundled workflows (each at its manifest version). */
  static withBundled(): PackageStore {
    const s = new PackageStore();
    for (const m of MANIFESTS) s.register(m);
    return s;
  }

  /** Validate + register a manifest (throws on malformed). Returns the typed manifest. */
  register(data: unknown): WorkflowManifest {
    const m = parseManifest(data);
    if (!this.pkgs.has(m.name)) this.pkgs.set(m.name, new Map());
    this.pkgs.get(m.name)!.set(m.version, m);
    return m;
  }

  /** Validate + register without throwing; a malformed package is rejected, not added. */
  tryRegister(data: unknown): { ok: true; manifest: WorkflowManifest } | { ok: false; error: string } {
    const r = safeParseManifest(data);
    if (r.ok) this.register(r.manifest);
    return r;
  }

  /** Resolve `name@version` — the pinned version, or the latest when omitted. */
  resolve(name: string, version?: string): WorkflowManifest | undefined {
    const versions = this.pkgs.get(name);
    if (!versions) return undefined;
    if (version) return versions.get(version);
    return latest(versions);
  }

  /** Every registered `name@version`. */
  list(): PackageRef[] {
    const out: PackageRef[] = [];
    for (const [name, versions] of this.pkgs) for (const v of versions.keys()) out.push({ name, version: v });
    return out;
  }

  /** Registered versions of a package, ascending. */
  versions(name: string): string[] {
    return [...(this.pkgs.get(name)?.keys() ?? [])].sort(cmpVersion);
  }
}

function latest(versions: Map<string, WorkflowManifest>): WorkflowManifest | undefined {
  const keys = [...versions.keys()].sort(cmpVersion);
  return keys.length ? versions.get(keys[keys.length - 1]!) : undefined;
}

/** Compare dotted numeric versions (1.2.0 < 1.10.0); non-numeric parts sort as 0. */
function cmpVersion(a: string, b: string): number {
  const pa = a.split('.').map((x) => Number(x) || 0);
  const pb = b.split('.').map((x) => Number(x) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}
