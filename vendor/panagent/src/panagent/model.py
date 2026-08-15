"""Small, JSON-native provider-neutral conversation model."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any
from uuid import uuid4

from .errors import FormatError

SCHEMA = "https://panagent.dev/schema/conversation/v1"
ROLES = {"system", "developer", "user", "assistant", "tool"}
BLOCK_TYPES = {"text", "code", "reasoning", "tool_call", "tool_result", "image", "attachment"}


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def new_conversation(
    *,
    source_format: str,
    provider: str,
    kind: str,
    source_uri: str | None = None,
    conversation_id: str | None = None,
    title: str | None = None,
) -> dict[str, Any]:
    source: dict[str, Any] = {
        "format": source_format,
        "provider": provider,
        "kind": kind,
        "acquired_at": utc_now(),
    }
    if source_uri:
        source["uri"] = source_uri
    if conversation_id:
        source["conversation_id"] = conversation_id
    return {
        "schema": SCHEMA,
        "id": conversation_id or str(uuid4()),
        "title": title,
        "created_at": None,
        "updated_at": None,
        "source": source,
        "environment": {},
        "messages": [],
        "capabilities": {
            "source": [],
            "represented": ["ordered_messages", "text", "timestamps", "provenance"],
            "unavailable": [],
        },
        "warnings": [],
    }


def warning(
    conversation: dict[str, Any],
    code: str,
    message: str,
    *,
    severity: str = "warning",
    path: str | None = None,
) -> None:
    item: dict[str, Any] = {"code": code, "severity": severity, "message": message}
    if path is not None:
        item["path"] = path
    if not any(existing.get("code") == code and existing.get("path") == path for existing in conversation["warnings"]):
        conversation["warnings"].append(item)


def message(
    *,
    role: str,
    content: list[dict[str, Any]],
    source_format: str,
    source_id: str | None = None,
    source_index: int | None = None,
    created_at: str | float | int | None = None,
    message_id: str | None = None,
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    provenance: dict[str, Any] = {"source_format": source_format}
    if source_id is not None:
        provenance["source_message_id"] = source_id
    if source_index is not None:
        provenance["source_record_index"] = source_index
    return {
        "id": message_id or source_id or str(uuid4()),
        "role": role,
        "created_at": normalize_timestamp(created_at),
        "content": content,
        "provenance": provenance,
        "metadata": metadata or {},
    }


def normalize_timestamp(value: str | float | int | None) -> str | None:
    if value is None:
        return None
    if isinstance(value, (int, float)):
        try:
            return datetime.fromtimestamp(value, timezone.utc).isoformat().replace("+00:00", "Z")
        except (OverflowError, OSError, ValueError):
            return str(value)
    return value


def text_block(text: Any) -> dict[str, Any]:
    return {"type": "text", "text": str(text)}


def validate_conversation(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict) or value.get("schema") != SCHEMA:
        raise FormatError(f"not a {SCHEMA} conversation")
    if not isinstance(value.get("source"), dict):
        raise FormatError("conversation.source must be an object")
    if not isinstance(value.get("messages"), list):
        raise FormatError("conversation.messages must be an array")
    if not isinstance(value.get("warnings", []), list):
        raise FormatError("conversation.warnings must be an array")
    seen: set[str] = set()
    for index, item in enumerate(value["messages"]):
        if not isinstance(item, dict):
            raise FormatError(f"messages[{index}] must be an object")
        if item.get("role") not in ROLES:
            raise FormatError(f"messages[{index}].role is invalid")
        if not isinstance(item.get("content"), list):
            raise FormatError(f"messages[{index}].content must be an array")
        item_id = item.get("id")
        if not isinstance(item_id, str) or not item_id:
            raise FormatError(f"messages[{index}].id must be a non-empty string")
        if item_id in seen:
            raise FormatError(f"duplicate message id: {item_id}")
        seen.add(item_id)
        for block_index, block in enumerate(item["content"]):
            if not isinstance(block, dict) or block.get("type") not in BLOCK_TYPES:
                raise FormatError(f"messages[{index}].content[{block_index}] has an invalid type")
    value.setdefault("warnings", [])
    value.setdefault("capabilities", {"source": [], "represented": [], "unavailable": []})
    value.setdefault("environment", {})
    return value
