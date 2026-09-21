# Karmax browser environments

`Dockerfile` is the common, versioned headless browser environment. It contains
Node 22, Google Chrome, Playwright's matching Chromium and Linux dependencies,
the pinned Claude/Codex subscription CLIs, and pinned Chrome DevTools/Playwright
MCP executables. Its build fails unless a real headless browser can render and
capture a screenshot. Stock/custom worlds retain the `npx` compatibility path;
this image avoids that first-turn download.

Publish the image by immutable digest. Daytona may use the image directly, but
production should create a Daytona snapshot from it and put that snapshot in the
provider connection's **Headless snapshot** field. Build the E2B provider-native
template with:

```sh
KARMAX_BROWSER_IMAGE=ghcr.io/example/karmax-browser@sha256:... \
KARMAX_E2B_TEMPLATE_TAG=karmax-browser-v1 \
npx tsx environments/browser/e2b-template.ts
```

Put the resulting tag in E2B's **Headless template** field.

Alternatively build directly from E2B's `codex` base, without publishing a Docker
image (`E2B_API_KEY` must be available to the SDK):

```sh
KARMAX_E2B_TEMPLATE_TAG=karmax-browser-v2 npx tsx environments/browser/e2b-prebuilt.ts
```

This installs the runtime's pinned Node/npm pair as well as the browser and native
agents, then runs a real render/screenshot smoke test. It prints the template and
build IDs. Select the verified template only after the runtime changes supporting
the baked Node pair and E2B browser working directory have deployed. Building does
not change any organization or project selector. The template uses 2 CPUs and
2048 MiB; compare cost as well as latency with the current provider plan.

Desktop worlds deliberately use each provider's desktop machinery: E2B's
`desktop` template through `@e2b/desktop`, and Daytona Computer Use on Daytona's
VNC-capable default environment. Karmax installs and probes the same pinned
browser MCP layer inside a desktop world before its first browser-enabled agent
turn. A custom Daytona desktop image must include Daytona's documented VNC
packages; otherwise the provider readiness call fails before the agent starts.
