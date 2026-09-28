/**
 * Resilience: safe mode and overlay resolution (SPEC §9). Defaults ship
 * immutable and read-only; customizations are versioned overlays that shadow
 * them. Resolution order is project override → user override → bundled default.
 * Nothing is destroyed — "restore" is choosing which layer to resolve from.
 *
 * - Global safe mode resolves with all overlays off (the robust floor).
 * - Per-workflow disable/fallback drops one custom workflow to its default/off
 *   while the rest of the customization keeps working.
 *
 * Boundary (§9): safe mode reverts code/behavior, not state.
 *
 * Not wired: main.ts hands an instance to the gateway, but nothing resolves
 * through it, and the inert installation safe-mode control was removed (GW-11).
 * Until a caller consumes it, this is a tested library, not a recovery path.
 */
export type Layer = 'bundled' | 'user' | 'project';

export interface ResolveOptions {
  safeMode?: boolean;
}

export class Overlays {
  private bundled: Record<string, unknown> = {};
  private user: Record<string, unknown> = {};
  private project: Record<string, unknown> = {};
  /** Workflows the user/project disabled (fall back to bundled default / off). */
  private disabled = new Set<string>();

  setBundled(obj: Record<string, unknown>): this {
    this.bundled = { ...obj };
    return this;
  }
  setUser(obj: Record<string, unknown>): this {
    this.user = { ...obj };
    return this;
  }
  setProject(obj: Record<string, unknown>): this {
    this.project = { ...obj };
    return this;
  }

  /** Resolve one key by precedence; safe mode resolves bundled only. */
  resolve<T = unknown>(key: string, opts: ResolveOptions = {}): T | undefined {
    if (opts.safeMode) return this.bundled[key] as T | undefined;
    if (key in this.project) return this.project[key] as T;
    if (key in this.user) return this.user[key] as T;
    return this.bundled[key] as T | undefined;
  }

  /** Resolve the merged settings object. */
  resolveAll(opts: ResolveOptions = {}): Record<string, unknown> {
    if (opts.safeMode) return { ...this.bundled };
    return { ...this.bundled, ...this.user, ...this.project };
  }

  disableWorkflow(name: string) {
    this.disabled.add(name);
  }
  enableWorkflow(name: string) {
    this.disabled.delete(name);
  }
  isDisabled(name: string, opts: ResolveOptions = {}): boolean {
    if (opts.safeMode) return false; // vanilla: nothing custom-disabled
    return this.disabled.has(name);
  }

  /** Effective active workflows: all minus disabled, unless safe mode (vanilla). */
  effectiveWorkflows(all: string[], opts: ResolveOptions = {}): string[] {
    if (opts.safeMode) return [...all];
    return all.filter((w) => !this.disabled.has(w));
  }
}
