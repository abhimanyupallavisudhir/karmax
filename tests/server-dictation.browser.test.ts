// Dictation where the browser has no recognizer (wiki features/push-and-voice
// § Server-side dictation): Chromium with Web Speech removed, as in the desktop
// app's Electron and in Firefox. The microphone is a fake stream the test
// speaks into (a tone switched on and off); the console cuts it into phrases at
// each pause and posts them to the real gateway, which transcribes them through
// a stubbed OpenRouter on the organization's credit. Words land phrase by
// phrase, "…" shows while one is on its way, "stop listening" ends it, and a
// refusal or a lost connection shows one toast.
// Screens: KARMAX_SHOTS=<dir> npx vitest run tests/server-dictation.browser.test.ts
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Browser, Page } from 'playwright';
import { saveIncludedModel } from '../src/agent/included-model.js';
import { computeCredit, startComputeTrial } from '../src/world/managed-compute.js';
import { consoleRequest, hostedGateway, launchChromium, openConsole, signIn, type HostedGateway } from './helpers/browser.js';

let browser: Browser, g: HostedGateway, openRouter: http.Server;
const PASSWORD = 'correct horse battery staple 42';
const SHOTS = process.env.KARMAX_SHOTS;
const shot = async (page: Page, name: string, clip: string) => {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.locator(clip).first().screenshot({ path: path.join(SHOTS, `${name}.png`) });
};

/** What the stubbed recognizer hears, phrase by phrase, and what it was sent. */
const transcripts: string[] = [];
const received: Array<{ format: string; bytes: number; language?: string }> = [];
let usage = 0;
/** How long each transcription takes, so "…" can be seen. */
const DELAY_MS = 700;

/** In the page: no Web Speech, and a microphone the test speaks into. */
function fakeMicrophone() {
  const w = globalThis as any;
  Object.defineProperty(w, 'SpeechRecognition', { value: undefined, configurable: true });
  Object.defineProperty(w, 'webkitSpeechRecognition', { value: undefined, configurable: true });
  w.__mic = { opened: 0, live: 0 };
  w.navigator.mediaDevices.getUserMedia = async () => {
    const context = new w.AudioContext();
    const tone = context.createOscillator();
    tone.frequency.value = 220;
    const gain = context.createGain();
    gain.gain.value = 0;
    const out = context.createMediaStreamDestination();
    tone.connect(gain).connect(out);
    tone.start();
    w.__voice = (on: boolean) => gain.gain.setValueAtTime(on ? 0.4 : 0, context.currentTime);
    w.__mic.opened++; w.__mic.live++;
    for (const track of out.stream.getTracks()) {
      const stop = track.stop.bind(track);
      track.stop = () => { if (track.readyState === 'live') w.__mic.live--; stop(); };
    }
    return out.stream;
  };
}

beforeAll(async () => {
  openRouter = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const send = (status: number, value: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
      const body = raw ? JSON.parse(raw) : undefined;
      if (req.url === '/models?output_modalities=transcription') return send(200, { data: [] });
      if (req.url!.startsWith('/keys')) {
        if (req.method === 'POST') return send(201, { data: { hash: 'h1' }, key: 'sk-or-h1' });
        return send(200, { data: { usage, limit: null } });
      }
      if (req.url === '/audio/transcriptions') {
        received.push({ format: body.input_audio.format, bytes: Buffer.from(body.input_audio.data, 'base64').length, language: body.language });
        usage += 0.0004;
        return setTimeout(() => send(200, { text: transcripts.shift() ?? '', usage: { cost: 0.0004, seconds: 1.2 } }), DELAY_MS);
      }
      send(404, { error: { message: `no route ${req.url}` } });
    });
  });
  await new Promise<void>((resolve) => openRouter.listen(0, '127.0.0.1', () => resolve()));
  process.env.KARMAX_OPENROUTER_API_URL = `http://127.0.0.1:${(openRouter.address() as AddressInfo).port}`;
  browser = await launchChromium({ args: ['--autoplay-policy=no-user-gesture-required'] });
  g = await hostedGateway(async ({ store, broker }) => { await saveIncludedModel(store, broker, { managementKey: 'mgmt-key' }); return {}; });
}, 60_000);
afterAll(async () => {
  await g?.close(); await browser?.close();
  delete process.env.KARMAX_OPENROUTER_API_URL;
  await new Promise((resolve) => openRouter?.close(resolve));
});

