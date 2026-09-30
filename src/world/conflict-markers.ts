import type { GitResult } from './git.js';

/** Scan literal paths in bounded argv batches; only grep's ordinary no-match
 * exit is safe to ignore. NUL records preserve whitespace and Unicode names. */
export async function conflictMarkerFiles(run: (args: string[]) => Promise<GitResult>, ref: string, files: string[]): Promise<string[]> {
  const marked: string[] = [];
  for (let offset = 0; offset < files.length; offset += 128) {
    const batch = files.slice(offset, offset + 128);
    const grep = async (pattern: string) => {
      const result = await run(['--literal-pathspecs', 'grep', '-z', '-l', '-E', pattern, ref, '--', ...batch]);
      if (result.code !== 0 && result.code !== 1) throw new Error(`conflict marker scan failed: ${result.stderr || result.code}`);
      return new Set(result.stdout.split('\0').filter(Boolean).map(value => value.slice(`${ref}:`.length)));
    };
    const open = await grep('^<{7}( |$)');
    if (!open.size) continue;
    const close = await grep('^>{7}( |$)');
    marked.push(...[...open].filter(file => close.has(file)));
  }
  return marked;
}
