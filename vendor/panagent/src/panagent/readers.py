from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Iterable

from .errors import FormatError
from .model import (
    message,
    new_conversation,
    normalize_timestamp,
    text_block,
    validate_conversation,
    warning,
)


def read_ir(text: str, **_: Any) -> dict[str, Any]:
    try:
        return validate_conversation(json.loads(text))
    except json.JSONDecodeError as exc:
        raise FormatError(f"invalid panagent JSON: {exc}") from exc


def jsonl_records(text: str) -> Iterable[tuple[int, dict[str, Any]]]:
    for index, line in enumerate(text.splitlines()):
        if not line.strip():
            continue
        try:
            value = json.loads(line)
        except json.JSONDecodeError as exc:
            raise FormatError(f"invalid JSONL at line {index + 1}: {exc.msg}") from exc
        if not isinstance(value, dict):
            raise FormatError(f"JSONL line {index + 1} is not an object")
        yield index, value


def read_claude_code(text: str, *, source_uri: str | None = None, **_: Any) -> dict[str, Any]:
    conv = new_conversation(
        source_format="claude-code-jsonl",
        provider="anthropic",
        kind="native-session",
        source_uri=source_uri,
    )
    conv["capabilities"]["source"] = [
        "ordered_messages",
        "text",
        "timestamps",
        "tool_calls",
        "tool_results",
        "native_metadata",
    ]
    session_ids: list[str] = []
    for index, record in jsonl_records(text):
        record_type = record.get("type")
        embedded = record.get("panagent") if isinstance(record.get("panagent"), dict) else {}
        if embedded.get("source") and "upstream" not in conv["source"]:
            conv["source"]["upstream"] = embedded["source"]
        _merge_embedded_warnings(conv, embedded)
        session_id = record.get("sessionId")
        if isinstance(session_id, str) and session_id not in session_ids:
            session_ids.append(session_id)
        if record_type not in {"user", "assistant", "system"} or not isinstance(record.get("message"), dict):
            if record_type in {"file-history-snapshot", "summary", "progress"}:
                warning(
                    conv,
                    f"claude_{str(record_type).replace('-', '_')}_not_represented",
                    f"Claude Code {record_type!r} state has no portable equivalent and was not represented.",
                    path=f"records[{index}]",
                )
            elif record_type not in {"queue-operation", None}:
                warning(
                    conv,
                    "claude_unknown_record",
                    f"Unrecognized Claude Code record type {record_type!r} was skipped.",
                    path=f"records[{index}]",
                )
            continue
        native = record["message"]
        role = native.get("role", record_type)
        if role not in {"system", "developer", "user", "assistant", "tool"}:
            role = "assistant" if record_type == "assistant" else "user"
        blocks = _read_claude_content(native.get("content"), conv, index)
        if not blocks:
            continue
        if all(block.get("type") == "tool_result" for block in blocks):
            role = "tool"
        metadata = {
            key: native[key]
            for key in ("model", "stop_reason", "stop_sequence", "usage")
            if native.get(key) is not None
        }
        for key in ("cwd", "version", "gitBranch", "userType", "isSidechain", "parentUuid"):
            if record.get(key) is not None:
                metadata[f"claude_{key}"] = record[key]
        converted = message(
            role=role,
            content=blocks,
            source_format="claude-code-jsonl",
            source_id=record.get("uuid") or native.get("id"),
            source_index=index,
            created_at=record.get("timestamp"),
            metadata=metadata,
        )
        if isinstance(embedded.get("provenance"), dict):
            converted["provenance"]["upstream"] = embedded["provenance"]
        conv["messages"].append(converted)
        if not conv["created_at"]:
            conv["created_at"] = normalize_timestamp(record.get("timestamp"))
        conv["updated_at"] = normalize_timestamp(record.get("timestamp")) or conv["updated_at"]
        if record.get("cwd") and not conv["environment"].get("cwd"):
            conv["environment"]["cwd"] = record["cwd"]
    if session_ids:
        conv["source"]["conversation_id"] = session_ids[0]
        conv["id"] = session_ids[0]
    if len(session_ids) > 1:
        warning(conv, "multiple_session_ids", "Input contained multiple Claude Code session IDs.")
    conv["capabilities"]["represented"].extend(["tool_calls", "tool_results", "native_metadata"])
    return validate_conversation(conv)


