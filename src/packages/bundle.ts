import os from 'node:os';
import { createRequire } from 'node:module';
import { paths } from '../config/paths.js';
import { cachedWorkflowBundle, bundleHash } from './bundle-cache.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { bundleWorkflowCode, WorkflowBundle, DefaultLogger, LogLevel } from '@temporalio/worker';
import { ENTRYPOINT_PATTERN } from './schema.js';

/** An externally-loaded workflow to fold into the worker's deterministic bundle. */
export interface ExternalWorkflowRef {
  /** The version-qualified Temporal type to register it under, e.g. `greeter@1.0.0`. */
  type: string;
  /** Absolute path to the package's durable workflow module. */
  entryFile: string;
  /** Named export to use as the workflow function; the default export when omitted. */
  exportName?: string;
}

const INDEX_URL = pathToFileURL(fileURLToPath(new URL('../workflows/index.ts', import.meta.url))).href;
const PROJECT_NODE_MODULES = fileURLToPath(new URL('../../node_modules', import.meta.url));

/**
 * Build a Temporal workflow bundle that contains the platform's bundled
 * workflows *plus* externally-loaded packages, each registered under its
 * version-qualified type (PLAN-dynamic-repos §21c). This is how a workflow
 * package's *code* — the SPEC's whole point (§4.1) — actually enters the
 * deterministic sandbox: it is compiled in alongside the built-ins, not
 * interpreted. `export *` carries the bundled `type@version` exports through,
 * so loading an external package never drops the built-in ones.
 *
 * The generated entry lives in a temp dir; the webpack resolve hook points at
 * the project's node_modules so an external file far from the tree can still
 * resolve `@temporalio/workflow`.
 */
export async function buildVersionedBundle(externals: ExternalWorkflowRef[], options: {
  workflowsPath?: string; cacheDir?: string;
} = {}): Promise<WorkflowBundle> {
  const entry = options.workflowsPath
    ? `export * from ${JSON.stringify(pathToFileURL(options.workflowsPath).href)};\n`
    : generateEntry(externals);
  const identity = JSON.stringify([3, entry, process.versions, process.platform, process.arch,
    process.env.NODE_ENV, process.env.NODE_OPTIONS, process.env.SWC_BINARY_PATH]);
  return cachedWorkflowBundle(options.cacheDir ?? path.join(paths().state, 'workflow-bundles'), identity,
    () => compileBundle(entry));
}

async function compileBundle(entry: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-wf-entry-'));
  try {
    fs.writeFileSync(path.join(dir, 'entry.mjs'), entry);
    let files: string[] = [], missing: string[] = [], contexts: string[] = [];
    const reads = new Map<string, string>();
    const keep = (file: string) => !file.startsWith(dir + path.sep);
    const require = createRequire(import.meta.url);
    // Quiet the bundler's webpack/info chatter by default (KARMAX_TEMPORAL_LOG to raise).
    const level = (process.env.KARMAX_TEMPORAL_LOG ?? 'WARN').toUpperCase() as LogLevel;
    const bundle = await bundleWorkflowCode({
      workflowsPath: path.join(dir, 'entry.mjs'),
      logger: new DefaultLogger(level),
      webpackConfigHook: (config) => {
        config.resolve = config.resolve ?? {};
        (config.resolve as { modules?: string[] }).modules = [PROJECT_NODE_MODULES, ...((config.resolve as { modules?: string[] }).modules ?? ['node_modules'])];
        config.plugins ??= [];
        config.plugins.push({ apply(compiler) {
          compiler.hooks.beforeRun.tap('karmax-bundle-inputs', () => {
            const input = compiler.inputFileSystem!;
            const read = input.readFile.bind(input);
            input.readFile = ((file: string, callback: any) => read(file, (error: any, bytes: any) => {
              if (!error && bytes && keep(String(file)) && fs.existsSync(String(file)))
                reads.set(String(file), bundleHash(bytes));
              callback(error, bytes);
            })) as typeof input.readFile;
          });
          compiler.hooks.afterCompile.tap('karmax-bundle-inputs', compilation => {
            files = [...compilation.fileDependencies].filter(keep);
            missing = [...compilation.missingDependencies].filter(keep);
            contexts = [...compilation.contextDependencies].filter(keep);
          });
        } });
        return config;
      },
    });
    // Include the compiler/loader implementation, SDK version, and our bundle
    // configuration as well as webpack's transitive workflow/resolution inputs.
    const toolFiles = Object.keys(require.cache);
    const manifests = toolFiles.flatMap(file => {
      const match = file.match(/^(.*[/\\]node_modules[/\\](?:@[^/\\]+[/\\])?[^/\\]+)[/\\]/);
      return match ? [path.join(match[1]!, 'package.json')] : [];
    });
    files.push(...toolFiles, ...manifests, fileURLToPath(import.meta.url),
      fileURLToPath(new URL('./bundle-cache.ts', import.meta.url)),
      fileURLToPath(new URL('../../package-lock.json', import.meta.url)),
      fileURLToPath(new URL('../../package.json', import.meta.url)));
    return { bundle, files: [...new Set(files)], missing, contexts, reads };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The generated bundle entry: re-export the built-ins, then each external type.
 *
 * `type` and `entryFile` are `JSON.stringify`'d, but `exportName` cannot be — it
 * is an *identifier* position in the generated `import { X as _ext0 }` and is
 * therefore raw source. It comes from an untrusted package manifest, so re-check
 * it here even though `manifestSchema` already validates it: this function is the
 * last point before attacker text becomes code webpack compiles into the worker,
 * and defence must not depend on every caller having validated first.
 */
export function generateEntry(externals: ExternalWorkflowRef[]): string {
  const lines: string[] = [];
  const reexports: string[] = [];
  externals.forEach((ext, i) => {
    const local = `_ext${i}`;
    const url = JSON.stringify(pathToFileURL(ext.entryFile).href);
    if (ext.exportName !== undefined && !ENTRYPOINT_PATTERN.test(ext.exportName))
      throw new Error(`workflow package "${ext.type}" declares an invalid export name; it must be a bare JavaScript identifier`);
    lines.push(ext.exportName ? `import { ${ext.exportName} as ${local} } from ${url};` : `import ${local} from ${url};`);
    reexports.push(`export { ${local} as ${JSON.stringify(ext.type)} };`);
  });
  lines.push(`export * from ${JSON.stringify(INDEX_URL)};`);
  lines.push(...reexports);
  return lines.join('\n') + '\n';
}
