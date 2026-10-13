# Whole-UI sweep — checklist

Rule set (same as the task page): every fact once, no explanatory paragraphs
(tips via `policyTip`), one component per job, sentence case, compact.
Screens: `shoot.cjs` (console, per settings section) and `shoot-public.cjs`
against a scratch app seeded by `../task-page/seed.cjs`; `before/` and `after/`.

## Lists (home, tasks, inbox, queues, insights)
- [x] Tasks tab count disagrees with the list → drop the tab count
- [x] Organizer: drop "Sectioned" chips (= Group menu), drop chip emoji, compact
      Filter/Group/Sort on the chips row, short search placeholder + tip, count in search box
- [x] Composer: "New task…" placeholder; draft/form icons inside the field
- [x] Row: one status signal (no dot when a pipeline shows), sentence-case chips, UI font
- [x] pipeline() tooltip shows raw stage → stageLabel
- [x] Inbox: a title (org prefix kept: tests pin it)
- [x] Queues: one-line empty states, explanation in tip
- [x] Insights: waiting-on-people misclassifies (insights.ts), duplicate counts, "· 30d", "new" delta, width
- [x] Shell: bell/menu SVG (personal org name, keyboard button, rail search kept: real data / pinned by tests)

## Settings (project, organization)
- [x] Settings headers repeat the tab/org switcher → drop
- [x] Project "Project" pane: no jump grid, no 01–07 numbers
- [x] Project Computers duplicates org → one row linking to org
- [x] Org "Projects" pane name → what it holds
- [x] Workflows list hides coordinators; display names
- [x] Usage total ×3 → one row; plan read-only inputs → rows; "1 ledger events"
- [x] Bugs: "add an API key below" with nothing below; backticks in connector text

## Installation, profile
- [x] Bugs: Host capacity blank; Paid-launch failed save wipes form; nav order; test email enabled unconfigured
- [x] Stacked heading layers (intro, operator chip, scope chips, card headings, paragraphs) → title + tip
- [x] Profile: email twice; walkthrough → row; notification toggles

## Wiki, avatars, form, palette, help
- [x] Wiki width ≠ other tabs (all project tabs one width); heading/nav label; empty home
- [x] Wiki cards repeat the title; chips
- [x] Avatars: subtitle/notes/paragraphs → tips; stray border
- [x] Task form: no "Priority & tags" label; notes like the rail; footer hint → Back tooltip (slug and "Codex/Claude" kept: pinned by tests)
- [x] Palette lists itself
- [x] Help: duplicate Esc / Ctrl+Enter rows
