import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

it.runIf(process.env.KARMAX_TEST_PASS_BROWSER === '1')('rejects private hosted remotes and imports through the self-hosted browser over authenticated HTTPS', async () => {
  const { stdout } = await promisify(execFile)(process.execPath, ['--import', 'tsx', 'tests/fixtures/git-pass-browser.ts'],
    { timeout: 240_000, maxBuffer: 4 * 1024 * 1024 });
  const result = JSON.parse(stdout.trim().split('\n').at(-1)!);
  expect(result).toEqual({ browserLogin: true, hostedPrivateRemoteRejected: true, selfHostedGateway: true, tlsVerified: true, gitChallengeResponse: true,
    gpgAndAgeMountImport: true, totpResolution: true, authenticatedGitPush: true, typedExportsAndRetry: true, failedReplacementPreservesConnection: true, browserErrors: 0 });
}, 250_000);
