#!/usr/bin/env node
// Speech-to-text evaluation: which OpenRouter transcription model serves
// dictation (POST /api/speech/transcriptions; wiki features/push-and-voice
// § Server-side dictation). README.md says what it measures and how.
//
//   node scripts/speech-eval/run.mjs clips            # make the clips (needs ffmpeg, OPENAI_API_KEY, OPENROUTER_KEY)
//   node scripts/speech-eval/run.mjs run [models…]    # transcribe every clip with each model → results/<date>.jsonl
//   node scripts/speech-eval/run.mjs summary [file]   # table: accuracy, jargon, latency, $/min
//   node scripts/speech-eval/run.mjs silence [models…] # what each model writes for a phrase of no speech
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const clipsDir = path.join(here, 'clips');
const resultsDir = path.join(here, 'results');
const OPENROUTER = 'https://openrouter.ai/api/v1';
const key = process.env.OPENROUTER_KEY || process.env.OPENROUTER_API_KEY;

/** What a tavya user dictates: English with the product's own jargon. */
export const PROMPTS = [
  'Open a PR against the karmax repo that fixes the Postgres migration, then ask tavya to review it.',
  'The task is stuck in Review because the E2B sandbox ran out of disk, so resize the computer.',
  'Merge the panagent branch once CI passes and deploy it to staging.',
  'Add a Temporal activity that saves the world checkpoint to R2, and update the wiki page about OpenRouter.',
  'Please rebase onto master, run npm test, and push the branch to GitHub.',
  'Why does the Claude Code login keep failing on Hetzner and Fly.io?',
  'Rename the krmax wiki section and link it from the README in the panagent repo.',
  'Give the Postgres project five dollars of compute credit. Stop listening.',
];
/** The words that matter most: a wrong one makes the message wrong. */
export const JARGON = ['PR', 'karmax', 'Postgres', 'tavya', 'E2B', 'panagent', 'CI', 'Temporal', 'R2', 'wiki', 'OpenRouter',
  'npm', 'GitHub', 'Claude Code', 'Hetzner', 'Fly.io', 'krmax', 'README', 'rebase', 'stop listening'];
/** The vocabulary hint tavya sends (src/agent/transcription.ts TRANSCRIPTION_HINT). */
export const HINT = 'tavya, karmax, krmax, panagent, PR, Postgres, E2B, OpenRouter, Temporal, R2, CI, npm, GitHub, Claude Code, Codex, Hetzner, Fly.io, README, wiki.';

/** The same vocabulary as key terms, for recognizers that take a list instead of a prompt. */
export const KEYTERMS = HINT.replace(/\.$/, '').split(', ');

/** Voices: two engines, so no recognizer is judged only on its own vendor's voice. */
const VOICES = [
  { id: 'openai-alloy', engine: 'openai', voice: 'alloy' },
  { id: 'openai-onyx', engine: 'openai', voice: 'onyx' },
  { id: 'eleven', engine: 'openrouter', model: 'elevenlabs/eleven-flash-v2.5' },
];

async function tts(voice, text) {
  if (voice.engine === 'openai') {
    const response = await fetch('https://api.openai.com/v1/audio/speech', { method: 'POST',
      headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o-mini-tts', voice: voice.voice, input: text, response_format: 'wav' }) });
    if (!response.ok) throw new Error(`OpenAI TTS ${response.status}: ${await response.text()}`);
    return { bytes: Buffer.from(await response.arrayBuffer()), ext: 'wav' };
  }
  const models = await (await fetch(`${OPENROUTER}/models?output_modalities=speech`)).json();
  const entry = models.data.find((m) => m.id === voice.model);
  const response = await fetch(`${OPENROUTER}/audio/speech`, { method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: voice.model, input: text, voice: entry?.supported_voices?.[0], response_format: 'mp3' }) });
  if (!response.ok) throw new Error(`OpenRouter TTS ${response.status}: ${await response.text()}`);
  return { bytes: Buffer.from(await response.arrayBuffer()), ext: 'mp3' };
}

