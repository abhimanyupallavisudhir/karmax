# tavya CLI

`tavya` puts a project or a task on your own machine, set up as its cloud world is: repositories, wiki, data and secrets. It also starts and steers tasks from the terminal.

## Install

macOS or Linux:

```
curl -fsSL {{origin}}/cli/install.sh | sh
```

Or, anywhere with Node.js 22 or later:

```
npm install -g @tavya/cli
```

Without installing, prefix any command with `npx @tavya/cli` instead of `tavya`.

## Sign in

```
tavya login
```

This opens your browser to approve the sign-in, and you can limit what the CLI may do. For a server other than tavya.io, add `--url <server>`. `tavya whoami` shows who you are; `tavya logout` signs out. Review or revoke sign-ins under **Profile → Apps and tokens**.

## Work on a project locally

```
tavya clone my-org/my-project
cd my-project
tavya setup              # run the project's install commands
tavya run -- npm test    # run with the project's secrets in the environment
tavya pull               # bring repositories, data and secrets up to date
tavya push               # push commits and changed data
```

`tavya status` and `tavya diff` show what changed since the last pull or push. If your organization allows it, `clone --git-via-tavya` works without a GitHub account.

Git uses your own credentials. If you reach another GitHub account through an SSH alias in `~/.ssh/config` (say `Host work.github.com`), point that owner's repositories at it once:

```
git config --global url."git@work.github.com:owner/".insteadOf "git@github.com:owner/"
```

`tavya import` turns a folder on your machine into a new tavya project.

## Work on a task locally

Clone a task by its number to pick up where its agent left off:

```
tavya clone my-org/my-project#42
```

`tavya push` then sends your commits and data into the task's world. `tavya resume` continues the agent's conversation in Claude Code or Codex on your machine.

## Tasks from the terminal

Inside a project's folder, a task is its number; anywhere else, `my-org/my-project#42`.

| Command | What it does |
|---|---|
| `tavya task new "Fix the login bug"` | Start a task (add `--prompt` for details) |
| `tavya task list` | List tasks |
| `tavya task logs 42 -f` | Follow a task |
| `tavya task say 42 "Use the staging database"` | Message its agent |
| `tavya task confirm 42` | Confirm its review |
| `tavya attach 42` | A terminal in the task's world |
| `tavya exec 42 -- npm test` | Run one command there |
| `tavya preview 42 --port 3000` | Open a port of its world in your browser |

## Secrets

`tavya secrets list|set|import|rm` manages the project's secrets without ever printing a value. `tavya env` prints them for your own shell, if your role allows it.

## Scripts and CI

```
tavya token create --name ci --expires 30
```

Set the token as `TAVYA_TOKEN` in your CI. `--level` and `--project` limit what it can do. `tavya api <METHOD> <path>` calls any API endpoint; `tavya api --list` prints them all. Every command accepts `--json`.

Inside a task's world, `tavya` is already signed in as that task.
