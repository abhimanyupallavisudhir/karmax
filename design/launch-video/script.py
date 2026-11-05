# Writes /tmp/demo/script.json: what the demo's mock agent does for each prompt.
import json

def esc(text):
    return text.replace('\n', '\\n')

entries = []
def entry(match, lines, role=None, pace=0):
    if pace:
        paced = []
        for l in lines:
            if l.startswith(('@step', '@tool', '@run')): paced += [f'@sleep {pace}', l]
            else: paced.append(l)
        lines = paced
    e = {'match': match, 'directives': '\n'.join(lines)}
    if role: e['role'] = role
    entries.append(e)

# ── #815 usability overhaul ──────────────────────────────────────────────
shots = [('0', 'tasks', 'Tasks: classic vs new'), ('1', 'task', 'Task page: classic vs new'), ('2', 'settings', 'Settings: classic vs new'),
         ('5', 'form-light', 'Agent form'), ('6', 'form-quick-light', 'Quick question'), ('7', 'form-secret-dark', 'Secure form (dark)')]
entry(r'^## usability overhaul', [
    '@step read Read karmax/web/app.js',
    '@step read Read karmax/web/styles.css',
    '@step read Read mockup.png',
    '@step think Six items. Forms first: a ```form fence in any message, drawn by web/markdown.js, answered as an ordinary reply.',
    '@step edit Edit karmax/web/markdown.js',
    '@step edit Edit karmax/web/app.js',
    '@step edit Edit karmax/src/agent/prompt.ts',
    '@step edit Edit karmax/web/styles.css',
    '@step command npm run typecheck && npm run lint :: ✓ no errors',
    '@step command npx vitest run tests/web-regressions.test.ts :: Test Files  162 passed (162)',
    '@step command node design/reskin/shoot.cjs && node design/reskin/compare.cjs :: 28 screenshots, 7 comparisons',
    '@run cd karmax && mkdir -p design/reskin/out && ' + ' && '.join(f'cp /tmp/demo/assets/815/{i}.png design/reskin/out/{n}.png' for i, n, _ in shots)
        + ' && git add -A && git commit -qm "Usability overhaul: forms, secure forms, For me counts, sidebar rows, no top bar, re-skin"',
    *[f'@openaction {label} :: karmax/design/reskin/out/{n}.png' for _, n, label in shots],
    '@review Classic vs new look (tasks, task, settings), and agent forms: a multi-field form, a one-click question, and a secure API-key form that saves to project secrets.',
    '@say ' + esc('''All six items are built, committed and sent to review. Typecheck and lint pass, and all 162 web test files pass. I checked every page in screenshots in both looks, light and dark.

1. **Forms for asking.** An agent puts a small JSON form in a message instead of writing "reply A, B or C"; what the person submits is sent as their ordinary reply.
2. **Secure settings forms.** A form can save a setting from the person's own browser, so an API key never enters the conversation.
3. **For me counts** beside each project in the sidebar.
4. **Navigation rows:** Home, Insights, Wiki and Settings now have their names.
5. **No top bar.** The logo moved into the sidebar; your avatar, the inbox and help sit at its foot.
6. **Re-skin.** Neutral greys, cards a step off the page, pill buttons, 15px body text. The old look stays under **Installation → Appearance → Style**.

The review panel has before/after screenshots of each page in both looks.'''),
], pace=4000)