def _read_claude_content(value: Any, conv: dict[str, Any], index: int) -> list[dict[str, Any]]:
    if isinstance(value, str):
        return [text_block(value)]
    if not isinstance(value, list):
        if value is not None:
            warning(conv, "claude_content_not_represented", "A Claude content value was not an array or string.", path=f"records[{index}]")
        return []
    blocks: list[dict[str, Any]] = []
    for block_index, item in enumerate(value):
        if not isinstance(item, dict):
            blocks.append(text_block(item))
            continue
        kind = item.get("type")
        if kind == "text":
            blocks.append(text_block(item.get("text", "")))
        elif kind == "thinking":
            blocks.append({"type": "reasoning", "text": str(item.get("thinking", "")), "visibility": "source-visible"})
        elif kind in {"tool_use", "server_tool_use"}:
            blocks.append(
                {
                    "type": "tool_call",
                    "id": str(item.get("id") or f"claude-tool-{index}-{block_index}"),
                    "name": str(item.get("name") or "unknown"),
                    "arguments": item.get("input", {}),
                }
            )
        elif kind == "tool_result":
            content = item.get("content", "")
            if isinstance(content, list):
                content = "\n".join(str(part.get("text", part)) if isinstance(part, dict) else str(part) for part in content)
            blocks.append(
                {
                    "type": "tool_result",
                    "tool_call_id": str(item.get("tool_use_id") or "unknown"),
                    "content": str(content),
                    "is_error": bool(item.get("is_error", False)),
                }
            )
        elif kind == "image":
            blocks.append({"type": "image", "source": item.get("source"), "alt": item.get("alt")})
        else:
            warning(
                conv,
                "claude_block_not_represented",
                f"Claude content block type {kind!r} was not represented.",
                path=f"records[{index}].message.content[{block_index}]",
            )
    return blocks


def read_codex(text: str, *, source_uri: str | None = None, **_: Any) -> dict[str, Any]:
    conv = new_conversation(
        source_format="codex-jsonl",
        provider="openai",
        kind="native-session",
        source_uri=source_uri,
    )
    conv["capabilities"]["source"] = [
        "ordered_messages",
        "text",
        "timestamps",
        "tool_calls",
        "tool_results",
        "turn_context",
        "native_metadata",
    ]
    pending_tools: list[dict[str, Any]] = []
    for index, record in jsonl_records(text):
        timestamp = record.get("timestamp")
        record_type = record.get("type")
        payload = record.get("payload") if isinstance(record.get("payload"), dict) else {}
        if record_type == "session_meta":
            session_id = payload.get("id") or payload.get("session_id")
            if session_id:
                conv["id"] = str(session_id)
                conv["source"]["conversation_id"] = str(session_id)
            conv["created_at"] = normalize_timestamp(payload.get("timestamp") or timestamp)
            for key in ("cwd", "cli_version", "model_provider", "originator", "source"):
                if payload.get(key) is not None:
                    conv["environment"][key] = payload[key]
            embedded = payload.get("panagent") if isinstance(payload.get("panagent"), dict) else {}
            if embedded.get("source"):
                conv["source"]["upstream"] = embedded["source"]
            _merge_embedded_warnings(conv, embedded)
            continue
        if record_type == "turn_context":
            for key in ("cwd", "model", "effort", "approval_policy", "sandbox_policy", "workspace_roots"):
                if payload.get(key) is not None:
                    conv["environment"][key] = payload[key]
            warning(
                conv,
                "codex_turn_context_target_specific",
                "Codex turn context was summarized in environment metadata; exact continuation policy is target-specific.",
            )
            continue
        if record_type == "world_state":
            warning(conv, "codex_world_state_not_represented", "Codex world state cannot be recreated in another provider.")
            continue
        if record_type != "response_item":
            continue  # event_msg mirrors response_item content and would duplicate messages.
        payload_type = payload.get("type")
        if payload_type == "message":
            role = payload.get("role")
            if role not in {"system", "developer", "user", "assistant", "tool"}:
                continue
            blocks = _read_codex_message_content(payload.get("content"), conv, index)
            if not blocks:
                continue
            native_id = payload.get("id")
            converted = message(
                role=role,
                content=blocks,
                source_format="codex-jsonl",
                source_id=str(native_id) if native_id else None,
                source_index=index,
                created_at=timestamp,
                metadata={key: payload[key] for key in ("phase", "status") if payload.get(key) is not None},
            )
            _attach_codex_upstream(converted, payload)
            conv["messages"].append(converted)
        elif payload_type in {"function_call", "custom_tool_call", "local_shell_call"}:
            arguments = payload.get("arguments", payload.get("input", payload.get("action", {})))
            if isinstance(arguments, str):
                try:
                    arguments = json.loads(arguments)
                except json.JSONDecodeError:
                    pass
            block = {
                "type": "tool_call",
                "id": str(payload.get("call_id") or payload.get("id") or f"codex-tool-{index}"),
                "name": str(payload.get("name") or payload_type.removesuffix("_call")),
                "arguments": arguments,
            }
            pending_tools.append(block)
            converted = message(
                role="assistant",
                content=[block],
                source_format="codex-jsonl",
                source_id=payload.get("id") or payload.get("call_id"),
                message_id=f"tool-call:{block['id']}:{index}",
                source_index=index,
                created_at=timestamp,
            )
            _attach_codex_upstream(converted, payload)
            conv["messages"].append(converted)
        elif payload_type in {"function_call_output", "custom_tool_call_output", "local_shell_call_output"}:
            output = payload.get("output", "")
            if not isinstance(output, str):
                output = json.dumps(output, ensure_ascii=False)
            call_id = str(payload.get("call_id") or (pending_tools[-1]["id"] if pending_tools else "unknown"))
            converted = message(
                role="tool",
                content=[{"type": "tool_result", "tool_call_id": call_id, "content": output, "is_error": False}],
                source_format="codex-jsonl",
                source_id=payload.get("call_id"),
                message_id=f"tool-result:{call_id}:{index}",
                source_index=index,
                created_at=timestamp,
            )
            _attach_codex_upstream(converted, payload)
            conv["messages"].append(converted)
        elif payload_type == "reasoning":
            summaries = payload.get("summary") or []
            blocks = [
                {"type": "reasoning", "text": str(item.get("text", item)) if isinstance(item, dict) else str(item), "visibility": "summary"}
                for item in summaries
            ]
            if blocks:
                conv["messages"].append(
                    message(
                        role="assistant",
                        content=blocks,
                        source_format="codex-jsonl",
                        source_id=payload.get("id"),
                        source_index=index,
                        created_at=timestamp,
                    )
                )
            if payload.get("encrypted_content"):
                warning(conv, "codex_encrypted_reasoning_unavailable", "Encrypted Codex reasoning is opaque and was not imported.")
        elif payload_type not in {None, "ghost_snapshot", "compaction"}:
            warning(
                conv,
                "codex_item_not_represented",
                f"Codex response item type {payload_type!r} was not represented.",
                path=f"records[{index}]",
            )
        conv["updated_at"] = normalize_timestamp(timestamp) or conv["updated_at"]
    conv["capabilities"]["represented"].extend(["tool_calls", "tool_results", "native_metadata"])
    return validate_conversation(conv)


