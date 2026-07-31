import fs from 'node:fs';
import path from 'node:path';

export interface GitCredential {
  /** Legacy/non-GitHub SSH credential. Materialized only for one operation. */
  sshKey?: string;
  /** Short-lived GitHub App installation token used as an HTTPS password. */
  httpsToken?: string;
  env?: Record<string, string>;
}

export interface MaterializedGitCredential {
  env: Record<string, string>;
  files: string[];
}

/**
 * Materialize a Git credential for one trusted host-side operation.
 *
 * GitHub repository records intentionally keep their stable SSH-shaped URL.
 * Two process-local `insteadOf` rules translate that URL to HTTPS, while
 * `GIT_ASKPASS` reads the short-lived installation token from a 0600 file. The
 * token therefore never lands in a remote URL, Git config, command argument, or
 * durable world handle.
 */
export function materializeGitCredential(
  directory: string,
  credential: GitCredential,
): MaterializedGitCredential {
  const env: Record<string, string> = { GIT_TERMINAL_PROMPT: '0', ...(credential.env ?? {}) };
  const files: string[] = [];
  if (credential.sshKey) {
    const keyPath = path.join(directory, 'repository.key');
    fs.writeFileSync(keyPath, credential.sshKey.endsWith('\n') ? credential.sshKey : `${credential.sshKey}\n`,
      { mode: 0o600 });
    env.GIT_SSH_COMMAND = `ssh -i ${keyPath} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new`;
    files.push(keyPath);
  }
  if (credential.httpsToken) {
    const tokenPath = path.join(directory, 'github.token');
    const askpassPath = path.join(directory, 'github-askpass');
    fs.writeFileSync(tokenPath, credential.httpsToken, { mode: 0o600 });
    fs.writeFileSync(askpassPath, `#!/bin/sh
case "$1" in
  *Username*) printf '%s\\n' x-access-token ;;
  *) cat ${shellQuote(tokenPath)} ;;
esac
`, { mode: 0o700 });
    env.GIT_ASKPASS = askpassPath;
    appendGitConfig(env, 'url.https://github.com/.insteadOf', 'git@github.com:');
    appendGitConfig(env, 'url.https://github.com/.insteadOf', 'ssh://git@ssh.github.com:443/');
    files.push(tokenPath, askpassPath);
  }
  return { env, files };
}

/** Append a process-local Git config entry without replacing caller isolation
 * or test transport rewrites already present in the environment. */
export function appendGitConfig(env: Record<string, string>, key: string, value: string): void {
  // If the caller did not intentionally provide an isolated config stack, keep
  // process-local rewrites (development/test file transports are a common
  // example) and append after them rather than hiding them by resetting COUNT.
  const parsed = Number(env.GIT_CONFIG_COUNT ?? process.env.GIT_CONFIG_COUNT ?? 0);
  const count = Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
  env[`GIT_CONFIG_KEY_${count}`] = key;
  env[`GIT_CONFIG_VALUE_${count}`] = value;
  env.GIT_CONFIG_COUNT = String(count + 1);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}
