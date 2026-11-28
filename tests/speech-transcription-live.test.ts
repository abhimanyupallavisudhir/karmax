// One real transcription through OpenRouter (wiki features/push-and-voice §
// Server-side dictation): a phrase of webm/opus, as the console records it,
// with tavya's jargon in it. Needs KARMAX_RUN_LIVE=1 and an OpenRouter key
// (OPENROUTER_API_KEY or OPENROUTER_KEY); costs about $0.0006.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { Store } from '../src/store/db.js';
import { Vault } from '../src/autonomy/vault.js';
import { CredentialBroker } from '../src/autonomy/broker.js';
import { organizationScope } from '../src/autonomy/vault-keys.js';
import { TRANSCRIPTION_MODEL, transcribe } from '../src/agent/transcription.js';

const key = process.env.OPENROUTER_API_KEY || process.env.OPENROUTER_KEY;
const live = process.env.KARMAX_RUN_LIVE === '1' && !!key;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-speech-live-'));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

it.skipIf(!live)('transcribes a spoken phrase with tavya\'s jargon on the organization\'s own OpenRouter key', async () => {
  const store = await Store.create(':memory:');
  const broker = new CredentialBroker(new Vault(dir));
  const organization = await store.createOrganization({ name: 'Live', ownerUserId: 'owner' });
  await broker.registerHandle(`openrouter:${organization.id}:main`, key!, organizationScope(organization.id));
  // Its repository's name is a key term, as tavya's own organization has it.
  await store.upsertRepository({ organizationId: organization.id, provider: 'github', owner: 'acme', name: 'karmax',
    sshUrl: 'git@github.com:acme/karmax.git', defaultBranch: 'main', private: true });
  // "Open a PR against the karmax repo that fixes the Postgres migration, then ask tavya to review it."
  const audio = fs.readFileSync(new URL('../scripts/speech-eval/clips/p1-openai-alloy-noisy.webm', import.meta.url));
  const started = Date.now();
  const result = await transcribe({ store, broker }, organization.id, { audio, contentType: 'audio/webm;codecs=opus', language: 'en-US' });
  const ms = Date.now() - started;
  console.log(`[live] ${result.model} in ${ms} ms, $${result.costUsd}: ${result.text}`);
  expect(result).toMatchObject({ funding: 'own', model: TRANSCRIPTION_MODEL });
  expect(result.text.toLowerCase()).toMatch(/\bpr\b/);
  for (const word of ['karmax', 'postgres']) expect(result.text.toLowerCase()).toContain(word);
  expect(result.text).toMatch(/\btavya\b/);
  expect(result.costUsd).toBeLessThan(0.005);
  await store.close();
}, 60_000);