it('dictates phrase by phrase through the server where the browser has no recognizer, on the credit, and ends on "stop listening"', async () => {
  const { user, organization } = await g.owner({ name: 'Ada', email: 'ada@example.test', password: PASSWORD, organization: 'Acme' });
  await startComputeTrial(g.store, organization.id, user.id);
  const { page, errors, step, context } = await openConsole(browser, { ip: '192.0.2.91', viewport: { width: 1280, height: 860 } });
  await context.addInitScript(fakeMicrophone);
  try {
    await signIn(context, g.url, 'ada@example.test', PASSWORD);
    await consoleRequest(context, g.url, 'POST', `/api/organizations/${organization.id}/projects`, { name: 'Website' });
    const prompt = page.locator('#tf-body textarea[data-field="prompt"]');
    const mic = page.locator('#tf-body [data-mic="prompt"]');
    const speak = async (ms: number) => {
      await page.evaluate('window.__voice(true)');
      await page.waitForTimeout(ms);
      await page.evaluate('window.__voice(false)');
    };

    await step('the mic is there although the browser recognizes no speech', async () => {
      await page.goto(`${g.url}/acme/website`);
      expect(await page.evaluate('typeof window.SpeechRecognition + typeof window.webkitSpeechRecognition')).toBe('undefinedundefined');
      await page.locator('#expand-task').click();
      await mic.waitFor();
      expect(await mic.getAttribute('aria-label')).toBe('Dictate');
    });

    await step('a phrase is sent at the pause after it, "…" shows while it is transcribed, then its words', async () => {
      transcripts.push('Fix the login page.', 'And its footer.', 'Stop listening.');
      await prompt.click();
      await mic.click();
      expect(await mic.getAttribute('aria-pressed')).toBe('true');
      await expect.poll(() => page.evaluate('window.__mic.live')).toBe(1);
      await speak(900);
      await expect.poll(() => mic.evaluate((button) => button.classList.contains('transcribing')), { timeout: 5_000 }).toBe(true);
      await shot(page, 'server-dictation-transcribing', '#tf-body .prompt-field');
      await expect.poll(() => prompt.inputValue(), { timeout: 5_000 }).toBe('Fix the login page.');
      expect(await mic.evaluate((button) => button.classList.contains('transcribing'))).toBe(false);
      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({ format: 'webm', language: 'en' });
      expect(received[0]!.bytes).toBeGreaterThan(500);
    });

    await step('the next phrase follows it; listening goes on between phrases', async () => {
      await page.waitForTimeout(400);
      await speak(700);
      await expect.poll(() => prompt.inputValue(), { timeout: 5_000 }).toBe('Fix the login page. And its footer.');
      expect(await mic.getAttribute('aria-pressed')).toBe('true');
      expect(await page.evaluate('window.__mic.opened')).toBe(1);
      await shot(page, 'server-dictation-words', '#tf-body .prompt-field');
    });

    await step('"stop listening" ends it, is never typed, and lets go of the microphone', async () => {
      await page.waitForTimeout(400);
      await speak(600);
      await expect.poll(() => mic.getAttribute('aria-pressed'), { timeout: 5_000 }).toBe('false');
      expect(await prompt.inputValue()).toBe('Fix the login page. And its footer.');
      await expect.poll(() => page.evaluate('window.__mic.live')).toBe(0);
      expect(received).toHaveLength(3);
    });

    await step('a phrase said just before the mic is tapped off still lands', async () => {
      transcripts.push('Today.');
      await prompt.press('End');
      await mic.click();
      await expect.poll(() => page.evaluate('window.__mic.live')).toBe(1);
      await page.evaluate('window.__voice(true)');
      await page.waitForTimeout(600);
      await mic.click(); // mid-word
      await page.evaluate('window.__voice(false)');
      expect(await mic.getAttribute('aria-pressed')).toBe('false');
      await expect.poll(() => prompt.inputValue(), { timeout: 5_000 }).toBe('Fix the login page. And its footer. Today.');
      await expect.poll(() => page.evaluate('window.__mic.live')).toBe(0);
    });

    await step('silence is never sent', async () => {
      const sent = received.length;
      await mic.click();
      await page.waitForTimeout(2_600); // past the idle restart
      await mic.click();
      expect(received).toHaveLength(sent);
    });

    await step('what it cost is on the organization\'s credit', async () => {
      await expect.poll(async () => (await computeCredit(g.store, organization.id)).usedMicros, { timeout: 5_000 }).toBeGreaterThan(0);
      expect((await computeCredit(g.store, organization.id)).heldMicros).toBe(0);
    });

    await step('without a connection: one toast, and dictation ends', async () => {
      await context.setOffline(true);
      await mic.click();
      await expect.poll(() => page.locator('.toast.err', { hasText: 'Dictation needs a connection.' }).count()).toBe(1);
      expect(await mic.getAttribute('aria-pressed')).toBe('false');
      await context.setOffline(false);
    });
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

it('says once that the credit is spent, and stops', async () => {
  await g.owner({ name: 'Bo', email: 'bo@example.test', password: PASSWORD, organization: 'Broke' });
  const { page, errors, step, context } = await openConsole(browser, { ip: '192.0.2.92', viewport: { width: 1280, height: 860 } });
  await context.addInitScript(fakeMicrophone);
  try {
    await signIn(context, g.url, 'bo@example.test', PASSWORD);
    const organization = (await g.store.listOrganizations()).find((entry) => entry.name === 'Broke')!;
    await consoleRequest(context, g.url, 'POST', `/api/organizations/${organization.id}/projects`, { name: 'Site' });
    const mic = page.locator('#tf-body [data-mic="prompt"]');
    await step('Out of credits: one short toast, the mic off and let go', async () => {
      const sent = received.length;
      await page.goto(`${g.url}/broke/site`);
      await page.locator('#expand-task').click();
      await mic.click();
      await expect.poll(() => page.evaluate('window.__mic.live')).toBe(1);
      for (const ms of [700, 700]) {
        await page.evaluate('window.__voice(true)'); await page.waitForTimeout(ms); await page.evaluate('window.__voice(false)');
        await page.waitForTimeout(900);
      }
      await expect.poll(() => page.locator('.toast.err', { hasText: 'Out of credits to dictate' }).count()).toBe(1);
      await expect.poll(() => mic.getAttribute('aria-pressed')).toBe('false');
      await expect.poll(() => page.evaluate('window.__mic.live')).toBe(0);
      expect(received).toHaveLength(sent); // refused before OpenRouter heard anything
      await shot(page, 'server-dictation-out-of-credit', 'body');
    });
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});