def _read_codex_message_content(value: Any, conv: dict[str, Any], index: int) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    blocks: list[dict[str, Any]] = []
    for block_index, item in enumerate(value):
        if not isinstance(item, dict):
            continue
        kind = item.get("type")
        if kind in {"input_text", "output_text", "text"}:
            blocks.append(text_block(item.get("text", "")))
        elif kind in {"input_image", "image_url"}:
            blocks.append({"type": "image", "source": item.get("image_url") or item.get("url"), "alt": item.get("detail")})
        else:
            warning(
                conv,
                "codex_block_not_represented",
                f"Codex message content type {kind!r} was not represented.",
                path=f"records[{index}].payload.content[{block_index}]",
            )
    return blocks


def _attach_codex_upstream(converted: dict[str, Any], payload: dict[str, Any]) -> None:
    metadata = payload.get("internal_chat_message_metadata_passthrough")
    if isinstance(metadata, dict) and isinstance(metadata.get("panagent_provenance"), dict):
        converted["provenance"]["upstream"] = metadata["panagent_provenance"]


def _merge_embedded_warnings(conv: dict[str, Any], embedded: dict[str, Any]) -> None:
    for key in ("warnings", "target_warnings"):
        items = embedded.get(key)
        if not isinstance(items, list):
            continue
        for item in items:
            if not isinstance(item, dict) or not item.get("code"):
                continue
            warning(
                conv,
                str(item["code"]),
                str(item.get("message", "Embedded conversion warning")),
                severity=str(item.get("severity", "warning")),
                path=str(item["path"]) if item.get("path") is not None else None,
            )


READERS = {
    "ir": read_ir,
    "claude-code": read_claude_code,
    "codex": read_codex,
}


def read_file(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except OSError as exc:
        raise FormatError(f"could not read {path}: {exc}") from exc
