/**
 * A task given no title is named by the first words of what it asks: the first
 * non-blank line of its prompt (else its command), whitespace collapsed, at
 * most 80 characters. An unstarted task's derived title follows every edit of
 * its prompt (SPEC §10); a title given at creation is the task's own and stays.
 */
export const UNTITLED_TASK = 'Task';
const MAX_TITLE = 80;

type TitleSource = { prompt?: unknown; command?: unknown } | undefined;

export function derivedTaskTitle(params: TitleSource): string {
  for (const text of [params?.prompt, params?.command]) {
    if (typeof text !== 'string') continue;
    const line = text.split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).find(Boolean);
    if (line) return line.slice(0, MAX_TITLE).trimEnd();
  }
  return UNTITLED_TASK;
}

/** The rule before 2026-11: the raw first line of the prompt (else command),
 *  "Task" when that line was empty. Titles it derived still count as derived. */
function legacyDerivedTitle(params: TitleSource): string {
  const text = String(params?.prompt ?? params?.command ?? UNTITLED_TASK);
  return (text.split('\n')[0] ?? UNTITLED_TASK).slice(0, MAX_TITLE) || UNTITLED_TASK;
}

/** Whether `title` is the one these params name the task by, rather than one given to it. */
export function isDerivedTaskTitle(title: string, params: TitleSource): boolean {
  return title === derivedTaskTitle(params) || title === legacyDerivedTitle(params);
}
