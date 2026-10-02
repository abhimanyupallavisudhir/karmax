import { isEnvName } from './shell.js';

/** An entry left out of a turn's work environment. `source` names where it was
 *  configured (a label, never the entry's name or value: a malformed "name" is
 *  often pasted key material), `reason` says what to fix. */
export interface SkippedEnv { source: string; reason: string }

/** Why a command cannot receive this variable, if it cannot: the shell needs a
 *  name it can `export`, and the OS refuses a value containing NUL. */
export function envEntryProblem(name: string, value: string): string | undefined {
  if (!isEnvName(name)) return 'its env var name is not a valid variable name';
  if (value.includes('\0')) return 'its value contains a NUL byte';
  return undefined;
}

/** The entries a command can receive. One bad entry is dropped and reported on
 *  its own; it must never fail the turn, or every command, that carries it. */
export function screenEnvironment(env: Record<string, string>, source: (name: string) => string,
  skipped?: SkippedEnv[]): Record<string, string> {
  const usable: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    const problem = envEntryProblem(name, value);
    if (problem) skipped?.push({ source: source(name), reason: problem });
    else usable[name] = value;
  }
  return usable;
}

/** Tells the agent what it was not given, so it can tell the user what to fix
 *  instead of guessing why a variable is missing. */
export function skippedEnvNotice(skipped: SkippedEnv[]): string {
  if (!skipped.length) return '';
  return '\nCredentials not given to your shell this turn: '
    + skipped.map(({ source, reason }) => `${source} (${reason})`).join('; ')
    + '. They are set in the Vault or project settings; if the task needs one, tell the user what to fix there.';
}
