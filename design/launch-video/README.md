# Launch video

Three versions live here:

| Version | Where | How it is made |
| --- | --- | --- |
| **First cut — the final version** (0:59, dark) | `first-cut/` | Stills of a clone composited frame by frame (`first-cut/README.md`). |
| Second (≈2:27, light) | this folder | One recorded take of the clone (below); `snappy.sh` makes it. |
| Third (≈1:40, dark) | `third-cut/` | The first cut's compositor and style, new screens captured from this folder's clone (`third-cut/README.md`). |

The second uses this folder's music (`music.py`), the third the first cut's score
(`first-cut/music.py`); both use the tagline "The agentic to-do list that completes itself."; the second's stage (`stage.js`)
draws large headlines over the window and zooms the console inside it.

The launch video is recorded, not animated: a scratch tavya is seeded as a clone
of the personal organization, and a director drives the real console through
the stories in one continuous take. The agents are the mock agent acting out
`script.py`, one entry per prompt (`KARMAX_MOCK_SCRIPT`, see `src/agent/mock.ts`);
everything else (task forms, Review, auto-confirm, app grants, the CLI pushing
and pulling data, merges, the wiki) is the product doing what it does.

What must never be shown (friends' private projects and organizations) is
listed in the private wiki page `ops/launch-video`, not here.

## Make it

```bash
# 1. Snapshot tavya.io: projects, task lists, the real review artifacts the
#    video re-enacts, and the photos. Needs KARMAX_GATEWAY_URL + KARMAX_TOKEN
#    (any tavya task has them) and the wiki checkout (KARMAX_WIKI).
python3 design/launch-video/fetch.py
# 2. Build the clone and snapshot it (/tmp/demo/pristine.tgz).
design/launch-video/build.sh
# 3. One take: restore the snapshot, start it, direct, stop. ~7 minutes.
design/launch-video/record.sh /tmp/demo/take
# 4. Retime it into the film (speeds come from the director's marks) and lay
#    the music under it.
python3 design/launch-video/edit.py /tmp/demo/take /tmp/demo/tavya-launch.mp4
```

The ending zooms into the video a task delivers in its review panel, held on
its first frame, which is the film's own first frame, so the film loops. So a
final cut is two takes (`snappy.sh` does both, with a placeholder for take A's
delivered video): the first becomes `/tmp/demo/assets/launch-v1.mp4`
(the delivered video), the second is the film:

```bash
design/launch-video/record.sh /tmp/demo/takeA && python3 design/launch-video/edit.py /tmp/demo/takeA /tmp/demo/takeA.mp4
cp /tmp/demo/takeA.mp4 /tmp/demo/assets/launch-v1.mp4
design/launch-video/record.sh /tmp/demo/takeB && python3 design/launch-video/edit.py /tmp/demo/takeB /tmp/demo/tavya-launch.mp4
```

### All eight cuts

`all-cuts.sh` makes every version: the snappy and the readable film (a take
recorded with `DEMO_HOLD=1.8`, so every reading pause lasts 1.8× longer, and
edited with `--readable`, so waits and typing are sped up less), each with and
without a voiceover, each in landscape (1920×1080) and portrait (1080×1350).

- `voice.py` speaks one line per scene with OpenAI's `gpt-4o-mini-tts`
  (`OPENAI_API_KEY`; voice `coral`, override with `VO_VOICE`), starting at the
  scene's mark and never over the next line, ducks the music under it and ends
  exactly with the picture. Lines are cached by text in `/tmp/demo/vo-cache`.
- `mobile.py` crops each frame to the square around the action (the camera's
  focus when zoomed, else the cursor), so text is ~1.8× larger on a phone, and
  sets the captions large in their own band. Title card, terminal and grid are
  shown whole.

A take also seeds, off camera, the logins the vault shows (dummies; the
United login the flight task asks for) and pretend documents in admin_docs.

## Pieces

| File | What it does |
| --- | --- |
| `fetch.py` | The production snapshot, filtered through the wiki's private list. |
| `build.sh`, `setup.cjs`, `seed-*.{cjs,py}` | A fresh home: the owner, 16 projects in their folders, every visible task at its real number, the project wiki, the brand icon, a card, Gmail and Search Console accounts to allow, a CLI token. |
| `script.py` | What each demo agent does and says. The CV, SEO and release-trigger messages mirror real runs (personal-website #7, tavya #821, #822). |
| `stage.js` | The stage: backdrop, a browser window holding the console, captions, cursor, camera, title card, terminal, feature grid. |
| `shots.cjs` | Stills of the real console for the feature grid, taken off camera (cut from the film). |
| `director.cjs` | The take. Each `mark(name, speed)` sets the playback speed from there on (waits run ×3–5; 0 cuts). |
| `edit.py`, `music.py` | Frames retimed onto 60 fps H.264; a synthesised music bed. |
| `voice.py`, `mobile.py`, `all-cuts.sh` | The voiceover, the portrait cut, and every cut in one go. |

## Safety

The demo server runs with an emptied environment (no host API keys, no Claude
login; dummy keys only so Accounts look normal), and the recording browser
rewrites every agent `provider` in requests to `mock`. A take cannot reach a
real model or spend anything; the card is a test card on the local vault rail.