# ── Buy the domain tavya.io ──────────────────────────────────────────────
entry(r'^Buy the domain tavya\.io', [
    '@step search Checking tavya.io at 6 registrars :: one.com $14.70 first year (renews $54) · Porkbun $32.48 · Namecheap $34.98 · Gandi $52.00',
    '@step tool chrome-devtools · navigate_page :: https://www.one.com/en/domain',
    '@step tool tavya · check_agent_mail :: one.com: Confirm your e-mail address (code 482 913)',
    '@tool request_spend {"amount": 1470, "card_name": "abhimanyu", "merchant": "one.com", "why": "Register tavya.io for one year"}',
    '@step tool tavya · fill_payment_card :: Card details filled into one.com checkout (never shown to the agent)',
    '@tool store_credential {"type": "login", "label": "one.com · tavya.io", "domains": ["one.com"], "username": "agent-7c1e9a40d2b3@mail.tavyausercontent.com", "secrets": {"password": "Qm7#vT2!pX9rL4wz"}}',
    '@step tool chrome-devtools · fill_form :: one.com DNS → A tavya.io 85.190.100.189, A www.tavya.io 85.190.100.189',
    '@step edit Write karmax/.github/workflows/deploy.yml',
    '@run cd karmax && mkdir -p .github/workflows && cp /tmp/demo/assets/deploy/deploy.yml .github/workflows/deploy.yml && git add -A && git commit -qm "Deploy master to tavya.io on every push"',
    '@step tool tavya · platform_request :: POST /api/projects/…/secrets DEPLOY_SSH_KEY, DEPLOY_KNOWN_HOSTS',
    '@step command gh workflow run deploy.yml && gh run watch :: ✓ deploy to production  1m 12s',
    '@step command curl -sI https://tavya.io :: HTTP/2 200\\nserver: Caddy\\ncontent-type: text/html; charset=utf-8',
    '@tool save_skill {"name": "ops/dns", "content": "---\\nname: DNS and domains — tavya.io\\ndescription: Read before changing a DNS record or the domain.\\nlabels: [ops, dns]\\n---\\n\\nStatus: tavya.io registered at one.com 2026-11-04 (renews yearly, $54).\\n\\n| Type | Name | Value |\\n|---|---|---|\\n| A | tavya.io | 85.190.100.189 |\\n| A | www.tavya.io | 85.190.100.189 |\\n\\n- one.com login: vault item one.com · tavya.io.\\n- Every push to master deploys through .github/workflows/deploy.yml."}',
    '@openaction tavya.io :: https://tavya.io',
    '@review https://tavya.io is live; every push to master deploys there.',
    '@say ' + esc('''**https://tavya.io is live**, and every push to master now deploys there.

- **Bought tavya.io** at one.com for **$14.70** (first year; it renews at $54). That's $10.30 under your $25 budget.
- **Saved the one.com login** in the vault as `one.com · tavya.io`. I signed up with this task's agent e-mail, so no one's inbox was needed.
- **DNS:** `tavya.io` and `www` point at the server (85.190.100.189); Caddy serves HTTPS.
- **Deploys:** `.github/workflows/deploy.yml` ships each master commit over SSH. The first run took 1m 12s.
- Wrote what I set up to the wiki (`ops/dns`), so later tasks know where the domain lives.'''),
], pace=2900)

# ── personal-website: CV ─────────────────────────────────────────────────
entry(r'^Update my CV to include tavya', [
    '@step read Read cv/cv.tex',
    '@step search Read https://tavya.io and the karmax README',
    '@step edit Edit cv/cv.tex',
    '@run cd cv && python3 /tmp/demo/assets/cv_edit.py && git add -A && git commit -qm "CV: add tavya to projects"',
    '@step command latexmk -pdf -quiet cv.tex :: Output written on cv.pdf (2 pages)',
    '@summary tavya added to Projects.',
    '@say ' + esc('''Added **tavya** at the top of **Projects** in your CV:

> **tavya** (tavya.io) — *2026–present*. A to-do list for AI agents: every task runs in its own cloud computer, agents pay, sign up and deploy within budgets you set, and review is human or AI.

The PDF still fits on two pages; nothing else changed.'''),
], pace=1500)

