from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from .errors import FormatError
from .model import SCHEMA
from .readers import jsonl_records

FORMAT_ALIASES = {
    "ir": "ir",
    "panagent": "ir",
    "claude": "claude-code",
    "claude-code": "claude-code",
    "codex": "codex",
    "chatgpt": "chatgpt-share",
    "chatgpt-share": "chatgpt-share",
    "chatgpt-export": "chatgpt-share",
    "claude-share": "claude-share",
    "claude-export": "claude-share",
    "tavya": "tavya-share",
    "tavya-share": "tavya-share",
    "karmax": "tavya-share",
    "karmax-share": "tavya-share",
    "markdown": "markdown",
    "md": "markdown",
}

# tavya (and any self-hosted karmax) publishes conversations at an unguessable
# 256-bit id below this path, so the path identifies the format on any host.
TAVYA_SHARE_PATH = re.compile(r"/share/conversations/[A-Za-z0-9_-]{43}")

# Claude Code transcripts are append-only logs. Current clients commonly put
# metadata before the first user/assistant message (and add new metadata kinds
# without changing the transcript container), so detection must inspect the
# stream rather than assume the first record is a message.
CLAUDE_TRANSCRIPT_TYPES = {
    "agent-name",
    "ai-title",
    "assistant",
    "attachment",
    "custom-title",
    "file-history-snapshot",
    "last-prompt",
    "mode",
    "permission-mode",
    "progress",
    "queue-operation",
    "summary",
    "system",
    "user",
}


def canonical_format(name: str) -> str:
    try:
        return FORMAT_ALIASES[name.lower()]
    except KeyError as exc:
        raise FormatError(f"unknown format: {name}") from exc


def url_format(value: str) -> str | None:
    """The share format of an http(s) URL, None for anything that is not a URL."""
    parsed = urlparse(value)
    if parsed.scheme not in {"http", "https"}:
        return None
    host = (parsed.hostname or "").lower()
    if host in {"chatgpt.com", "www.chatgpt.com", "chat.openai.com"} and parsed.path.startswith("/share/"):
        return "chatgpt-share"
    if host in {"claude.ai", "www.claude.ai"} and parsed.path.startswith("/share/"):
        return "claude-share"
    if TAVYA_SHARE_PATH.fullmatch(parsed.path):
        return "tavya-share"
    raise FormatError("only public ChatGPT, Claude and tavya share URLs are supported")


def detect_text(text: str, path: Path | None = None) -> str:
    stripped = text.lstrip("\ufeff\n\r\t ")
    if not stripped:
        raise FormatError("input is empty")
    if stripped.startswith(("{", "[")):
        try:
            value = json.loads(stripped)
        except json.JSONDecodeError:
            value = None
        found = _json_format(value)
        if found:
            return found
    if stripped.startswith("<"):
        return _html_format(stripped[:2_000_000])
    try:
        records = [record for _, record in jsonl_records(stripped)]
    except FormatError as exc:
        suffix = f" ({path})" if path else ""
        raise FormatError(f"{exc}{suffix}") from exc

    # session_meta is the canonical identity record in real Codex rollouts.
    # Search all records so ordinalized or otherwise prefixed exports remain
    # ingestible, while still requiring the provider-specific payload shape.
    if any(
        record.get("type") == "session_meta"
        and isinstance(record.get("payload"), dict)
        and bool(record["payload"].get("id") or record["payload"].get("session_id"))
        for record in records
    ):
        return "codex"

    # A Claude Code project transcript record has a sessionId plus a typed
    # message/metadata entry. ~/.claude/history.jsonl also has sessionId, but no
    # record type, and intentionally must not be mistaken for a resumable chat.
    if any(
        isinstance(record.get("sessionId"), str)
        and bool(record["sessionId"])
        and isinstance(record.get("type"), str)
        and (
            record["type"] in CLAUDE_TRANSCRIPT_TYPES
            or isinstance(record.get("message"), dict)
        )
        for record in records
    ):
        return "claude-code"
    raise FormatError("could not detect JSON or JSONL input format")


def _json_format(value: Any) -> str | None:
    """IR, or a ChatGPT/Claude conversation or account export (conversations.json)."""
    items = value if isinstance(value, list) else [value]
    for item in items:
        if not isinstance(item, dict):
            continue
        if item.get("schema") == SCHEMA:
            return "ir"
        if isinstance(item.get("mapping"), dict):
            return "chatgpt-share"
        if isinstance(item.get("chat_messages"), list) or isinstance(item.get("conversation"), dict):
            return "claude-share"
    return None


def _html_format(html: str) -> str:
    """A saved share page, recognised by the markup each provider renders."""
    lowered = html.lower()
    if "data-share-message" in lowered:
        return "tavya-share"
    if "streamcontroller.enqueue" in lowered or "__reactroutercontext" in lowered or "client-bootstrap" in lowered:
        return "chatgpt-share"
    if "claude" in lowered or "anthropic" in lowered or "challenge-platform" in lowered:
        return "claude-share"
    if "data-message-author-role" in lowered or "chatgpt" in lowered:
        return "chatgpt-share"
    raise FormatError("could not detect which provider rendered this HTML; pass --from")
