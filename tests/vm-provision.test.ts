import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { vmBootScript, volumeTmpScript, vmProvisionFailure, vmProvisionScript } from '../src/world/vm/provision.js';

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

  // f53f650e6ca76f9f: Fly's 8 GB root disk, kept by persist_rootfs, held 1.1 GB
  // of npm's cache from earlier provisioning versions when it filled.
  it('leaves no download cache on the root disk, after its last install', () => {
    const last = Math.max(script.lastIndexOf('npm install'), script.lastIndexOf('apt-get install'), script.lastIndexOf('playwright install'));
    expect(script.indexOf('npm cache clean --force')).toBeGreaterThan(last);
    expect(script.indexOf('apt-get clean')).toBeGreaterThan(last);
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

/** Mounting needs a mount namespace of our own; CI images may forbid one. */
const namespaces = spawnSync('unshare', ['-rm', 'true']).status === 0;

/**
 * f53f650e6ca76f9f (2026-11-09): a VM world's /tmp was on its small root disk,
 * which tavya never measures. The session holder keeps every process's state
 * there, so a full /tmp failed "could not start the process in the VM (status
 * 1)", and Bigger disk would have grown the volume, not the disk that was full.
 */
describe('VM /tmp on the world\'s volume', () => {
  it('is part of every boot, after the volume is mounted and before sshd lets anyone in', () => {
    for (const foreground of [false, true]) {
      const boot = vmBootScript({ foreground });
      const at = boot.indexOf(volumeTmpScript('/home/user'));
      expect(at).toBeGreaterThan(boot.indexOf('mount /home/user'));
      expect(at).toBeLessThan(boot.indexOf('touch "$K/booted"'));
    }
  });

  it.skipIf(!namespaces)('puts /tmp on the volume, emptied at each boot, and leaves a machine without a volume alone', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-vm-tmp-'));
    try {
      const home = path.join(dir, 'home'), tmp = path.join(dir, 'tmp');
      fs.mkdirSync(home); fs.mkdirSync(tmp);
      fs.writeFileSync(path.join(tmp, 'on-root-disk'), '');
      fs.mkdirSync(path.join(tmp, 'pytest-of-user'));
      fs.mkdirSync(path.join(tmp, 'systemd-private-abc-chrony.service-x'));
      const boot = volumeTmpScript(home, tmp);
      // In a namespace of its own: the volume is a filesystem of its own (a
      // tmpfs here), holding the last boot's /tmp; then two boots' scripts run,
      // the second as a repeat within the same boot.
      const run = spawnSync('unshare', ['-rm', 'sh', '-ec', `
        mount -t tmpfs volume ${home}
        mkdir ${home}/.karmax-tmp && touch ${home}/.karmax-tmp/last-boot
        ${boot}
        stat -c %a ${tmp}; ls -A ${tmp}; echo ---
        touch ${tmp}/this-boot
        ${boot}
        ls -A ${tmp}; ls -A ${home}/.karmax-tmp; echo ---
        [ "$(stat -c %d ${tmp})" = "$(stat -c %d ${home})" ] && echo on-volume; echo ---
        umount ${tmp}; ls -A ${tmp}
      `], { encoding: 'utf8' });
      expect(run.stderr).toBe('');
      expect(run.stdout.split('---\n').map((part) => part.trim())).toEqual(['1777', 'this-boot\nthis-boot', 'on-volume',
        // The root disk's /tmp was emptied, not just hidden; services' private ones stay.
        'systemd-private-abc-chrony.service-x']);
      // No volume of its own (an image builder): /tmp stays where it is.
      const builderTmp = path.join(dir, 'builder-tmp');
      fs.mkdirSync(builderTmp);
      fs.writeFileSync(path.join(builderTmp, 'kept'), '');
      const alone = spawnSync('unshare', ['-rm', 'sh', '-ec', `${volumeTmpScript(dir, builderTmp)}\nls -A ${builderTmp}`], { encoding: 'utf8' });
      expect([alone.stdout.trim(), alone.stderr]).toEqual(['kept', '']);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