# ── SEO: asks for two connections, then works ────────────────────────────
entry(r"^Do a pass of tavya's SEO", [
    '@step command curl -s https://tavya.io/pricing | grep -o "<title>.*</title>" :: <title>tavya</title>',
    '@step command curl -sI https://tavya.io/sitemap.xml :: HTTP/2 200  content-type: text/html (the app page, not a sitemap)',
    '@step read Read karmax/src/gateway/server.ts',
    '@tool request_connection {"toolkit": "google_search_console", "why": "See which searches show tavya.io, find pages Google could not index, and submit the new sitemap."}',
    '@tool request_connection {"toolkit": "gmail", "why": "Read the Search Console verification and coverage e-mails sent to you."}',
    '@say ' + esc('''Every page of tavya.io has the same title and an empty body until JavaScript runs, and there is no sitemap. I'm fixing both now.

To see what Google actually indexes and to submit the sitemap, I need **Google Search Console** and **Gmail** (for its verification e-mails).'''),
], pace=1800)
entry(r'^(Google Search Console|Gmail) is connected', [
    '@step tool tavya · execute_connection_tool :: GMAIL_FETCH_EMAILS  "[Search Console] New coverage issue detected for tavya.io"',
    '@step read Read karmax/src/gateway/server.ts',
    '@step edit Write karmax/src/gateway/public-pages.ts',
    '@step edit Edit karmax/src/gateway/server.ts',
    '@step edit Write karmax/scripts/render-social-card.mjs',
    '@step command node scripts/render-social-card.mjs :: web/social-card.png  1200×630',
    '@step edit Write karmax/tests/public-pages.test.ts',
    '@run cd karmax && cp /tmp/demo/assets/seo/social-card.png web/social-card.png && printf "User-agent: *\\nAllow: /\\nSitemap: https://tavya.io/sitemap.xml\\n" > web/robots.txt && git add -A && git commit -qm "SEO: per-page titles, descriptions, canonical URLs and link previews; crawlable content; sitemap.xml; real 404s"',
    '@step command npm run typecheck && npx vitest run tests/public-pages.test.ts tests/landing-page.test.ts :: ✓ 284 tests passed',
    '@step tool tavya · execute_connection_tool :: GOOGLE_SEARCH_CONSOLE_SUBMIT_SITEMAP  https://tavya.io/sitemap.xml  → submitted',
    '@openaction Social card :: karmax/web/social-card.png',
    '@runaction Run the SEO tests :: npx vitest run tests/public-pages.test.ts',
    '@summary Per-page titles and link previews, crawlable content, sitemap.xml (submitted), real 404s.',
    '@say ' + esc('''The SEO pass is in Review. Typecheck, lint and the affected tests (284) pass.

**What was wrong:** every URL (landing, pricing, every docs page, even made-up paths) returned the same title and an empty page until JavaScript ran. There was no sitemap, no canonical URLs or link previews, and unknown pages returned 200.

**What changed:**
- **A title, description, canonical URL and link preview per page,** set by the server. Docs take theirs from each page's heading and first paragraph.
- **Content without JavaScript** for search engines and link previews; people in a browser never see it.
- **A social card** (1200×630) made from the real landing page.
- **`/sitemap.xml` and `robots.txt`.** I submitted the sitemap in your Search Console.
- **Real 404s**, and the app's own pages are kept out of search.

Search Console: 1,284 impressions and 41 clicks in 28 days, nearly all for "tavya" itself. Its coverage e-mail flagged 23 pages as "Duplicate without canonical": that's fixed now.'''),
], pace=1400)

# ── AI reviewer (confirm role) ───────────────────────────────────────────
entry(r'SEO|sitemap', [
    '@step command curl -s localhost:4505/sitemap.xml | grep -c "<loc>" :: 27',
    '@step command curl -s -o /dev/null -w "%{http_code}" localhost:4505/no-such-page :: 404',
    '@step read Read karmax/tests/seo.test.ts',
    '@confirm confirm :: Checked the diff and ran it: the sitemap lists 27 URLs, an unknown path returns 404, and every public page has its own title and canonical URL. Tests cover each. Confirmed.',
    '@say ' + esc('''**Confirmed.** Checked the diff and ran it:

- `/sitemap.xml` lists 27 URLs, and each one loads.
- Every public page has its own title, description and canonical URL.
- An unknown path returns 404.

The new tests cover each of these.'''),
], role='confirm', pace=1500)

