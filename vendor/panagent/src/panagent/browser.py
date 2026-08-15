"""Optional real-browser acquisition for share pages that resist plain HTTP."""

from __future__ import annotations

import json
import os
import sys
import tempfile
import time
from contextlib import ExitStack
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from .errors import AcquisitionError


CLAUDE_MESSAGE_SELECTOR = (
    '[data-message-author-role], [data-author-role], '
    '[data-testid*="user-message"], [data-testid*="human-message"], '
    '[data-testid*="assistant-message"], [data-testid*="ai-message"]'
)


def fetch_share_browser(
    url: str,
    *,
    timeout: float = 120.0,
    mode: str = "auto",
    cdp_url: str | None = None,
    profile: str | None = None,
) -> str:
    """Render a share in Chromium and return structured JSON or final HTML.

    Playwright is deliberately optional. A CDP connection is the safest path for
    an already-open, user-controlled Chrome because authentication and challenge
    cookies remain in that browser. Otherwise a dedicated persistent profile can
    be used with a headed browser so the user can complete a challenge directly.
    """

    if cdp_url and urlparse(cdp_url).hostname not in {"127.0.0.1", "::1", "localhost"}:
        raise AcquisitionError("--cdp-url is restricted to loopback because Chrome debugging grants full browser control")

    try:
        from playwright.sync_api import Error as PlaywrightError
        from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
        from playwright.sync_api import sync_playwright
    except ImportError as exc:
        raise AcquisitionError(
            "browser acquisition requires the optional Playwright support. Install it with "
            "`python -m pip install 'panagent[browser]'`, then run `playwright install chromium`, "
            "or pass --cdp-url for an existing Chrome debugging endpoint."
        ) from exc

    deadline = time.monotonic() + max(timeout, 1.0)
    captured_json: list[str] = []
    browser: Any = None
    context: Any = None
    page: Any = None
    owns_context = False
    try:
        # ExitStack closes the tab/context before Playwright disconnects. This
        # matters for CDP: disconnecting first would leave our tab in the user's
        # already-running browser.
        with sync_playwright() as playwright, ExitStack() as cleanup:
            if cdp_url:
                try:
                    browser = playwright.chromium.connect_over_cdp(cdp_url)
                except PlaywrightError as exc:
                    raise AcquisitionError(f"could not connect to Chrome at {cdp_url}: {exc}") from exc
                had_context = bool(browser.contexts)
                context = browser.contexts[0] if had_context else browser.new_context()
                owns_context = not had_context
            else:
                headed = _headed(mode)
                if mode in {"auto", "headed"} and not headed:
                    raise AcquisitionError(
                        "Claude requires an interactive browser challenge in this environment. Run from a desktop "
                        "terminal with --browser headed, or expose an existing Chrome with remote debugging and "
                        "pass --cdp-url."
                    )
                user_data_dir = profile
                if user_data_dir is None:
                    temporary_profile = tempfile.TemporaryDirectory(prefix="panagent-browser-")
                    cleanup.callback(temporary_profile.cleanup)
                    user_data_dir = temporary_profile.name
                Path(user_data_dir).expanduser().mkdir(parents=True, exist_ok=True)
                context = _launch_persistent(playwright, str(Path(user_data_dir).expanduser()), headless=not headed)
                owns_context = True

            if owns_context:
                cleanup.callback(_safe_close, context)
            page = context.new_page()
            cleanup.callback(_safe_close, page)

            def capture(response: Any) -> None:
                if "claude.ai" not in url or "json" not in (response.headers.get("content-type") or "").lower():
                    return
                try:
                    body = response.text()
                except PlaywrightError:
                    return
                if "chat_messages" in body or '"messages"' in body and ('"uuid"' in body or '"title"' in body):
                    captured_json.append(body)

            page.on("response", capture)
            try:
                page.goto(url, wait_until="domcontentloaded", timeout=min(timeout, 30.0) * 1000)
            except PlaywrightTimeoutError:
                # A challenge or client-rendered app can keep navigation busy. The
                # polling below inspects the page until the full acquisition timeout.
                pass

            while time.monotonic() < deadline:
                if captured_json:
                    return captured_json[-1]
                if "claude.ai" in url:
                    exported = _claude_dom_export(page)
                    if exported is not None:
                        return json.dumps(exported, ensure_ascii=False)
                else:
                    html = page.content()
                    if "streamController.enqueue" in html or page.locator("[data-message-author-role]").count() >= 2:
                        return html
                if mode == "headless" and not cdp_url and _is_challenge(page.url, page.content()):
                    raise AcquisitionError(
                        "Claude returned a challenge that cannot be completed in a headless browser. "
                        "Use --browser headed or --cdp-url with a user-controlled Chrome."
                    )
                page.wait_for_timeout(500)

            html = page.content()
            if _is_challenge(page.url, html):
                raise AcquisitionError(
                    "the browser challenge was not completed before the timeout. Complete it in the opened browser "
                    "and retry with a longer --browser-timeout, or use --cdp-url with that browser."
                )
            if "claude.ai" in url:
                raise AcquisitionError(
                    "Claude rendered no recognizable conversation messages. Keep the share open until it fully "
                    "loads, or use the documented browser JSON/HTML export fallback."
                )
            return html
    except PlaywrightError as exc:
        raise AcquisitionError(
            f"browser acquisition failed: {exc}. Install a Playwright browser with `playwright install chromium`, "
            "or pass --cdp-url for an existing Chrome instance."
        ) from exc


