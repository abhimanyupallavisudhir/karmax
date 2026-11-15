# Host tavya yourself

tavya is open source under the GNU AGPL-3.0. Self-host it: try it on your own machine with npm, or run the full stack on your own server with Docker and one command.

## Get the source

The source is at [github.com/abhimanyupallavisudhir/karmax](https://github.com/abhimanyupallavisudhir/karmax). The repository goes by tavya's code name, karmax, so commands and settings say `karmax`.

```
git clone https://github.com/abhimanyupallavisudhir/karmax.git
cd karmax
```

## Try it on your machine

```
npm install
npm start
```

`npm start` prints a local address. Open it and create the administrator account. You need:

- Node.js 22.16 or later.
- The [Temporal CLI](https://temporal.io/setup/install-temporal-cli) at `~/.temporalio/bin/temporal`, or its path in `TEMPORAL_CLI`.
- On Linux, `flock` from util-linux.
- A coding-agent login or API key. Without one, a mock agent runs and does no real work.
- Docker, only if tasks should run in containers.

Here each task's agent works in its own Git worktree on your machine. Do not put a local installation on the public internet; the repository's README describes private access from your phone.

## Host it on a server

On an Ubuntu or Debian server with Docker Engine and its Compose plugin, clone the repository and run:

```
./deploy/karmax up tasks.example.com
```

This generates the installation's keys, builds tavya, and starts PostgreSQL, Temporal, the tavya app with its worker, and Caddy, which gets the HTTPS certificate. There is no environment file to edit. Point two DNS records at the server, `tasks.example.com` and `*.preview.tasks.example.com`, and keep ports 80 and 443 reachable.

## After the first login

Open your domain, create the first administrator, then connect in **Organization settings**:

- **A compute provider**: E2B or Daytona. Tasks run there, not on your server. See [Cloud computers](/docs/computers).
- **GitHub**: tavya creates a GitHub App for your installation, and you install it on the repositories agents may work on.
- **An agent**: an Anthropic or OpenAI API key, or another agent login.

## Upgrades and backups

`./deploy/karmax update` takes a backup, checks the new release and rebuilds.

`./deploy/karmax backup` takes one by hand. Backups sit on the server's own disk and never contain the vault key (`deploy/.secrets/vault_key`). Keep a copy of both off the server: without the key, the vault and every backup are unreadable.

The repository's [deploy guide](https://github.com/abhimanyupallavisudhir/karmax/blob/master/deploy/README.md) covers DNS, restores, memory limits and moving to a new server.

## What the hosted service adds

On tavya.io you run no server, and you get:

- tavya's own computers, charged to your plan's compute, with a free trial.
- An included model, so first tasks need no agent login.

A self-hosted installation is not metered. You bring your own provider accounts and agent logins. See [Pricing](/pricing).

## The licence

tavya is licensed under the GNU Affero General Public License, version 3. You may use, study, change and share it. Its main condition: if you run a changed version as a service for others, you must offer them its source under the same licence. This is a summary, not legal advice; the `LICENSE` file in the repository is the text that counts.

## Next

- [Getting started](/docs)
- [Cloud computers](/docs/computers)
- [tavya CLI](/docs/cli)
