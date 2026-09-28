# Security policy

## Reporting a vulnerability

Report it privately: on this repository's **Security** tab, choose
**Report a vulnerability**. Include what you found, how to reproduce it, its
impact, and how to reach you. Please do not open a public issue or pull request
for an unresolved vulnerability.

A hosted Karmax (such as tavya.io) also lists its operator's security contact on
its **Security & Contact** page (`/legal/security`). Use that for anything about
a specific deployment: a suspected account compromise, exposed data, or abuse.

## Scope

Only `master` is supported; hosted cells deploy from it. Especially welcome:

- crossing a tenant boundary: reading or acting on another organization's tasks,
  worlds, resources, credentials or billing;
- an agent gaining authority its task token does not grant, or acting where a
  human with the same grants could not;
- vault or credential-broker leaks: a secret reaching an agent, a log, or the
  browser as plaintext;
- escaping a world (worktree, container or remote sandbox) into the host;
- anything that lets unreviewed code reach `.github/workflows/` or `deploy/`,
  which run with production's secrets.

## Testing safely

Test against your own installation (`npm start`, or `./deploy/karmax up` on your
own server). On a hosted cell, use only accounts you own, never access other
customers' data, and do not degrade the service (no load or denial-of-service
testing). There is no bug bounty.
