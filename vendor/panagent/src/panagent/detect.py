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
    first = next((line for line in stripped.splitlines() if line.strip()), "")
    try:
        obj = json.loads(first)
    except json.JSONDecodeError as exc:
        suffix = f" ({path})" if path else ""
        raise FormatError(f"could not detect input format{suffix}") from exc
    if not isinstance(obj, dict):
        raise FormatError("JSONL records must be objects")
    if obj.get("type") == "session_meta" or "payload" in obj and obj.get("type") in {"response_item", "event_msg"}:
        return "codex"
    if obj.get("type") in {"user", "assistant", "system", "summary", "file-history-snapshot"} and (
        "message" in obj or "sessionId" in obj
    ):
        return "claude-code"
    raise FormatError("could not detect JSON or JSONL input format")