/** Each prompt in each voice, as the console sends it: webm/opus, mono, 24 kb/s
 * (what MediaRecorder makes), clean and with room noise at ~15 dB SNR. */
async function makeClips() {
  fs.mkdirSync(clipsDir, { recursive: true });
  const index = [];
  for (const [n, text] of PROMPTS.entries()) for (const voice of VOICES) {
    const base = `p${n + 1}-${voice.id}`;
    const raw = path.join(clipsDir, `${base}.raw`);
    if (!fs.existsSync(path.join(clipsDir, `${base}-clean.webm`))) {
      const { bytes } = await tts(voice, text);
      fs.writeFileSync(raw, bytes);
      execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', raw, '-ac', '1', '-ar', '48000', '-c:a', 'libopus', '-b:a', '24k', path.join(clipsDir, `${base}-clean.webm`)]);
      execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', raw, '-f', 'lavfi', '-i', 'anoisesrc=color=pink:amplitude=0.04:seed=7',
        '-filter_complex', '[0:a]aformat=channel_layouts=mono,aresample=48000[v];[1:a]aformat=channel_layouts=mono,aresample=48000[n];[v][n]amix=inputs=2:duration=first:normalize=0',
        '-ac', '1', '-c:a', 'libopus', '-b:a', '24k', path.join(clipsDir, `${base}-noisy.webm`)]);
      fs.rmSync(raw);
    }
    for (const condition of ['clean', 'noisy']) {
      const file = `${base}-${condition}.webm`;
      const seconds = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path.join(clipsDir, file)]).toString().trim());
      index.push({ file, prompt: n + 1, voice: voice.id, condition, seconds, text });
    }
  }
  fs.writeFileSync(path.join(clipsDir, 'index.json'), JSON.stringify(index, null, 1));
  console.log(`${index.length} clips in ${clipsDir}`);
}

export const DEFAULT_MODELS = [
  'openai/whisper-large-v3-turbo', 'openai/whisper-large-v3', 'openai/gpt-4o-mini-transcribe', 'openai/gpt-4o-transcribe',
  'openai/gpt-transcribe', 'nvidia/parakeet-tdt-0.6b-v3', 'nvidia/nemotron-3.5-transcribe', 'qwen/qwen3-asr-1.7b',
  'mistralai/voxtral-mini-transcribe-3-0', 'elevenlabs/scribe-v2', 'deepgram/nova-3', 'google/gemini-3.5-transcribe',
  'x-ai/grok-stt-2.0', 'assemblyai/universal-3-6-pro',
];

