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

The **VM image** workflow (`.github/workflows/vm-image.yml`) runs on every
merge to master. It computes the tag (the provisioning version, so a world booted
from the image finds its provisioning stamp and skips provisioning) and builds
and pushes the image only when that tag is not yet published. A running tavya
selects it by itself (`src/world/vm/image.ts`): each new Fly world boots the
published image for its provisioning version once anyone can pull it, and stock
Debian until then. A Fly connection's **Advanced → Image** still overrides it;
`KARMAX_VM_IMAGE_REPOSITORY` points at another repository.

**Once, by hand:** GitHub has no API for package visibility, so after the first
publish make the `karmax-vm` package public (package settings → visibility).
Later tags stay public. Until then tavya keeps booting stock Debian.

To build by hand:

```sh
tag=$(npx tsx environments/vm/context.ts environments/vm/out)
docker build -t ghcr.io/<owner>/karmax-vm:$tag environments/vm/out
docker push ghcr.io/<owner>/karmax-vm:$tag
```
