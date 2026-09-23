FROM node:22-bookworm

ARG CHROME_DEVTOOLS_MCP_VERSION=1.6.0
ARG PLAYWRIGHT_MCP_VERSION=0.0.78
ARG PLAYWRIGHT_VERSION=1.61.1
# Keep the pre-baked fast path paired with package.json's Agent SDK. Runtime
# launch also verifies this version and falls back to the SDK-declared npx pin
# when a user has not rebuilt an older template yet.
ARG CLAUDE_CODE_VERSION=2.1.280
ARG CODEX_VERSION=0.156.1

ENV DEBIAN_FRONTEND=noninteractive \
    PLAYWRIGHT_BROWSERS_PATH=/opt/karmax/browsers \
    KARMAX_BROWSER_BIN=/opt/karmax/bin

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl gnupg \
 && install -d -m 0755 /etc/apt/keyrings \
 && curl -fsSL https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /etc/apt/keyrings/google-chrome.gpg \
 && echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/google-chrome.gpg] http://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends google-chrome-stable \
 && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /opt/karmax/browser /opt/karmax/bin "$PLAYWRIGHT_BROWSERS_PATH" \
 && npm install --prefix /opt/karmax/browser --no-audit --no-fund --omit=dev \
      "playwright@${PLAYWRIGHT_VERSION}" \
      "@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}" \
      "chrome-devtools-mcp@${CHROME_DEVTOOLS_MCP_VERSION}" \
 && PLAYWRIGHT_BROWSERS_PATH="$PLAYWRIGHT_BROWSERS_PATH" \
      /opt/karmax/browser/node_modules/.bin/playwright install --with-deps chromium \
 && ln -s /opt/karmax/browser/node_modules/.bin/playwright-mcp /opt/karmax/bin/playwright-mcp \
 && ln -s /opt/karmax/browser/node_modules/.bin/chrome-devtools-mcp /opt/karmax/bin/chrome-devtools-mcp

RUN npm install --prefix /opt/karmax/agents --no-audit --no-fund --omit=dev \
      "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
      "@openai/codex@${CODEX_VERSION}" \
 && ln -s /opt/karmax/agents/node_modules/.bin/claude /opt/karmax/bin/claude \
 && ln -s /opt/karmax/agents/node_modules/.bin/codex /opt/karmax/bin/codex

COPY smoke.mjs /opt/karmax/smoke.mjs
RUN node /opt/karmax/smoke.mjs

ENV PATH="/opt/karmax/bin:${PATH}"