async function transcribe(model, clip, { variant, zdr }) {
  const hint = variant === 'hint';
  const audio = fs.readFileSync(path.join(clipsDir, clip.file)).toString('base64');
  const body = { model, input_audio: { data: audio, format: 'webm' }, language: 'en',
    ...(hint ? { prompt: HINT } : {}), ...(variant === 'keyterms' ? { keyterms: KEYTERMS } : {}), ...(zdr ? { provider: { zdr: true } } : {}) };
  const started = performance.now();
  const response = await fetch(`${OPENROUTER}/audio/transcriptions`, { method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
  const ms = Math.round(performance.now() - started);
  const text = await response.text();
  if (!response.ok) return { ok: false, status: response.status, error: text.slice(0, 300), ms };
  const data = JSON.parse(text);
  return { ok: true, ms, text: data.text ?? '', cost: data.usage?.cost, billedSeconds: data.usage?.seconds, provider: response.headers.get('x-openrouter-provider') ?? undefined };
}

async function run(models) {
  const clips = JSON.parse(fs.readFileSync(path.join(clipsDir, 'index.json'), 'utf8'));
  fs.mkdirSync(resultsDir, { recursive: true });
  const out = path.join(resultsDir, `${new Date().toISOString().slice(0, 10)}.jsonl`);
  const variants = (process.env.VARIANTS || 'plain,hint,keyterms').split(',');
  for (const model of models) for (const variant of variants) {
    // ZDR first; a model with no zero-retention route is measured without it (and marked).
    let zdr = true;
    for (const clip of clips) {
      let result = await transcribe(model, clip, { variant, zdr });
      if (!result.ok && zdr && /zdr|zero data|no endpoints|data policy|No allowed providers/i.test(result.error)) {
        zdr = false;
        result = await transcribe(model, clip, { variant, zdr });
      }
      const row = { model, variant, zdr, clip: clip.file, prompt: clip.prompt, voice: clip.voice, condition: clip.condition, seconds: clip.seconds, ...result };
      fs.appendFileSync(out, `${JSON.stringify(row)}\n`);
      process.stdout.write(result.ok ? '.' : `x(${result.status})`);
      if (!result.ok && result.status === 400) break; // the model refuses the request itself (e.g. no prompt support)
    }
    process.stdout.write(` ${model} ${variant}\n`);
  }
  console.log(`→ ${out}`);
}

// ── scoring ──────────────────────────────────────────────────────────────────
const NUMBERS = { five: '5' };
export function normalize(text) {
  return ` ${String(text).toLowerCase()
    .replace(/fly\.io/g, 'flyio').replace(/\bp\.?\s?r\.?(?=\s|$|[,.!?])/g, 'pr').replace(/\be2b\b|\be 2 b\b|\be to b\b/g, 'e2b')
    .replace(/[’']/g, '').replace(/[^a-z0-9$ ]+/g, ' ')
    .split(/\s+/).filter(Boolean).map((word) => NUMBERS[word] ?? word).join(' ')} `;
}
function wer(reference, hypothesis) {
  const r = normalize(reference).trim().split(' '), h = normalize(hypothesis).trim().split(' ').filter(Boolean);
  const d = Array.from({ length: r.length + 1 }, (_, i) => [i, ...Array(h.length).fill(0)]);
  for (let j = 1; j <= h.length; j++) d[0][j] = j;
  for (let i = 1; i <= r.length; i++) for (let j = 1; j <= h.length; j++)
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (r[i - 1] === h[j - 1] ? 0 : 1));
  return { errors: d[r.length][h.length], words: r.length };
}
function jargon(reference, hypothesis) {
  const said = JARGON.filter((term) => normalize(reference).includes(normalize(term)));
  return { said: said.length, right: said.filter((term) => normalize(hypothesis).includes(normalize(term))).length,
    missed: said.filter((term) => !normalize(hypothesis).includes(normalize(term))) };
}
const median = (values) => { const s = [...values].sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : NaN; };
const p90 = (values) => { const s = [...values].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.ceil(s.length * 0.9) - 1)] : NaN; };

