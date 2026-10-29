# Whole-UI sweep, round 2 (2026-10-27) — checklist

Status: done 2026-10-28 (sections A–D on sweep-a…d, merged). Deliberately kept: project slugs on list rows (match `project:` queries), the "God" role name and "unix pass" (test-pinned product names), "Concurrent agent turns" (docs-pinned). Search box: typing narrows the lit view. **Reverted 2026-10-29 (owner): keep what teaches** — the box shows the whole query, and placeholders keep their @ / [[ / audience / cron hints (wiki features/settings-design).

Rule set as in PLAN.md and the wiki's `features/settings-design`: every fact
once; no help paragraphs or subtitles (tips via `policyTip`); sentence case; no
raw ids, enum values or internal jargon; long reference lists fold; one-line
empty states; one component per job; compact. Screens: `shoot.cjs` against a
scratch app seeded by `../task-page/seed.cjs` (before → after).

Done before the sweep: Agents settings as one list; Review gallery with
thumbnails and ‹ › stepping; ignored paths and rail Changed files fold; merge
rights follow tavya roles (no GitHub merge notice in the task form).

## A. Settings (organization, project)
- [x] Passwords: the red `reveal` risk box → one line + tip (kept on purpose before: keep the warning, but short); Bitwarden export said 3× → one row; connector `detail` help lines (raw backticks) → status chip + tip (src/autonomy/connectors.ts)
- [x] Project Payments: Stripe Issuing disclosure at project level → drop; org-level paragraphs → tips; Cardholder paragraph → tip
- [x] Project: "Add a secret / Environment variable…", "Import a pasted .env / Review names…", "Discover from repo / Finds…" subtitles → drop; form field help → tips
- [x] Events: GitHub row value sentence → "Connected" + tip; Recent events fold with count; raw `<code>type</code>`
- [x] Task defaults: Explanation model paragraph → tip; "Project templates are in each project's settings." / "Task defaults below" filler → drop; "software-dev — workflow-specific" → workflow label
- [x] People & authorization: role descriptions / "Exact grant patterns" / "Create role" paragraphs → tips; "God" role / lowercase "owner" chip; "@organization" → "Whole organization"; raw capability ids; Roles card folds
- [x] Advanced: SSO subtitle + paragraph → tip; "Experimental" spacing; Name visibility + Public links → one setting-rows card (toggle for Public links; segmented for visibility)
- [x] Workflows: card heading repeats section title; hosted note; display names (just-do, merge-only, script-exec) and internal descriptions → labels + tips; project Workflows raw ids, "latest (v1.30.0)" → "Latest (1.30.0)"
- [x] Project "Project" pane: three heading levels (title, Git & GitHub, REPOSITORIES); "Connect GitHub to add repositories" + "GitHub: Not set up" twice; Computers section → one row
- [x] Nav single-group caption ("ORGANIZATION"/"PROJECT") → drop
- [x] Accounts: "claude API key (environment)" mono → "Claude API key", source in tip; provider prefilled "kimi" with raw ids → provider select with names; project/task account chips: "ON ▾" select pills → same toggle as org list
- [x] Resources: six "not connected" provider boxes → connected ones + one "Connect a computer" menu; mobile overflow (`.computer-providers` min-width 0); "Any" row text
- [x] Task defaults mobile: Agent/Responder/Review route rows overflow; segmented "Human responds / Agent responds", "Human confirms / Agent reviews"
- [x] Avatārs "On" text + "Disable Avatārs" button → toggle
- [x] Small leaks: spend status `pending_approval`; "revision ${id}"; "turns: ∞" placeholder; delete-row copy differs project vs org; "Set up GitHub for this installation"
- [x] "Add one by hand" and "Use your own AgentMail inbox" open by default → closed (check the test that pins "Add one by hand" expanded)

## B. Installation, profile
- [x] Paid launch: intro / SaaS paragraph / 4-step list / legal / founder checklist / enable-checkout card → tips, folded "Setup steps", one toggle row; "Still required: …" list → chip "N missing"; webhook URL twice → once with Copy; checklist folds "3/12 done"
- [x] Agent cards (Stripe Connect): two paragraphs → one tip; two chips → one; env-supplied notes → "From environment" chip
- [x] GitHub / Composio / Email / Phone access / Users: paragraphs → tips; Phone access says "not set up" 3×; Users closure paragraph → tip; raw user ids/states
- [x] Card headings repeating section titles (GitHub App, Composio, Paid hosted launch, Stripe Connect); nav caption "INSTALLATION"
- [x] Health: memory shown in Health and Service limits differently; load avg + load per core → one tile; "holding new agent leases"; "Runtime lifecycle"; process table lowercase headers, pid, "rss"; process groups fold; lock per row; "✕ kill" → "Stop"
- [x] Service limits: "Not connected" rows (9) → one folded row; mono source badges; "Untracked"; mixed "Upgrade/Billing/Limits ↗"
- [x] Appearance: logo grid → current logo + Change
- [x] Profile: rows whose value is a description (Markdown, Math, Walkthrough) → toggles + tips; urgency chips uppercase mono; disabled email column reason; ghost Test buttons
- [x] Forms → setting rows; 2-choice selects → segmented; TLS checkbox → toggle; button labels ("Save Stripe platform setup" → "Save", "Set up connections" → "Save key")
- [x] Mobile: paid-launch mono overflow; Composio input; Host capacity empty value

## C. Task page, task form, help, palette, queues, activity
- [x] "25 MB each · 50 MB per prompt" / drop-files paragraph → tip. ~~Long placeholders → short~~ reverted: the @ / [[ hints teach (keep what teaches)
- [x] Rail: "→ main" repeats Branches; Sub-tasks "0 of 1 complete" + bar + dot; Branches card in a card with inline styles; "Approval requests" when none pending; dead "Delegated work" kicker
- [x] stageLabel returns raw/lowercase stage keys → sentence case everywhere (shared with D)
- [ ] ~~Search box shows the active view's query (`for:me -is:archived`) → empty with placeholder~~ reverted: the query in the box is how people learn to write one
- [x] Help: Esc twice; raw "software-dev"; title-case command names; palette groups disagree with help
- [x] Task form: raw `[[proj:tag:default]]` context tokens → chips; "Codex/Claude" label (pinned by tests — check); account chips (see A); "claude default model"; Responder "@creator" raw token; "no cards"; slug in header
- [x] Store recommendations (shared with D): 5 cards, "Repeatable" chip on most, "Needs GitHub" ×3 with disabled Install → actionable ones + "N more in Task store", one "Connect GitHub" line; title "Auto-create project wiki (memories, skills, AGENTS.md)"
- [x] Mobile: task-form header crumb/select clipped; conversation toolbar overflows; chip row scrolls with no hint
- [x] Queues: two boxed empty cards → one muted line
- [x] "Needs input" vs "Input"; "Review" attention chip vs stage chip
- [x] Activity (debug page): null fields, token ids, inline max-height; two-line empty state
- [x] "Template" vs "Save as template"; Notes tip placement/text differs between form and rail; Tags menu among Filter/Group/Sort

## D. Home, inbox, insights, wiki, avatars
- [x] Empty state "No open tasks … Describe one above. Finished tasks move to 🗄 Archived." → one line
- [x] Org wiki Index renders whole always-included entries → collapsed rows
- [x] Wiki "Viewing [main ▾]" with one option → hide unless >1
- [x] Personal organization shown as the user's name twice (switcher + profile)
- [x] Insights: "Project" column under "Projects"; "Agent" vs "Agent time"; footer row with only "● NOW"; raw stage names; stat tiles' empty third line; uppercase card titles
- [x] Project slugs in mono on home/inbox rows (pinned by tests — check) vs names in Insights
- [x] Org wiki chips "built-in", "customized", "titles only" + tooltip naming read_wiki
- [x] Mobile: tab bar pushes Work locally off-screen; no project name on mobile; "+ New entry" misaligned; truncated "Ann Au…"
- [x] TeX button shown with no math
