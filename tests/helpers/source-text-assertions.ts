import fs from 'node:fs';
import path from 'node:path';

/**
 * Counts the assertions a test file makes on the text of karmax's own source
 * (`expect(source).toContain(...)` where `source` came from reading a file
 * under src/ or web/). Such a test passes while the behaviour is broken and
 * fails when the code is merely reworded (CI-15). A value is source text if
 * it is read from src/ or web/, or derived from such a value, by any
 * `const`/`let` declaration or assignment in the file. Source compiled or
 * run (`Function(...)`, `vm`, a spawned script) is not text: asserting on
 * what it returns tests behaviour.
 */
export function sourceTextAssertions(file: string): number {
  const text = fs.readFileSync(file, 'utf8');
  const reads = /readFileSync\([^;]*?['"`](?:\.\.\/)*(?:src|web)\/|new URL\(\s*['"`](?:\.\.\/)+(?:src|web)\//;
  const bindings = [...text.matchAll(/(?:\b(?:const|let|var)\s+|^\s*)([A-Za-z_$][\w$]*)\s*=(?!=)\s*([^;]+)/gm)]
    .map((match) => ({ name: match[1]!, value: match[2]! }));
  const tainted = new Set<string>();
  for (let grew = true; grew;) {
    grew = false;
    for (const { name, value } of bindings) {
      if (tainted.has(name)) continue;
      // Compiling or running the source executes it: its results are behaviour.
      if (/\bFunction\(|\bvm\.|runInContext|runInNewContext|\beval\(|\b(?:spawn|exec|execFile)(?:Sync)?\(/.test(value)) continue;
      // A name inside a quoted string ('memory-guard.log') is not a use of that binding.
      const code = value.replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/g, "''");
      if (reads.test(value) || [...tainted].some((source) => new RegExp(`\\b${escape(source)}\\b`).test(code))) {
        tainted.add(name);
        grew = true;
      }
    }
  }
  let count = 0;
  for (const call of text.matchAll(/\bexpect\(/g)) {
    const open = call.index! + call[0].length;
    const close = closingParen(text, open);
    const subject = text.slice(open, close).trim();
    const head = /^(?:fs\.)?([A-Za-z_$][\w$]*)/.exec(subject)?.[1];
    const aboutSource = reads.test(subject) || (head !== undefined && tainted.has(head));
    if (aboutSource && /^\s*\.\s*(?:not\s*\.\s*)?(?:toContain|toMatch)\s*\(/.test(text.slice(close + 1, close + 200))) count++;
  }
  return count;
}

export function testFiles(root = 'tests'): string[] {
  return fs.readdirSync(root, { recursive: true, encoding: 'utf8' })
    .filter((file) => /\.test\.ts$/.test(file))
    .map((file) => path.posix.join(root, file.split(path.sep).join('/')))
    .sort();
}

/** Index of the parenthesis closing the one opened just before `from`. */
function closingParen(text: string, from: number): number {
  let depth = 1;
  for (let index = from; index < text.length; index++) {
    const char = text[index];
    if (char === '(') depth++;
    else if (char === ')' && --depth === 0) return index;
  }
  return text.length;
}

function escape(value: string): string {
  return value.replace(/[$]/g, '\\$');
}
