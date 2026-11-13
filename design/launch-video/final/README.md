# Launch video — final (1:04, dark)

The first cut's look (dark backdrop, headlines whose words arrive one by one with a gold
phrase, a browser window with a camera) and its score, with every screen captured fresh
from this folder's demo clone. Owner's structure (2026-11-13):

| # | Scene | What it shows |
| --- | --- | --- |
| 0 | Title: "Do *anything* with agents." | |
| 1 | Every project. *One list.* | pills "Code, apps, websites", "Research", "Random admin work", one at a time |
| 2 | Say *what needs doing.* | this film's own task typed: "Create a launch video for tavya.io…" |
| 3 | Agents work on *their own computers.* | that task's steps arriving |
| 4 | Big jobs *fan out.* | #367's 25 sub-tasks |
| 5 | Give agents *accounts, keys and a card.* | the vault |
| 6 | Review the *result,* and approve. | large line "(or leave the review to an agent)"; the task's attached mp4 opened (its first frame drawn as this film's title card), then Confirm |
| 7 | Build the *autonomous company.* | large line "Agents can create, manage and approve tasks." over the autonomous-project toggle (task #918, mocked) and a review route turned to Agent; then "Tasks can auto-run on schedules, events or dependencies." over "Created Task #183: Fix errors in deployment…", then Update dependencies, Maintain the project wiki and Dream (mocked) |
| 8 | Any model. *Your subscription.* | the model picker |
| 9 | Not just *code.* | pills "Papers." "Websites." "Images and video." "Chores." with a paper (title page + a page with its figures), tavya.io, an AI image, a film still, the booked flight |
| 10 | End card: "Just do things." | then three quotes, one at a time (N.H., D.A., R.S.; the landing shows the same, `LANDING_QUOTES`) |

```bash
python3 ../fetch.py && bash ../build.sh                          # the clone (DEMO_NO_PHOTOS=1 skips the photos scene's downloads)
FILM=<previous film>.mp4 DIRECTOR=final/capture.cjs bash ../record.sh /tmp/demo/final-assets ['shot-regex']
PAPER=paper.pdf IMAGE=image.png FILM=film.mp4 WEBSITE=landing.png ./extras.sh /tmp/demo/final-assets
./make.sh out.mp4 --workers 4                                    # or --stills 6,30 for single frames
./splice.sh previous.mp4 out.mp4 55.8                            # only the end card changed: re-render from its start
```

`capture.cjs` starts every task in the same order whatever it shoots, so task numbers
match between a full capture and a re-shoot. The AI image was made with gpt-image-2 on the
project's OpenAI key; the paper is legibench3's (task_mvik4fo03779021f59, page 4 has its
figures); the website is the landing's first screen (design/landing-v2/shoot.cjs).