import re
RUNBOOK = re.sub(r'\(`task_[a-z0-9]+`(, #823)?\)', '', '\n'.join(open('/tmp/demo/assets/822/runbook.md').read().split('\n')[:24]))
# ── Trigger: keep tavya compatible with Codex / Claude Code ──────────────
entry(r'^Create a repeatable task that is triggered by codex', [
    '@step tool tavya · describe_platform :: tasks, triggers (schedule · event · dependency), events, emit',
    '@step think The tavya GitHub App is not installed on openai/codex or anthropics/claude-code, so no GitHub events come from them: polling their releases is the only signal.',
    '@step command gh api repos/anthropics/claude-code/releases --jq ".[0].tag_name" :: v2.1.318',
    '@step command gh api repos/openai/codex/releases --jq ".[0].tag_name" :: rust-v0.166.0',
    '@step edit Write karmax/scripts/agent-cli-releases.mjs',
    '@step edit Write karmax/tests/agent-cli-releases.test.ts',
    '@run cd karmax && mkdir -p scripts && printf "// Emits agent-cli.released for each CLI newer than the version tavya pins.\\n" > scripts/agent-cli-releases.mjs && git add -A && git commit -qm "Release watcher for Claude Code and Codex"',
    '@step command node scripts/agent-cli-releases.mjs --dry-run :: agent-cli.released claude-code@2.1.318 (pinned 2.1.281)\\nagent-cli.released codex@0.166.0 (pinned 0.162.1)',
    '@tool create_task ' + json.dumps({
        'project_id': '__TAVYA_PROJECT__',
        'title': 'Watch agent CLI releases',
        'params': {'command': 'node karmax/scripts/agent-cli-releases.mjs', 'repeatable': True,
                   'triggers': [{'kind': 'schedule', 'cron': '0 3 * * *', 'recurring': True}]},
    }),
    '@tool create_task ' + json.dumps({
        'project_id': '__TAVYA_PROJECT__',
        'title': 'Upgrade {{name}} to {{version}}',
        'prompt': '{{name}} {{version}} is out ({{url}}); tavya pins {{pinned}}. Read the release notes and the wiki runbook ops/agent-cli-upgrades, update every place the version is pinned, adapt tavya to what changed (test first), make new models selectable, run the live Claude/Codex tests and open a PR.',
        'params': {'repeatable': True, 'triggers': [{'kind': 'event', 'type': 'agent-cli.released', 'recurring': True,
                                                     'concurrency': {'mode': 'tell'}}]},
    }),
    '@tool create_task ' + json.dumps({
        'project_id': '__TAVYA_PROJECT__',
        'title': 'Switch on the release watcher and check one upgrade run starts',
        'prompt': 'The release-watcher script is on master now. Arm "Watch agent CLI releases", run it once, and check that its events start an "Upgrade …" run.',
        'params': {'triggers': [{'kind': 'dependency', 'tasks': ['__SELF_TASK__'], 'on': 'success'}]},
    }),
    '@tool save_skill ' + json.dumps({'name': 'ops/agent-cli-upgrades', 'content': RUNBOOK}),
    '@summary A daily release watcher, an agent upgrade per release, and a follow-up that switches it on after merge.',
    '@say ' + esc('''Set up the automation: two repeatable tasks plus a small release-watcher script, which is in this PR.

The tavya GitHub App isn't installed on `openai/codex` or `anthropics/claude-code`, so no GitHub events come from them; polling their releases is the only signal.

- **Watch agent CLI releases** runs daily at 03:00 UTC as a plain command, no agent. For each tool newer than the version tavya pins, it emits an `agent-cli.released` event named after the version (`claude-code@2.1.318`), so each release starts at most one upgrade.
- **Upgrade {{name}} to {{version}}** starts on each such event: it reads the release notes, updates every pin, adapts tavya (test first), makes new models selectable, runs real Claude and Codex calls and opens a PR. One runs at a time; a release that lands meanwhile is told to that run.
- **A follow-up task** starts once this PR merges: it switches the watcher on, runs it once and checks that an upgrade starts.

A dry run against GitHub now reports Claude Code 2.1.318 and Codex 0.166.0 (tavya pins 2.1.281 and 0.162.1), so the first upgrade starts as soon as the watcher is on.'''),
], pace=1300)

# ── The launch video (recursive) ─────────────────────────────────────────
entry(r'^Create a launch video for tavya', [
    '@step read Read tavya.io, the docs and the project wiki',
    '@step think A launch video should show real work in real projects: rapid-fire tasks, agents that pay and sign up, review, triggers, the CLI, the wiki.',
    '@step command node demo/launch-video/director.cjs :: recorded 11 scenes, 4 min 52 s',
    '@step command python3 demo/launch-video/edit.py :: tavya-launch.mp4  1920×1080 · 60 fps',
    '@run mkdir -p launch && cp /tmp/demo/assets/launch-v1.mp4 launch/tavya-launch.mp4',
    '@openaction Launch video :: launch/tavya-launch.mp4',
    '@say ' + esc('''The launch video is ready: about two minutes, 1080p at 60 fps, and it loops. Open it in the review panel.'''),
], pace=1600)

