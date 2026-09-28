/** The repository's lint gate, run by `npm run lint` and CI's checks job.
 *
 *  oxlint's correctness rules (.oxlintrc.json) must report no errors. Two
 *  budgets in scripts/lint-budget.json cover what the code still breaks: the
 *  warnings of the rules it has not been cleaned of yet, and `as any` casts in
 *  src. Above budget fails. Below it only prints a notice: parallel pull
 *  requests that each remove a cast would otherwise pass alone and fail master
 *  together. `npm run lint -- --update` records the lower number, and raising
 *  a budget is a hand edit that a reviewer sees.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUDGET_FILE = path.join(root, 'scripts', 'lint-budget.json');

interface Budget { warnings: number; anyCasts: number }
interface Diagnostic { code: string; severity: string; message: string; filename: string;
  labels?: Array<{ span: { line: number; column: number } }> }

/** Casts to `any` or `any[]` (`x as any`, `<any>x`), found in the syntax tree
 *  so that annotations and the words in comments or strings do not count. */
export function anyCasts(fileName: string, source: string): number {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, false,
    fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  let count = 0;
  const isAny = (type: ts.TypeNode) => type.kind === ts.SyntaxKind.AnyKeyword
    || (ts.isArrayTypeNode(type) && type.elementType.kind === ts.SyntaxKind.AnyKeyword);
  const visit = (node: ts.Node) => {
    if ((ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) && isAny(node.type)) count++;
    ts.forEachChild(node, visit);
  };
  visit(file);
  return count;
}

export function budgetCheck(what: string, actual: number, budget: number): { failure?: string; notice?: string } {
  if (actual > budget) return { failure: `${actual} ${what}; the budget is ${budget}. Fix the new ones instead of raising it.` };
  if (actual < budget) return { notice: `${actual} ${what}, below the budget of ${budget}: run \`npm run lint -- --update\` to lower it.` };
  return {};
}

function main(update: boolean): number {
  const oxlint = spawnSync(path.join(root, 'node_modules', '.bin', 'oxlint'), ['--format=json', '.'], {
    cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  if (oxlint.error || !oxlint.stdout) throw oxlint.error ?? new Error(`oxlint failed: ${oxlint.stderr}`);
  const diagnostics = (JSON.parse(oxlint.stdout) as { diagnostics: Diagnostic[] }).diagnostics;
  const errors = diagnostics.filter((d) => d.severity === 'error');
  const warnings = diagnostics.length - errors.length;
  for (const d of errors) {
    const at = d.labels?.[0]?.span;
    console.error(`${d.filename}${at ? `:${at.line}:${at.column}` : ''} ${d.code}: ${d.message}`);
  }

  const sources = execFileSync('git', ['ls-files', '--', 'src/*.ts', 'src/*.mts', 'src/*.tsx'], { cwd: root, encoding: 'utf8' })
    .split('\n').filter(Boolean);
  const casts = sources.reduce((sum, file) => sum + anyCasts(file, fs.readFileSync(path.join(root, file), 'utf8')), 0);

  const budget = JSON.parse(fs.readFileSync(BUDGET_FILE, 'utf8')) as Budget;
  if (update) {
    const lowered = { warnings: Math.min(budget.warnings, warnings), anyCasts: Math.min(budget.anyCasts, casts) };
    fs.writeFileSync(BUDGET_FILE, `${JSON.stringify(lowered, null, 2)}\n`);
    Object.assign(budget, lowered);
  }
  const checks = [
    budgetCheck('lint warnings (`npx oxlint` lists them)', warnings, budget.warnings),
    budgetCheck('`as any` casts in src', casts, budget.anyCasts),
  ];
  const failures = [
    errors.length ? `${errors.length} lint errors (listed above).` : undefined,
    ...checks.map((check) => check.failure),
  ].filter(Boolean);
  for (const failure of failures) console.error(failure);
  for (const { notice } of checks) if (notice) console.log(notice);
  if (!failures.length) console.log(`lint: no errors; ${warnings} warnings and ${casts} \`as any\` casts, within budget.`);
  return failures.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.includes('--update'));
