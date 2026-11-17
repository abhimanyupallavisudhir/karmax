# Launch video — final (1:02, dark; landscape and portrait)

The first cut's look (dark backdrop, headlines whose words arrive one by one with a gold
phrase, a browser window with a camera) and its score, with every screen captured fresh
from this folder's demo clone. Owner's structure (2026-11-13):

| # | Scene | What it shows |
| --- | --- | --- |
| 0 | Title: "Do *anything* with agents." | |
| 1 | Every project. *One list.* | pills "Code, apps, websites", "Research", "Random admin work", one at a time |
| 2 | Say *what needs doing.* | no subtitle; the homepage redesign typed into personal-website: "Can you make my homepage design nicer and cleaner? … khaki color look." |
| 3 | Agents work on *their own computers.* | under "GitHub repos, large files and databases, project secrets, MCPs.": that task's real run on tavya.io (`../fetch.py` saves its rows, minus anything private), replayed row by row with every step unfolded, up to "Design is verified on desktop and mobile" |
| 4 | Big jobs *fan out.* | #367's 25 sub-tasks, under "Big tasks can spawn hundreds of sub-tasks with their own agents, all orchestrated by the parent agent." |
| 5 | Give agents *accounts, keys and a card.* | the vault |
| 6 | Review the *result,* and approve. | the launch-video task (started before scene 2, scripted in `../script.py`); large line "(or leave the review to an agent)"; the task's attached mp4 opened (its first frame drawn as this film's title card), then Confirm; the run reads "Worked 2 h 40 min" (the mock's took seconds) |
| 7 | Build the *autonomous company.* | large line "Agents can create, manage and approve tasks." over the autonomous-project toggle (task #918, mocked) and a review route turned to Agent; then "Tasks can auto-run on schedules, events or dependencies." over "Created Task #183: Fix errors in deployment…", then Update dependencies, Maintain the project wiki and Dream (mocked) |
| 8 | Any model. *Your subscription.* | the model picker |
| 9 | Not just *code.* | pills "Papers." "Websites." "Images and video." "Chores.", about 0.65 s apart, with a paper (title page + a page with its figures), tavya.io, an AI image, a film still, the booked flight |
| 10 | End card: "Just do things." | then three quotes, one at a time (N.H., D.A., R.S.; the landing shows the same, `LANDING_QUOTES`) |

```bash
python3 ../fetch.py && bash ../build.sh                          # the clone (DEMO_NO_PHOTOS=1 skips the photos scene's downloads)
FILM=<previous film>.mp4 DIRECTOR=final/capture.cjs bash ../record.sh /tmp/demo/final-assets ['shot-regex']
PAPER=paper.pdf IMAGE=image.png FILM=film.mp4 WEBSITE=landing.png ./extras.sh /tmp/demo/final-assets
./make.sh out.mp4 --workers 4                                    # or --stills 6,30 for single frames
./make.sh portrait.mp4 --portrait --workers 4                    # the portrait cut (1080×1350), same timeline and score
./web.sh out.mp4 ../../../web/media/tavya-launch                  # the landing's web encode (CRF 28) and poster
./scenes.sh previous.mp4 out.mp4 13.6:17.8 25.6:32.0            # re-render some whole scenes into an earlier render (same lengths, its audio)
./splice.sh previous.mp4 out.mp4 55.8                            # only the end card changed: re-render from its start
./restitch.sh previous.mp4 out.mp4 old:0:8.2 new:8.2:22.4 old:21.6:48.8 new:49.6:62   # scenes changed length: new pieces from this timeline, old ones from the earlier render, score regenerated
```

## Portrait (1080×1350)

The phone cut is the same stage rendered with `--portrait` (`stage.html?layout=portrait`;
`LAYOUT=portrait` does the same for `scenes.sh`, `splice.sh` and `restitch.sh`, whose earlier
render must then be a portrait one): the same scenes, timing, words, cursor, camera keyframes
and score, laid out for a phone. `timeline.js` holds both layouts; `WIN` says where the browser
window sits and how much of the 1440×900 screen it shows.

- Headlines, pills and lines sit large in a band at the top (`.band`, 80 px headlines).
- The window fills the width below at scale 1 (a 1032×900 viewport onto the screen), so with
  the landscape camera the console's text is ~1.8× larger relative to the frame. The camera
  aims as in landscape (`at()` measures against the viewport); the typed prompt zooms only as
  far as keeps its lines whole (`fit()`, 1.4× instead of 1.6×).
- The title card, "Not just code" (two columns, the chore below) and the end card (the three
  quotes stacked) have their own arrangement. The review viewer still shows the landscape film.

The stage loads the console's Inter (`web/fonts`), so a render looks the same on any machine.

## Inputs

`capture.cjs` starts every task in the same order whatever it shoots, so task numbers
match between a full capture and a re-shoot. The AI image was made with gpt-image-2 on the
project's OpenAI key; the paper is legibench3's (task_mvik4fo03779021f59, page 4 has its
figures); the website is the landing's first screen (design/landing-v2/shoot.cjs; task #920's
review "Landing: first screen"); the film still is 21 s into task #920's render (the resource's
earlier revision, readable in Files with `?task=` #920). The generated image itself was not
kept: the portrait cut's `IMAGE` is its card cut out of the 1:02 film at 53.5 s (left 1230,
top 270, 590 wide, turned back 2°), so both cuts show the same picture.
