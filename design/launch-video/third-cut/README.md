# Launch video — third cut (≈1:40, dark)

The first cut's compositor and style (headlines that arrive word by word, a
browser window with a camera, the dark backdrop), extended:

- **…so it can [buy you a website] [put your app on Google Play] [order your groceries]**
  and **The autonomous company: [let AI agents review tasks] [agents can create and
  manage tasks] [work that starts itself]**: the prefix stays, the gold phrase swaps
  with each screen (`swapHeadline`).
- The CV task typed, the photos pushed and pulled from a laptop (`terminal`, the CLI's
  real output), a flight booked, the store's triage / build / repair automations.
- The ending (owner's change, 2026-11-05): **Your turn.** A new project (`big-idea`) is
  created from the + beside Projects, its first task "Build something great." is typed and
  started, then the end card (tagline, tavya.io, "Open to everyone, starting today.").
  The earlier recursive ending (a task delivering this video, the camera falling into its
  first frame) is in git history.
- Music: `../music.py`.

```bash
# The clone (../fetch.py, ../build.sh), then the new screens (≈30 min; a regex re-shoots some):
DIRECTOR=third-cut/capture.cjs bash design/launch-video/record.sh /tmp/demo/v3-assets ['play|flight']
# The first cut's screens (first-cut/README.md) in FIRST, these in NEW; then render:
FIRST=/home/user/demo/assets NEW=/tmp/demo/v3-assets design/launch-video/third-cut/make.sh out.mp4 --workers 4
design/launch-video/third-cut/make.sh /tmp/stills --stills 5,30,90   # single frames
# Changed only the last scenes, without the earlier scenes' screens? Re-render from a
# scene boundary and splice onto the previous render (music regenerated for the new length):
design/launch-video/third-cut/splice.sh previous.mp4 out.mp4 87.6
```

`capture.cjs` starts every task in the same order whatever it shoots, so task
numbers match between a full capture and a re-shoot. The Play Store task asks for a
Google account from the vault, then a Google Play Console connection (seeded in the
clone); the grocery task an Amazon login; all are demo values.