# ── admin_docs: a flight, with a vault login it must be allowed to use ────
FLIGHT = 'United UA 901, Sun 3 Jan: San Francisco 4:10 pm → London Heathrow 10:30 am (+1)'
entry(r'^Book me the cheapest direct flight to London', [
    '@step read Read documents/passport.pdf :: Passport · valid to 2031',
    '@step read Read documents/loyalty-programmes.md :: United MileagePlus · BA Executive Club · Virgin Atlantic Flying Club',
    '@step search Direct flights SFO → London, Sun 3 Jan :: UA 901  16:10 → 10:30+1  $486\\nVS 20   16:45 → 11:00+1  $541\\nBA 284  21:30 → 15:40+1  $574\\nBA 286  19:55 → 14:10+1  $598',
    '@step think UA 901 is the cheapest direct flight and leaves at a sane hour. Booked on the MileagePlus account, the miles count and the passport is already on file.',
    '@tool fill_credential {"domain": "united.com", "field": "password", "selector": "#password"}',
    '@say ' + esc(f'''The cheapest direct flight with reasonable times is **{FLIGHT}**, Economy, **$486**.

To book it on your MileagePlus account (so the miles are yours and your passport is already on file) I need to sign in to united.com with your **United login** from the vault. Allow it below and I'll finish the booking.'''),
], pace=1500)
entry(r'credential decision\]\s+Access to "flights/united" was approved', [
    '@step tool chrome-devtools · navigate_page :: https://www.united.com/en/us/fsr/choose-flights?f=SFO&t=LHR&d=2027-01-03',
    '@step tool tavya · fill_credential :: MileagePlus login typed into united.com (the agent never sees the password)',
    '@step tool chrome-devtools · fill_form :: Traveller from your saved passport · seat 23A (window, as in your profile)',
    '@tool request_spend {"amount": 48600, "card_name": "abhimanyu", "merchant": "United Airlines", "why": "UA 901 SFO → LHR, 3 Jan, Economy"}',
    '@step tool tavya · fill_payment_card :: Card details filled into united.com checkout (never shown to the agent)',
    '@summary Booked UA 901 to London on 3 Jan, $486.',
    '@say ' + esc(f'''**Booked: {FLIGHT}.**

- Economy, window seat **23A**, **$486** on your card ($14 under your budget).
- Confirmation **K7Q2XD**; your MileagePlus number is on the booking, so the miles are yours.
- The e-ticket went to your e-mail, and I put the flight in the wiki under `travel/2027-01-london`.'''),
], pace=1100)

# ── Photos via the CLI ───────────────────────────────────────────────────
entry(r'^Sort my photos', [
    '@step command exiftool -T -DateTimeOriginal -GPSPosition photos/*.jpg :: 37 image files read',
    '@step think The dates fall into four trips; GPS places them in Santorini, the Highlands, New York and Cornwall.',
    '@step command fdupes -r photos :: photos/IMG_4012.jpg\\nphotos/IMG_4012 (1).jpg',
    '@run /tmp/demo/assets/sort_photos.sh',
    '@openaction Albums :: review/albums.png',
    '@summary 6 albums, 2 duplicates removed.',
    '@say ' + esc('''Sorted your 37 photos into **6 albums**: one per trip (dated from each photo, placed from its GPS), plus **Coffee & food** and **Desk setups**.

| Album | Photos |
|---|---|
| 2025-07 Santorini | 6 |
| 2025-10 Scottish Highlands | 8 |
| 2026-02 New York | 5 |
| 2026-05 Cornwall | 5 |
| Coffee & food | 4 |
| Desk setups | 7 |

Removed 2 exact duplicates. Nothing else was deleted.'''),
], pace=1200)

projects = json.load(open('/tmp/demo/projects.json'))
text = json.dumps(entries, indent=1).replace('__TAVYA_PROJECT__', projects['tavya'])
open('/tmp/demo/script.json', 'w').write(text)
print(len(entries), 'entries')