function summary(file) {
  // Each clip's length from the index (rows before 2026-11-28's fix lost it to usage.seconds).
  const lengths = Object.fromEntries(JSON.parse(fs.readFileSync(path.join(clipsDir, 'index.json'), 'utf8')).map((clip) => [clip.file, clip.seconds]));
  const rows = fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line)).map((row) => ({ ...row, seconds: lengths[row.clip] }));
  const texts = Object.fromEntries(PROMPTS.map((text, n) => [n + 1, text]));
  const groups = new Map();
  for (const row of rows) { const k = `${row.model}|${row.variant}`; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(row); }
  const lines = [];
  for (const [k, group] of groups) {
    const ok = group.filter((row) => row.ok);
    if (!ok.length) { lines.push({ k, failed: group[0]?.error?.slice(0, 80) }); continue; }
    let errors = 0, words = 0, said = 0, right = 0, noisyErr = 0, noisyWords = 0;
    const missed = {};
    for (const row of ok) {
      const w = wer(texts[row.prompt], row.text); errors += w.errors; words += w.words;
      if (row.condition === 'noisy') { noisyErr += w.errors; noisyWords += w.words; }
      const j = jargon(texts[row.prompt], row.text); said += j.said; right += j.right;
      for (const m of j.missed) missed[m] = (missed[m] ?? 0) + 1;
    }
    const seconds = ok.reduce((s, row) => s + row.seconds, 0), cost = ok.reduce((s, row) => s + (row.cost ?? 0), 0);
    lines.push({ k, n: `${ok.length}/${group.length}`, zdr: group[0].zdr, wer: errors / words, noisyWer: noisyErr / noisyWords, jargon: right / said,
      ms: median(ok.map((row) => row.ms)), p90: p90(ok.map((row) => row.ms)), perMin: cost / seconds * 60,
      missed: Object.entries(missed).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([t, c]) => `${t}×${c}`).join(', ') });
  }
  lines.sort((a, b) => (a.failed ? 1 : 0) - (b.failed ? 1 : 0) || (a.wer - b.wer));
  console.log('| Model | Variant | OK | ZDR | WER | WER noisy | Jargon right | Latency median / p90 | $ per minute | Most missed |');
  console.log('|---|---|---|---|---|---|---|---|---|---|');
  for (const l of lines) {
    const [model, variant] = l.k.split('|');
    if (l.failed) { console.log(`| ${model} | ${variant} | refused: ${l.failed.replace(/\|/g, '/')} |||||||| `); continue; }
    console.log(`| ${model} | ${variant} | ${l.n} | ${l.zdr ? 'yes' : 'no'} | ${(l.wer * 100).toFixed(1)}% | ${(l.noisyWer * 100).toFixed(1)}% | ${(l.jargon * 100).toFixed(0)}% | ${(l.ms / 1000).toFixed(2)} / ${(l.p90 / 1000).toFixed(2)} s | $${l.perMin.toFixed(5)} | ${l.missed} |`);
  }
}

/** A recognizer that writes "Thank you." into a message on a cough or a fan is worse than one
 * that misses a word: 3 s of pink room noise and of near silence, twice each. */
const FINALISTS = ['assemblyai/universal-3-6-pro', 'mistralai/voxtral-mini-transcribe-3-0', 'elevenlabs/scribe-v2', 'openai/gpt-transcribe'];
async function silence(models) {
  const clips = [
    ['silence-noise.webm', 'anoisesrc=color=pink:amplitude=0.04:seed=11:duration=3'],
    ['silence-quiet.webm', 'anoisesrc=color=white:amplitude=0.002:seed=13:duration=3'],
  ];
  for (const [file, source] of clips) if (!fs.existsSync(path.join(clipsDir, file)))
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', source, '-ac', '1', '-ar', '48000', '-c:a', 'libopus', '-b:a', '24k', path.join(clipsDir, file)]);
  const out = path.join(resultsDir, `${new Date().toISOString().slice(0, 10)}-silence.jsonl`);
  for (const model of models) for (const [file] of clips) for (let attempt = 0; attempt < 2; attempt++) {
    const result = await transcribe(model, { file }, { variant: 'keyterms', zdr: model !== 'openai/gpt-transcribe' });
    const row = { model, clip: file, ...result };
    fs.appendFileSync(out, `${JSON.stringify(row)}\n`);
    console.log(`${model} ${file}: ${result.ok ? JSON.stringify(result.text) : `x(${result.status}) ${result.error}`}`);
  }
}

const [command, ...rest] = process.argv.slice(2);
if (command === 'clips') await makeClips();
else if (command === 'run') await run(rest.length ? rest : DEFAULT_MODELS);
else if (command === 'summary') summary(rest[0] ?? path.join(resultsDir, fs.readdirSync(resultsDir).filter((f) => f.endsWith('.jsonl')).sort().pop()));
else if (command === 'silence') await silence(rest.length ? rest : FINALISTS);
else if (command) console.error('usage: run.mjs clips | run [models…] | summary [file] | silence [models…]');
