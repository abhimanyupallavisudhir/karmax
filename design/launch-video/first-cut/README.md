# Launch video — first cut (the final version, 59 s, dark compositor)

The owner's final pick (2026-11-06): this cut, with the "VS Code was a fancy text editor…"
scene removed, the title card's tagline "The agentic to-do list that finishes itself." (the
end card keeps "Just do things."), and "Work that starts itself." renamed
"The autonomous company." with three boxes under it, and three boxes under "Every project.
One list." instead of its subtitle. Without the screens below, `patch.sh ORIGINAL.mp4 OUT.mp4`
made the 59 s cut from the original 63 s render (it re-renders only what changed and
regenerates the score); with the screens, `make.sh` renders it whole. `strips.sh BASE.mp4 OUT.mp4 FROM:TO …` re-renders only
the strip above the window (headline and boxes) of some scenes over an earlier render.

A 63-second, 1080p/30 fps launch video of tavya, set in the owner's real organization
(Abhimanyu Pallavi Sudhir / `personal`) cloned into a scratch tavya, with friends'
projects left out. Every screen is the real console showing real tasks; the motion,
headlines and score are composited here.

```
export.py      tavya.io → EXPORT_DIR (projects, tasks, views, Review files, activity)   read-only, keep out of git
../private.py  what is never shown: reads the list from the private wiki, ops/launch-video
setup.cjs      first-run administrator of the scratch app
import.py      EXPORT_DIR → the scratch app's SQLite store (ids, numbers, times kept)
hold.sh        unfinished tasks stay "running" for the reconciler (a hold no worker serves)
stage.py       scenes: a task rewound to the moment shown (Working, Review, …)
prepare.sh     import + hold + stage, re-runnable
seed-extras.cjs  task defaults as on tavya.io, stand-in vault items and card (made-up values)
capture.cjs    2x stills, frame sequences and element boxes → ASSETS
stage.html + timeline.js   the composition; seek(t) poses frame t
render.cjs     frames → H.264;  music.py  the synthesized score;  make.sh  both, muxed
```

## Make it

```bash
# scratch app with the mock agent (no model is ever called)
KARMAX_HOME=/home/user/demo/home KARMAX_PORT=48950 KARMAX_AGENT_PROVIDER=mock npx tsx src/main.ts
node design/launch-video/first-cut/setup.cjs                       # once; stores /home/user/demo/state.json
KARMAX_TOKEN=… python3 design/launch-video/first-cut/export.py /home/user/karmax/demo-export
design/launch-video/first-cut/prepare.sh                           # import, hold, stage tidy busy
node design/launch-video/first-cut/seed-extras.cjs
python3 -c "import sqlite3,json;c=sqlite3.connect('/home/user/demo/home/state/karmax.db');c.execute('INSERT OR REPLACE INTO settings VALUES (?,?,?)',('global','appearance',json.dumps({'icon':'royal-gold-arrow'})));c.commit()"  # tavya.io's logo
node design/launch-video/first-cut/capture.cjs                     # → /home/user/demo/assets (+ brand/icon-512.png from web/brand/royal-gold-arrow)
design/launch-video/first-cut/make.sh /home/user/demo/out/tavya-launch.mp4
node design/launch-video/first-cut/render.cjs /tmp/stills --stills 10,20,30   # check single frames
```

Needs ffmpeg, pdftoppm (poppler-utils), Inter (fonts-inter) and numpy + scipy.

## What is staged, and why

The clone is the real data; a few tasks are shown at an earlier moment than now, so
every stage of a task's life appears once: `stage.py` rewinds merged tasks back to Review
(their pull requests reopened, summary "N file(s) changed."), marks four finished tasks
Working, and shows personal-website #5 mid-turn by replaying its real activity events up
to a cut-off (`capture.cjs` filters `/events`). It also drops the "Setup warning" lines
worlds print before the agent starts. The vault and card are stand-ins: the real vault is
personal. The thesis task's conversation is not shown.
