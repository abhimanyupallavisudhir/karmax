/**
 * Declarative composition — rendering tier 2 (SPEC §10.2). A contribution
 * declares a tree of *host* widgets (list, gauge, thread, diff, table, …) bound
 * to paths in the workflow's typed view-model. The host draws whatever is
 * declared with no per-workflow code: an extension gets a richer-than-floor UI
 * without shipping a component. A custom renderer is "only a prettier renderer
 * over the same query/signal/update contract" — this is that, declaratively.
 *
 * This module is the pure, testable core: it validates the spec and resolves
 * each widget's bind path against the view-model into a normalized descriptor.
 * The actual DOM drawing (the host widget library) lives in web/app.js and only
 * consumes these descriptors.
 */
export type WidgetType = 'text' | 'badge' | 'keyValue' | 'list' | 'table' | 'thread' | 'diff' | 'gauge';

export interface WidgetSpec {
  type: WidgetType;
  /** Dot/array path into the view-model, e.g. "reviewInfo.changedFiles" or "mergeQueue". */
  bind?: string;
  title?: string;
  /** Shown when the bound value is empty/missing. */
  empty?: string;
  // table: column field names within each row object (inferred from row 0 if omitted)
  columns?: string[];
  // keyValue: labelled sub-binds, each resolved against the same data root
  fields?: { label: string; bind: string }[];
  // gauge: where to read the maximum (path) when the bound value is a bare number;
  // if the bound value is an object, value/max are read from these keys.
  valueKey?: string;
  maxKey?: string;
}

export interface ResolvedWidget {
  type: WidgetType;
  title?: string;
  /** Normalized, ready-to-draw payload (shape depends on type). */
  data: unknown;
  empty?: string;
}

/** Resolve a dot/array path ("a.b.0.c") against an object; undefined if absent. */
export function bindPath(root: unknown, path?: string): unknown {
  if (!path) return root;
  let cur: any = root;
  for (const seg of path.split('.')) {
    if (cur == null) return undefined;
    cur = cur[seg];
  }
  return cur;
}

const asArray = (v: unknown): any[] => (Array.isArray(v) ? v : v == null ? [] : [v]);

/** Resolve a list of widget specs against a view-model into draw-ready descriptors. */
export function resolveWidgets(specs: WidgetSpec[] | undefined, data: unknown): ResolvedWidget[] {
  if (!specs?.length) return [];
  return specs.map((spec) => ({ type: spec.type, title: spec.title, empty: spec.empty, data: resolveOne(spec, data) }));
}

function resolveOne(spec: WidgetSpec, root: unknown): unknown {
  const v = bindPath(root, spec.bind);
  switch (spec.type) {
    case 'text':
    case 'badge':
      return v == null || v === '' ? '' : String(v);
    case 'list':
      return asArray(v).map((x) => (typeof x === 'object' ? JSON.stringify(x) : String(x)));
    case 'thread':
      return asArray(v).map((m: any) => ({ role: String(m?.role ?? ''), text: String(m?.text ?? (typeof m === 'string' ? m : '')) }));
    case 'diff':
      return v == null ? '' : String(v);
    case 'table': {
      const rows = asArray(v).filter((r) => r && typeof r === 'object');
      const columns = spec.columns ?? (rows[0] ? Object.keys(rows[0]) : []);
      return { columns, rows: rows.map((r: any) => columns.map((c) => (r[c] == null ? '' : String(r[c])))) };
    }
    case 'keyValue': {
      if (spec.fields?.length) return spec.fields.map((f) => ({ label: f.label, value: stringify(bindPath(root, f.bind)) }));
      // bound to a plain object → render its own keys
      if (v && typeof v === 'object' && !Array.isArray(v)) return Object.entries(v as object).map(([k, val]) => ({ label: k, value: stringify(val) }));
      return [];
    }
    case 'gauge': {
      let value = 0;
      let max = 0;
      if (v && typeof v === 'object') {
        value = Number((v as any)[spec.valueKey ?? 'value'] ?? 0);
        max = Number((v as any)[spec.maxKey ?? 'max'] ?? 0);
      } else {
        value = Number(v ?? 0);
        max = Number(bindPath(root, spec.maxKey) ?? 0);
      }
      const pct = max > 0 ? Math.max(0, Math.min(100, Math.round((value / max) * 100))) : 0;
      return { value, max, pct };
    }
    default:
      return undefined;
  }
}

function stringify(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}
