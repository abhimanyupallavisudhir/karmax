# karmax VM image

VM worlds (Fly.io, Hetzner; `src/world/vm/`, wiki `features/vm-worlds`) run on
stock Debian 12 and provision themselves once: system packages, Google Chrome,
the pinned Node/npm pair, the browser MCP servers with Playwright's Chromium,
and the pinned agent CLIs — what the E2B template `environments/browser` bakes.
That takes minutes, so:

- **Hetzner** builds a snapshot of a provisioned server once per project and
  provisioning version (`HetznerDriver.ensureSnapshot`, started in the
  background by a project's first world). Nothing to publish.
- **Fly.io** boots an OCI image. Without one, every new Fly world provisions
  itself from `debian:bookworm` (its root filesystem then persists across
  parks). With this image it boots ready.

Build and publish the image (tag = provisioning version, so a world booted from
it finds its provisioning stamp and skips provisioning):

```sh
tag=$(npx tsx environments/vm/context.ts environments/vm/out)
docker build -t ghcr.io/<owner>/karmax-vm:$tag environments/vm/out
docker push ghcr.io/<owner>/karmax-vm:$tag
```

or run the **VM image** workflow (`.github/workflows/vm-image.yml`). A new GHCR
package is private: make it public once (package settings → visibility) so any
organization's Fly account can pull it. Then select it: the Fly connection's
**Advanced → Image**, or `KARMAX_FLY_IMAGE` for the installation. Publishing does
not activate it. Every change to the pinned tool versions changes the tag:
publish again, then select the new tag.
