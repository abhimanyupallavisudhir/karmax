from __future__ import annotations

import json
from pathlib import Path
from urllib.parse import urlparse

from .errors import FormatError
from .model import SCHEMA

FORMAT_ALIASES = {
    "ir": "ir",
    "panagent": "ir",
    "claude": "claude-code",
    "claude-code": "claude-code",
    "codex": "codex",
    "chatgpt": "chatgpt-share",
    "chatgpt-share": "chatgpt-share",
    "claude-share": "claude-share",
    "claude-export": "claude-share",
    "markdown": "markdown",
    "md": "markdown",
}

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
    parsed = urlparse(value)
    host = parsed.hostname or ""
    if parsed.scheme not in {"http", "https"}:
        return None
    if host in {"chatgpt.com", "www.chatgpt.com"} and parsed.path.startswith("/share/"):
        return "chatgpt-share"
    if host in {"claude.ai", "www.claude.ai"} and parsed.path.startswith("/share/"):
        return "claude-share"
    raise FormatError("only public chatgpt.com/share and claude.ai/share URLs are supported")


def detect_text(text: str, path: Path | None = None) -> str:
    stripped = text.lstrip("\ufeff\n\r\t ")
    if not stripped:
        raise FormatError("input is empty")
    if stripped.startswith("{"):
        try:
            obj = json.loads(stripped)
        except json.JSONDecodeError:
            obj = None
        if isinstance(obj, dict):
            if obj.get("schema") == SCHEMA:
                return "ir"
            if "chat_messages" in obj or "conversation" in obj and isinstance(obj.get("conversation"), dict):
                return "claude-share"
    if stripped.startswith("<"):
        lowered = stripped[:100_000].lower()
        if "chatgpt" in lowered or "reactroutercontext" in lowered or "client-bootstrap" in lowered:
            return "chatgpt-share"
        if "claude" in lowered or "anthropic" in lowered or "challenge-platform" in lowered:
            return "claude-share"
    records: list[dict[str, Any]] = []
    lines = stripped.splitlines()
    for index, line in enumerate(lines):
        if not line.strip():
            continue
        try:
            obj = json.loads(line.lstrip("\ufeff"))
        except json.JSONDecodeError as exc:
            if index == len(lines) - 1 and not stripped.endswith(("\n", "\r")):
                break
            suffix = f" ({path})" if path else ""
            raise FormatError(f"invalid JSONL at line {index + 1}{suffix}: {exc.msg}") from exc
        if not isinstance(obj, dict):
            raise FormatError(f"JSONL line {index + 1} is not an object")
        records.append(obj)

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
