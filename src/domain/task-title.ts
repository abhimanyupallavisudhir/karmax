/**
 * A task given no title is named by the first words of what it asks: the first
 * non-blank line of its prompt (else its command), whitespace collapsed, at
 * most 80 characters, cut at a word. An unstarted task's derived title follows
 * every edit of its prompt (SPEC §10); a title given at creation stays.
 */
export const UNTITLED_TASK = 'Task';
const MAX_TITLE = 80;

type TitleSource = { prompt?: unknown; command?: unknown } | undefined;

export function derivedTaskTitle(params: TitleSource): string {
  for (const text of [params?.prompt, params?.command]) {
    if (typeof text !== 'string') continue;
    const line = text.split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).find(Boolean);
    if (line) return line.length <= MAX_TITLE ? line : shortened(line);
  }
  return UNTITLED_TASK;
}

/** At most MAX_TITLE characters ending in "…", cut after a whole word — unless
 *  the last space falls in the first half (a very long word): then mid-word. */
function shortened(line: string): string {
  const room = line.slice(0, MAX_TITLE);
  const space = room.lastIndexOf(' ');
  return `${(space >= MAX_TITLE / 2 ? room.slice(0, space) : room.slice(0, MAX_TITLE - 1)).trimEnd()}…`;
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
