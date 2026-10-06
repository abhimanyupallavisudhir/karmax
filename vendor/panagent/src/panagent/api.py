"""The library interface: load any supported source, render or install it as any target."""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from shlex import quote
from typing import Any
from uuid import uuid4

from .browser import fetch_share_browser
from .detect import canonical_format, detect_text, url_format
from .errors import AcquisitionError, BrowserRequired, PanagentError
from .model import default_mode, validate_conversation
from .readers import READERS, read_file
from .web import WEB_READERS, fetch_share
from .writers import WRITERS, Rendered

# Shares whose pages may need a real browser (a challenge or a client-rendered app).
BROWSER_FORMATS = {"chatgpt-share", "claude-share"}
NATIVE_TARGETS = {"claude-code", "codex"}


def parse(
    text: str,
    source_format: str | None = None,
    *,
    source_uri: str | None = None,
    conversation: str | None = None,
) -> dict[str, Any]:
    """Read a conversation from text in any supported input format (detected when omitted)."""
    fmt = canonical_format(source_format) if source_format else detect_text(text)
    reader = READERS.get(fmt) or WEB_READERS.get(fmt)
    if reader is None:
        raise PanagentError(f"{fmt} is output-only")
    return validate_conversation(reader(text, source_uri=source_uri, conversation=conversation))


def load(
    source: str | os.PathLike[str],
    source_format: str | None = None,
    *,
    conversation: str | None = None,
    timeout: float = 30.0,
    browser: str = "never",
    browser_timeout: float = 120.0,
    cdp_url: str | None = None,
    browser_profile: str | None = None,
) -> dict[str, Any]:
    """Read a conversation from a file or a public share URL.

    browser is "never" (the library default), "auto", "headless" or "headed";
    it only applies to ChatGPT and Claude shares that plain HTTPS cannot read.
    """
    source = os.fspath(source)
    share = url_format(source) if "://" in source else None
    if not share:
        return parse(read_file(Path(source)), source_format, source_uri=source, conversation=conversation)
    fmt = canonical_format(source_format) if source_format else share
    if fmt != share:
        raise PanagentError(f"URL does not match source format {fmt}")
    reader = WEB_READERS[fmt]

    def through_browser() -> dict[str, Any]:
        text = fetch_share_browser(source, timeout=browser_timeout, mode=browser, cdp_url=cdp_url, profile=browser_profile)
        return validate_conversation(reader(text, source_uri=source))

    if fmt in BROWSER_FORMATS and (browser in {"headless", "headed"} or cdp_url):
        return through_browser()
    try:
        return validate_conversation(reader(fetch_share(source, timeout=timeout), source_uri=source))
    except AcquisitionError as exc:
        retryable = isinstance(exc, BrowserRequired) or exc.status in {403, 429}
        if fmt not in BROWSER_FORMATS or browser == "never" or not retryable:
            raise
        return through_browser()


def render(
    conv: dict[str, Any],
    target: str,
    *,
    mode: str = "auto",
    cwd: str | None = None,
    session_id: str | None = None,
) -> Rendered:
    """Write a conversation as target ("ir", "markdown", "claude-code" or "codex").

    mode "auto" gives native targets a guarded context message for web snapshots
    and a turn-by-turn transcript for agent sessions; IR and Markdown ignore it.
    """
    fmt = canonical_format(target)
    writer = WRITERS.get(fmt)
    if writer is None:
        raise PanagentError(f"{fmt} is input-only")
    validate_conversation(conv)
    if mode == "auto":
        mode = default_mode(conv) if fmt in NATIVE_TARGETS else "transcript"
    if mode not in {"context", "transcript"}:
        raise PanagentError(f"unknown mode: {mode}")
    rendered = writer(conv, mode=mode, cwd=cwd, session_id=session_id)
    rendered.format, rendered.mode = fmt, mode
    return rendered


@dataclass
class Installed:
    path: Path
    session_id: str
    command: str
    rendered: Rendered


def install(
    conv: dict[str, Any],
    target: str,
    *,
    cwd: str | os.PathLike[str] | None = None,
    session_id: str | None = None,
    mode: str = "auto",
    home: str | os.PathLike[str] | None = None,
) -> Installed:
    """Add a conversation to Claude Code's or Codex's own history as a new session.

    Claude Code finds sessions per project, so cwd (default: the current
    directory) is where `claude --resume` must run. home overrides the CLI's
    data directory ($CLAUDE_CONFIG_DIR or ~/.claude; $CODEX_HOME or ~/.codex).
    An existing session file is never overwritten.
    """
    fmt = canonical_format(target)
    if fmt not in NATIVE_TARGETS:
        raise PanagentError("only claude-code and codex sessions can be installed")
    directory = str(Path(cwd or os.getcwd()).expanduser().resolve())
    # The installed copy is a new session of the target CLI, never the source's identity.
    session_id = session_id or str(uuid4())
    rendered = render(conv, fmt, mode=mode, cwd=directory, session_id=session_id)
    if fmt == "claude-code":
        root = Path(home or os.environ.get("CLAUDE_CONFIG_DIR") or Path.home() / ".claude").expanduser()
        path = root / "projects" / re.sub(r"[^A-Za-z0-9]", "-", directory) / f"{session_id}.jsonl"
        command = f"cd {quote(directory)} && claude --resume {session_id}"
    else:
        root = Path(home or os.environ.get("CODEX_HOME") or Path.home() / ".codex").expanduser()
        started = _utc(rendered.text.split("\n", 1)[0])
        path = (root / "sessions" / started.strftime("%Y/%m/%d")
                / f"rollout-{started.strftime('%Y-%m-%dT%H-%M-%S')}-{session_id}.jsonl")
        command = f"codex resume {session_id}"
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError as exc:
        raise PanagentError(f"session {session_id} already exists at {path}") from exc
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="") as handle:
            handle.write(rendered.text)
    except BaseException:
        path.unlink(missing_ok=True)
        raise
    return Installed(path, session_id, command, rendered)


def _utc(first_record: str) -> datetime:
    """The session start of a Codex rollout (from its session_meta record), else now."""
    try:
        value = json.loads(first_record)["timestamp"]
        return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)
    except (ValueError, KeyError, TypeError, AttributeError):
        return datetime.now(timezone.utc)
