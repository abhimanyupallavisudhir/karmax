# Speech-to-text evaluation: which model transcribes dictation

Where the browser has no speech recognizer of its own (the desktop app's Electron, Firefox), the console records each
phrase and sends it to `POST /api/speech/transcriptions` (`src/agent/transcription.ts`), which transcribes it through
OpenRouter's `/audio/transcriptions`. This measures which of OpenRouter's transcription models to use.
Results and the choice are in the wiki: `features/push-and-voice` § Server-side dictation.

## What it measures

- **Clips** (`clips/`, 48, made by `run.mjs clips`): 8 English requests a tavya user would dictate, full of the
  product's jargon (tavya, karmax, krmax, panagent, PR, Postgres, E2B, CI, Temporal, R2, OpenRouter, npm, GitHub,
  Claude Code, Hetzner, Fly.io, README, "stop listening"), each in 3 synthetic voices from two engines (OpenAI
  `gpt-4o-mini-tts` alloy and onyx; ElevenLabs Flash v2.5 through OpenRouter, so no recognizer is judged only on its own
  vendor's voice), clean and with pink room noise at about 15 dB SNR. Encoded as the console sends them: webm/Opus,
  mono, 48 kHz, 24 kb/s (`ffmpeg`, `libopus`).
- **Variants**: `plain`; `hint` (OpenRouter's `prompt`: the vocabulary as a sentence; honoured by OpenAI-style models
  only); `keyterms` (OpenRouter's `keyterms` list, for recognizers that boost words: AssemblyAI, ElevenLabs, Mistral,
  xAI, OpenAI's gpt-transcribe, Gemini). Each with `provider: {zdr: true}` first; a model with no zero-retention
  route is run without it and marked.
- **Scores** (`run.mjs summary`): word error rate after normalising case and punctuation (and spellings of PR, E2B,
  Fly.io, numbers), separately on the noisy clips; the share of jargon terms spoken that came back exactly; latency
  from request to answer (median and p90, sequential requests from a 2-CPU sandbox in Europe); price per minute from
  OpenRouter's reported `usage.cost`.
- Silence: 3 s of pink noise and of near silence, twice each, on the finalists (a recognizer that writes "Thank
  you." or "[silence]" into a message is worse than one that misses a word).

## Run it

```bash
node scripts/speech-eval/run.mjs clips                       # OPENAI_API_KEY, OPENROUTER_KEY, ffmpeg
node scripts/speech-eval/run.mjs run [model …]               # appends results/<date>.jsonl (VARIANTS=plain,hint,keyterms)
node scripts/speech-eval/run.mjs summary [results/<file>]    # the table
```

The 2026-11-28 run (`results/2026-11-28.jsonl`, `results/2026-11-28-summary.md`): 14 models, 1,590 requests,
$0.47 of OpenRouter credit.

## Limits

Synthetic voices are cleaner and more regular than people: absolute error rates are lower than with real speakers,
accents and microphones. The ranking, the jargon misses and latency carry over; re-run with recordings of real
people when some exist (drop them into `clips/` and `index.json`).