def _safe_close(resource: Any) -> None:
    try:
        resource.close()
    except Exception:
        pass


def _headed(mode: str) -> bool:
    if mode == "headed":
        return True
    if mode == "headless":
        return False
    if not sys.stdin.isatty():
        return False
    if sys.platform.startswith("linux"):
        return bool(os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY"))
    return True


def _launch_persistent(playwright: Any, profile: str, *, headless: bool) -> Any:
    errors: list[str] = []
    for options in ({"channel": "chrome"}, {}):
        try:
            return playwright.chromium.launch_persistent_context(profile, headless=headless, **options)
        except Exception as exc:
            errors.append(str(exc))
    raise AcquisitionError(
        "could not launch Chrome/Chromium. Install Google Chrome or run `playwright install chromium`. "
        + " | ".join(errors)
    )


def _claude_dom_export(page: Any) -> dict[str, Any] | None:
    value = page.evaluate(
        """(selector) => {
          const all = [...document.querySelectorAll(selector)];
          const nodes = all.filter((node) => !all.some((other) => other !== node && node.contains(other)));
          const chat_messages = nodes.map((element, index) => {
            const testid = (element.getAttribute('data-testid') || '').toLowerCase();
            const nativeRole = element.getAttribute('data-message-author-role') ||
              element.getAttribute('data-author-role') ||
              (testid.includes('user') || testid.includes('human') ? 'human' : 'assistant');
            return {
              uuid: element.getAttribute('data-message-id') || element.id || `browser-${index}`,
              sender: nativeRole === 'user' ? 'human' : nativeRole,
              text: element.innerText
            };
          }).filter((item) => item.text && ['human', 'assistant', 'system'].includes(item.sender));
          if (chat_messages.length < 2) return null;
          return {
            name: document.title.replace(/^Claude\\s*[-–]\\s*/, ''),
            source_url: location.href,
            chat_messages
          };
        }""",
        CLAUDE_MESSAGE_SELECTOR,
    )
    return value if isinstance(value, dict) else None


def _is_challenge(url: str, html: str) -> bool:
    lowered = html.lower()
    return (
        "challenge_redirect" in url
        or "challenge-platform" in lowered
        or "cf-chl-" in lowered
        or "verify you are human" in lowered
        or "just a moment" in lowered and "cloudflare" in lowered
    )
