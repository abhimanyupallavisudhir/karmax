# tavya CLI

Work on [tavya](https://tavya.io) projects and tasks from your own machine.

```sh
curl -fsSL https://tavya.io/cli/install.sh | sh     # or: npm install -g @tavya/cli  (Node 22)
tavya clone acme/site                                # repositories, data and secret files
tavya clone acme/site#123                            # a task, as its cloud world has it
```

A workspace is a task's world on your laptop: the same folders, the project wiki,
data versions at their paths, secret files, and the project's install commands.

| | |
|---|---|
| `tavya pull` / `tavya push` | Code (with your own Git credentials), data, secret files. In a task, push brings your work into its cloud world |
| `tavya status` / `tavya diff` | What changed, locally and on the server |
| `tavya run -- npm test` | Run with the project's secrets in the environment |
| `tavya setup` | Run the project's install commands |
| `tavya task new "Fix the login page"` | Start a task; `task list`, `show`, `logs -f`, `say`, `confirm` |
| `tavya attach` / `tavya exec -- cmd` | A shell, or one command, in the task's cloud world |
| `tavya resume --fork` | Continue the task's agent here (Claude Code, Codex) |
| `tavya import` | Make a local checkout, or a folder of them, a tavya project: GitHub repositories, unpushed commits, `.env`, secret files and data. The folder becomes its workspace |
| `tavya add <path>` / `tavya untrack <path>` | Keep more ignored files in the project as data or secrets, or stop |
| `tavya projects` / `tavya open` | List your projects; open this one in the browser |
| `tavya api GET /api/projects` | Any API call |

`tavya login` signs in through your browser (it works over SSH too). Scripts and
CI use `TAVYA_TOKEN` (`tavya token create`); inside a task world tavya is
already signed in. Every command takes `--json`.

Data moves with [restic](https://restic.net), downloaded once and checked against
a pinned digest; it goes between your machine and storage directly.
