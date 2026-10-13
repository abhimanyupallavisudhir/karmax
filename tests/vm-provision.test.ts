import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { vmProvisionFailure, vmProvisionScript } from '../src/world/vm/provision.js';

/**
 * The provisioning script every Fly/Hetzner machine without karmax's image
 * runs (wiki features/vm-worlds). pramana#39 (2026-10-13): from Hetzner's
 * network, plain HTTP to dl.google.com connects and never answers; apt treated
 * the unreachable source as a warning, so `apt-get update` "succeeded", each
 * retry of the Chrome install failed with "Unable to locate package", and the
 * error people saw was forty lines of `Setting up …` with the cause beneath.
 */
describe('VM provisioning script', () => {
  const script = vmProvisionScript('/opt/karmax/.vm-provisioned-test');

  it('fetches everything over HTTPS, Chrome from Google\'s CDN first, and leaves no Google apt source behind', () => {
    // From Hetzner, dl.google.com never answers HTTP and serves HTTPS at ~100 KB/s.
    expect(script).not.toMatch(/http:\/\//);
    expect(script).toContain('retry chrome_from https://edgedl.me.gvt1.com/edgedl/linux/chrome/deb/ || retry chrome_from https://dl.google.com/linux/chrome/deb/');
    expect(script).toContain('signed-by=/etc/apt/keyrings/google-chrome.gpg');
    expect(script).toContain('rm -f /etc/apt/sources.list.d/google-chrome.list /etc/apt/sources.list.d/google-chrome.sources');
  });

  it('fails an apt update when any source fails, and gives up on a stalled mirror after 30 s', () => {
    expect(script).toMatch(/apt_update\(\) \{ apt-get update -qq --error-on=any; \}/);
    expect(script).not.toMatch(/apt-get update(?! -qq --error-on=any)/);
    expect(script).toContain('Acquire::http::Timeout "30";');
  });

  it('gives what E2B projects expect: pip outside a virtualenv, venv, python, the -dev libraries and gh', () => {
    for (const pkg of ['python3-pip', 'python3-venv', 'python3-dev', 'python-is-python3', 'build-essential', 'libssl-dev',
      'libffi-dev', 'libpq-dev', 'imagemagick', 'gh', 'wget', 'git'])
      expect(script).toMatch(new RegExp(`[ \\\\]${pkg.replace(/[.+]/g, '\\$&')}( |\\\\|\\n)`));
    expect(script).toContain('break-system-packages = true');
  });

  it('names the step that failed when run, also through retry', () => {
    // The script's own ERR trap and retry, around a step that fails as Chrome's install did.
    const lines = script.split('\n');
    const trap = lines.find((line) => line.startsWith("trap '") && line.endsWith(' ERR'))!;
    const start = lines.findIndex((line) => line.startsWith('retry() {'));
    const retry = lines.slice(start, lines.indexOf('}', start) + 1).join('\n');
    expect(trap).toBeDefined();
    const run = (step: string) => {
      try {
        execFileSync('bash', ['-c', `set -euo pipefail\n${trap}\nsleep() { :; }\n${retry}\necho 'Setting up git (1:2.39.5) ...'\n`
          + `missing() { echo 'E: Unable to locate package google-chrome-stable'; return 100; }\n${step}\necho never`],
        { stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (error) {
        const failed = error as { stdout: Buffer; stderr: Buffer; status: number };
        return { status: failed.status, log: failed.stdout.toString() + failed.stderr.toString() };
      }
      throw new Error('the step did not fail');
    };
    const direct = run('ls /nonexistent/google-chrome');
    expect(direct.status).toBe(2);
    expect(vmProvisionFailure(direct.log, 2)).toBe('`ls /nonexistent/google-chrome` exited with status 2:\n'
      + "ls: cannot access '/nonexistent/google-chrome': No such file or directory");
    const retried = run('retry missing google-chrome-stable');
    expect(retried.status).toBe(1);
    expect(retried.log.match(/Unable to locate/g)).toHaveLength(4);
    // A fallback that worked does not take the blame for a later step.
    const fellBack = run('retry missing first || true\nls /nonexistent/later');
    expect(vmProvisionFailure(fellBack.log, 2)).toMatch(/^`ls \/nonexistent\/later` exited with status 2:/);
    expect(vmProvisionFailure(retried.log, 1)).toBe('`missing google-chrome-stable` exited with status 1:\n'
      + 'E: Unable to locate package google-chrome-stable\n' + [1, 2, 3, 4].map((n) => `attempt ${n} failed: missing google-chrome-stable`).join('\n'));
  });
});

describe('vmProvisionFailure', () => {
  // The log of pramana#39's last attempt, abridged.
  const pramana39 = [
    ...['libasan8:amd64', 'git-man', 'libtsan2:amd64', 'perl', 'jq', 'git', 'g++', 'build-essential'].map((pkg) => `Setting up ${pkg} ...`),
    "update-alternatives: using /usr/bin/g++ to provide /usr/bin/c++ (c++) in auto mode",
    'Processing triggers for man-db (2.11.2-2) ...',
    'W: Failed to fetch http://dl.google.com/linux/chrome/deb/dists/stable/InRelease  Connection failed [IP: 2a00:1450:4001:c15::5b 80]',
    'W: Some index files failed to download. They have been ignored, or old ones used instead.',
    'E: Unable to locate package google-chrome-stable',
    'E: Unable to locate package google-chrome-stable',
    'karmax provisioning failed (status 1): apt-get install -y -qq --no-install-recommends google-chrome-stable',
    'karmax provisioning failed (status 1): return 1',
  ].join('\r\n');

  it('leads with the failed step and the lines that read as errors, not package output', () => {
    expect(vmProvisionFailure(pramana39, 1)).toBe([
      '`apt-get install -y -qq --no-install-recommends google-chrome-stable` exited with status 1:',
      'W: Failed to fetch http://dl.google.com/linux/chrome/deb/dists/stable/InRelease  Connection failed [IP: 2a00:1450:4001:c15::5b 80]',
      'W: Some index files failed to download. They have been ignored, or old ones used instead.',
      'E: Unable to locate package google-chrome-stable',
    ].join('\n'));
  });

  it('falls back to the end of the log when nothing reads as an error', () => {
    expect(vmProvisionFailure('one\ntwo\nbroken\n', 3)).toBe('the script exited with status 3:\none\ntwo\nbroken');
  });
});
