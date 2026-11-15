// The public site in one place: which pages sit beside the console, and the
// landing's words. The console (web/app.js) draws them; the gateway
// (src/gateway/public-pages.ts) renders the same for search engines, link
// previews and agents that run no script — so the two cannot disagree.
(function (root) {
  // A Markdown page: [path, file under web/, title (the file's `# heading`), sidebar group, last changed,
  // its name in the sidebar where the title is too long for it].
  // `updated` is the sitemap's <lastmod>: change it when the page's content changes.
  const page = (path, file, title, group, updated, label = title) => ({ path, file, title, group, updated, label });
  const pages = [
    page('/docs', 'docs/getting-started.md', 'Getting started', 'Docs', '2026-11-14'),
    page('/docs/how-it-works', 'docs/how-it-works.md', 'How it works', 'Docs', '2026-11-14'),
    page('/docs/computers', 'docs/computers.md', 'Cloud computers', 'Docs', '2026-11-06'),
    page('/docs/chat-bots', 'docs/chat-bots.md', 'Chat bots', 'Docs', '2026-10-27'),
    page('/docs/cli', 'docs/cli.md', 'tavya CLI', 'Docs', '2026-10-18'),
    page('/docs/claude-code-in-the-cloud', 'docs/claude-code-in-the-cloud.md', 'Run Claude Code in the cloud', 'Guides', '2026-11-14', 'Claude Code in the cloud'),
    page('/docs/parallel-agents', 'docs/parallel-agents.md', 'Run many agents in parallel', 'Guides', '2026-11-14', 'Parallel agents'),
    page('/docs/scheduled-tasks', 'docs/scheduled-tasks.md', 'Schedule tasks and react to events', 'Guides', '2026-11-14', 'Schedules and events'),
    page('/docs/agent-review', 'docs/agent-review.md', 'Let one agent review another', 'Guides', '2026-11-14', 'Agent review'),
    page('/docs/agent-payments', 'docs/agent-payments.md', 'Give an agent a card with a budget', 'Guides', '2026-11-14', 'Agent payments'),
    page('/docs/ignored-files', 'docs/ignored-files.md', 'Files Git ignores', 'Guides', '2026-11-14'),
    page('/docs/self-hosting', 'docs/self-hosting.md', 'Host tavya yourself', 'Guides', '2026-11-14', 'Self-hosting'),
    page('/compare', 'compare/index.md', 'tavya compared', 'Compare', '2026-11-14'),
    page('/compare/claude-code', 'compare/claude-code.md', 'tavya vs Claude Code on the web', 'Compare', '2026-11-14', 'Claude Code on the web'),
    page('/compare/codex', 'compare/codex.md', 'tavya vs Codex cloud', 'Compare', '2026-11-14', 'Codex cloud'),
    page('/compare/devin', 'compare/devin.md', 'tavya vs Devin', 'Compare', '2026-11-14', 'Devin'),
    page('/compare/cursor', 'compare/cursor.md', 'tavya vs Cursor cloud agents', 'Compare', '2026-11-14', 'Cursor'),
    page('/compare/paperclip', 'compare/paperclip.md', 'tavya vs Paperclip', 'Compare', '2026-11-14', 'Paperclip'),
    page('/compare/warp', 'compare/warp.md', 'tavya vs Warp Factories', 'Compare', '2026-11-14', 'Warp Factories'),
    page('/compare/manus', 'compare/manus.md', 'tavya vs Manus', 'Compare', '2026-11-14', 'Manus'),
    page('/compare/openclaw', 'compare/openclaw.md', 'tavya vs OpenClaw', 'Compare', '2026-11-14', 'OpenClaw'),
    page('/compare/vibe-kanban', 'compare/vibe-kanban.md', 'tavya as a Vibe Kanban alternative', 'Compare', '2026-11-14', 'Vibe Kanban'),
    page('/compare/terragon', 'compare/terragon.md', 'tavya as a Terragon alternative', 'Compare', '2026-11-14', 'Terragon'),
    page('/about', 'about.md', 'About tavya', 'Site', '2026-11-14', 'About'),
    page('/changelog', 'changelog.md', 'Changelog', 'Site', '2026-11-14'),
  ];

  // The landing. A part is [screenshot, title, line, the picture's description].
  const landing = {
    steps: ['How a task goes', [
      ['write', 'Write it down', 'In plain words, in any project.', 'The new-task form with a prompt written in plain words'],
      ['work', 'An agent does it', 'On its own computer: your repos, a terminal, a browser.', 'A task’s agent at work: the steps it has taken so far'],
      ['review', 'Review and approve', 'Or leave the review to an agent.', 'A task in review, with the video its agent attached'],
    ]],
    // The autonomous company: what lets agents run a project.
    autonomy: ['Build the autonomous company', 'Let agents run the whole project.', [
      ['autonomous', 'Agents create, manage and approve tasks', 'Make a project fully autonomous, or hand any review to an agent.', 'The new-project form with “Fully autonomous project” switched on'],
      ['automations', 'Work starts itself', 'On a schedule, an event, or when another task is done.', 'Repeatable tasks: fixing errors as they happen, dependency updates, wiki upkeep, a nightly dream'],
    ]],
    // The automations card's list, drawn with the console's parts: [title, when it runs].
    automations: [
      ['Fix errors in deployment', 'when the server reports an error'],
      ['Update dependencies', 'when a dependency releases'],
      ['Write the release notes', 'after the release task lands'],
      ['Maintain the project wiki', 'every Monday'],
      ['Dream', 'every night at 3:00'],
    ],
    // What else every task gets.
    features: ['Everything a task needs', [
      ['fan-out', 'Big jobs fan out', 'A task splits into sub-tasks, each with its own agent.', 'A task’s sub-tasks, each done by its own agent'],
      ['vault', 'Accounts, keys and a card', 'Agents sign up, sign in and pay, only with what you allow.', 'The vault: logins and keys agents may use'],
      ['models', 'Any model, your subscription', 'Claude Code, Codex or OpenCode, on your plan or an API key.', 'The model picker'],
      ['errand', 'Not just code', 'Papers. Websites. Images and video. Chores.', 'An agent asking to use a saved login before booking a flight'],
    ]],
    // What people say (the launch film's end card says the same): [quote (*…* emphasised), who].
    quotes: [
      ['Every man a CEO, and no one has a moat.', 'N.H.'],
      ['tavya is such an addictive toy… it has replaced my evening PS-5 sessions for me.', 'D.A.'],
      ['I can really just do *anything* now.', 'R.S.'],
    ],
    // Questions a visitor asks before signing up: [question, answer in Markdown]. An
    // answer naming {{trialCredit}} or {{trialDays}} shows only where there is a free trial.
    answers: ['Questions', [
      ['How is this different from Claude Code on the web or Codex cloud?',
        'Those run one vendor’s agent on that vendor’s computers. Here Claude Code, Codex and open models share one list: one agent can review another’s work, tasks start other tasks, agents sign in and pay within limits you set, and the computers can be your own cloud account. [Compare](/compare).'],
      ['What does it cost to try?',
        'Nothing. A new account gets {{trialCredit}} of compute for {{trialDays}} days and a built-in model, so your first tasks need no card and no agent login. [Pricing](/pricing).'],
      ['Do I need a Claude or ChatGPT plan?',
        'No. A task can run on an API key, on the Claude or ChatGPT plan you already pay for, or on any model through OpenCode. You choose per task.'],
      ['Where does the work happen?',
        'Each task gets its own cloud computer with your repositories, a terminal and a browser. Use ours, or connect your own E2B, Daytona, Fly.io, Hetzner, AWS or Google Cloud account. [Cloud computers](/docs/computers).'],
      ['What about files Git ignores?',
        'They come along. `.env` values are kept as project secrets and written back for every task, credential files become secret files, datasets and databases become versioned project data, and dependencies are rebuilt by your install commands. [Files Git ignores](/docs/ignored-files).'],
      ['How are my logins, keys and card protected?',
        'They are encrypted in a vault. For each one you choose whether an agent may use it without asking, and whether it may ever see it. Payments have a budget per task; anything above it waits for your approval. [Security](/legal/security).'],
      ['Can agents act without asking me?',
        'Only as far as you allow. An agent never has more access than the person who started its task, and its result waits in Review for you, a teammate or another agent.'],
      ['Do I need GitHub?',
        'No. Without it your code lives in Git repositories we host, and you can move them to GitHub later.'],
      ['Is it open source?',
        'Yes, under the GNU AGPL-3.0. Read [the source](https://github.com/abhimanyupallavisudhir/karmax), or [run it on your own server](/docs/self-hosting).'],
    ]],
  };

  // How tavya compares, on the landing and on /compare: a product does a thing
  // ('yes'), does not ('no'), or does in part (a few words saying how).
  const compare = { title: 'How it compares', asOf: 'November 2026',
    // Checked against each vendor's own documentation in November 2026 (sources: web/compare/*.md).
    // 'no' also stands for "its documentation does not describe it".
    products: [
      { id: 'tavya', name: 'tavya' },
      { id: 'claude', name: 'Claude Code', path: '/compare/claude-code' },
      { id: 'codex', name: 'Codex', path: '/compare/codex' },
      { id: 'devin', name: 'Devin', path: '/compare/devin' },
      { id: 'cursor', name: 'Cursor', path: '/compare/cursor' },
      { id: 'paperclip', name: 'Paperclip', path: '/compare/paperclip' },
    ],
    // The landing's rows.
    rows: [
      ['Claude Code, Codex and open models in one list', { tavya: 'yes', claude: 'no', codex: 'no', devin: 'one agent, several models', cursor: 'one agent, several models', paperclip: 'yes' }],
      ['A cloud computer for every task', { tavya: 'yes', claude: 'yes', codex: 'yes', devin: 'yes', cursor: 'yes', paperclip: 'optional' }],
      ['Sub-tasks, schedules and events', { tavya: 'yes', claude: 'yes', codex: 'yes', devin: 'yes', cursor: 'yes', paperclip: 'yes' }],
      ['An inbox, logins and a card with a budget', { tavya: 'yes', claude: 'secrets', codex: 'logins', devin: 'logins', cursor: 'secrets', paperclip: 'secrets' }],
      ['Runs in your own cloud account', { tavya: 'yes', claude: 'Team, Enterprise', codex: 'no', devin: 'yes', cursor: 'yes', paperclip: 'yes' }],
      ['Open source', { tavya: 'yes', claude: 'no', codex: 'CLI only', devin: 'no', cursor: 'no', paperclip: 'yes' }],
    ],
    // What the comparison in full adds, including where the others are ahead.
    more: [
      ['An agent reviews the work before it lands', { tavya: 'any model', claude: 'Claude', codex: 'Codex', devin: 'Devin', cursor: 'Bugbot', paperclip: 'yes' }],
      ['Results that are not code', { tavya: 'yes', claude: 'yes', codex: 'through ChatGPT', devin: 'reports', cursor: 'alongside code', paperclip: 'yes' }],
      ['Git hosts', { tavya: 'GitHub, or hosted by tavya', claude: 'GitHub', codex: 'GitHub, GitLab', devin: 'GitHub, GitLab, Bitbucket, Azure DevOps', cursor: 'GitHub, GitLab, Bitbucket, Azure DevOps', paperclip: 'not tied to one' }],
      ['Included in a plan you may already have', { tavya: 'no', claude: 'Claude plans', codex: 'ChatGPT plans', devin: 'no', cursor: 'Cursor plans', paperclip: 'free to self-host' }],
      ['A phone app', { tavya: 'in the browser', claude: 'yes', codex: 'yes', devin: 'yes', cursor: 'yes', paperclip: 'in the browser' }],
    ] };

  // The comparison as a Markdown table: what `{{comparison}}` in a page stands for.
  const comparisonTable = () => {
    const cell = (value) => (value === 'yes' ? '✓' : !value || value === 'no' ? '—' : value);
    return [`| | ${compare.products.map((product) => (product.path ? `[${product.name}](${product.path})` : `**${product.name}**`)).join(' | ')} |`,
      `|---|${compare.products.map(() => ':-:').join('|')}|`,
      ...[...compare.rows, ...compare.more].map(([label, values]) => `| ${label} | ${compare.products.map((product) => cell(values[product.id])).join(' | ')} |`)].join('\n');
  };
  // The landing's questions with an installation's numbers ({ trialCredit, trialDays });
  // an answer that needs a number the installation lacks is left out.
  const answers = (values = {}) => landing.answers[1].flatMap(([question, answer]) => {
    let complete = true;
    const filled = answer.replace(/\{\{(\w+)\}\}/g, (_, name) => values[name] ?? ((complete = false), ''));
    return complete ? [[question, filled]] : [];
  });

  const source = 'https://github.com/abhimanyupallavisudhir/karmax';
  // Where else this product lives (schema.org sameAs).
  const sameAs = [source, 'https://www.npmjs.com/package/@tavya/cli', 'https://registry.modelcontextprotocol.io/v0/servers?search=io.tavya/tavya'];
  root.KarmaxSite = { pages, landing, compare, comparisonTable, answers, source, sameAs };
})(typeof globalThis === 'object' ? globalThis : this);
