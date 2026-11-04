# Launch video

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
its first frame, which is the film's own first frame, so the film loops. Copy
a render to `/tmp/demo/assets/launch-v1.mp4` and record again for the final cut.

## Pieces

| File | What it does |
| --- | --- |
| `fetch.py` | The production snapshot, filtered through the wiki's private list. |
| `build.sh`, `setup.cjs`, `seed-*.{cjs,py}` | A fresh home: the owner, 16 projects in their folders, every visible task at its real number, the project wiki, the brand icon, a card, Gmail and Search Console accounts to allow, a CLI token. |
| `script.py` | What each demo agent does and says. The CV, SEO and release-trigger messages mirror real runs (personal-website #7, tavya #821, #822). |
| `stage.js` | The stage: backdrop, a browser window holding the console, captions, cursor, camera, title card, terminal, checklist. |
| `director.cjs` | The take. Each `mark(name, speed)` sets the playback speed from there on (waits run ×3–5). |
| `edit.py`, `music.py` | Frames retimed onto 60 fps H.264; a synthesised music bed. |

## Safety

The demo server runs with an emptied environment (no host API keys, no Claude
login; dummy keys only so Accounts look normal), and the recording browser
rewrites every agent `provider` in requests to `mock`. A take cannot reach a
real model or spend anything; the card is a test card on the local vault rail.
