# Files Git ignores

What tavya does with the files Git ignores: .env files, credential files, node_modules and build output, datasets and databases. Where each is kept, and how an agent's cloud computer gets it.

## Four kinds

| Kind of file | Where it lives in tavya | How a task gets it |
|---|---|---|
| `.env` files | The project's **Secrets**, one per variable | Written back as lines of that repository's `.env` |
| Secret files (`credentials.json`, `*.pem`) | **Secrets**, as a private file | Written at the same path, kept out of Git |
| Databases and data folders | **Data**, in versions | Its own copy at the same path |
| Dependencies and build output | Not kept | The project's install commands rebuild it |

## How `tavya import` sorts them

`tavya import` sorts by name and size. It never reads a file to decide.

- **Left out**: at the top of a repository, `node_modules`, `dist`, `build`, `out`, `target`, `coverage`, `.next`, `.nuxt`, `.turbo`, `.cache`, `.venv`, `venv`, `__pycache__`, `.pytest_cache`, `.mypy_cache`, `.gradle`, `.idea`, `.vscode`, `.DS_Store` and tavya's own folders.
- **`.env` files**: `.env` and `.env.<anything>`, such as `.env.local`. Not `.env.example`, `.env.sample`, `.env.template`, `.env.dist` or `.env.default(s)`: those hold no values.
- **Secret files**: a name with `secret`, `credential`, `credentials`, `token` or `tokens` right before a dot or at its end, or ending in `.pem`, `.key`, `.p12` or `.pfx`.
- **Databases**: files ending in `.sqlite`, `.sqlite3` or `.db`. A task gets a copy it may change.
- **Data folders**: a top-level folder named `data`, `dataset(s)`, `model(s)`, `upload(s)`, `artifact(s)` or `asset(s)`, or holding 50 MB or more of ignored files. Tasks get it read-only.
- **The rest** is listed, so you can choose.

```
tavya import
```

`import` shows its plan and asks before it changes anything; `--dry-run` only shows it. `--data <path>` and `--secret <path>` add something it left out; `--skip <path>` leaves something out.

## While a task runs

The task's computer has the repositories, wiki, data and secrets. Secret files and `.env` files are written from **Secrets**, and are excluded from Git and from saved workspaces.

The agent runs the project's install commands before it builds or tests. Set them in the project's **Settings → Environment**, in each repository's **Install in …** field.

When a task changes a writable copy of data, **Review** lists it under **Resources**. It becomes the next version when you confirm, unless you press **Exclude**.

## When the computer stops

A paused computer keeps its files. On Fly.io, Hetzner, AWS and Google Cloud the disk keeps everything, ignored files included. E2B and Daytona pause with the files in place.

After **Hibernate after (days)** (7 unless you change it, under **More** in the Computer form), a paused computer is packed away, then restored when the task wakes. Tracked files, uncommitted changes, untracked files, data and secrets come back. Other ignored files and running programs do not. A move to another provider does the same.

## Keep or stop keeping a path

In a folder made by `tavya import` or `tavya clone`:

```
tavya add fixtures/
tavya add --secret config/service.json
tavya untrack fixtures/
```

A folder is kept as data. `tavya add` refuses a path Git tracks. `tavya untrack` deletes the data and its versions, or the secret file. Your local files stay.

## In the console

In the project's **Settings**, **Secrets** lists each secret as a **.env line**, **Private file** or **Environment variable**, with write-only values. **Data** lists each item's path inside a task, and whether it is **Read-only** or a **Writable copy**.

## Next

- [tavya CLI](/docs/cli)
- [Cloud computers](/docs/computers)
