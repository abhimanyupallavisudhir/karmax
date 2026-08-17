from __future__ import annotations

import json
import re
import ssl
from html.parser import HTMLParser
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from .errors import AcquisitionError, FormatError
from .model import message, new_conversation, normalize_timestamp, text_block, validate_conversation, warning

USER_AGENT = "panagent/0.1 (+https://github.com/abhimanyupallavisudhir/panagent)"
MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024


class _HTMLCollector(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.scripts: list[tuple[dict[str, str | None], str]] = []
        self._script_attrs: dict[str, str | None] | None = None
        self._script_data: list[str] = []
        self.messages: list[tuple[str, str, str | None]] = []
        self._message_role: str | None = None
        self._message_id: str | None = None
        self._message_depth = 0
        self._message_data: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        values = dict(attrs)
        if tag == "script":
            self._script_attrs = values
            self._script_data = []
        if self._message_role is not None:
            self._message_depth += 1
            if tag in {"p", "div", "pre", "li", "br"}:
                self._message_data.append("\n")
            return
        role = values.get("data-message-author-role") or values.get("data-author-role")
        testid = (values.get("data-testid") or "").lower()
        if not role:
            if any(marker in testid for marker in ("user-message", "human-message")):
                role = "user"
            elif any(marker in testid for marker in ("assistant-message", "ai-message")):
                role = "assistant"
        if role in {"human", "user", "assistant", "system"}:
            self._message_role = "user" if role == "human" else role
            self._message_id = values.get("data-message-id") or values.get("id")
            self._message_depth = 1
            self._message_data = []

    def handle_endtag(self, tag: str) -> None:
        if tag == "script" and self._script_attrs is not None:
            self.scripts.append((self._script_attrs, "".join(self._script_data)))
            self._script_attrs = None
            self._script_data = []
        if self._message_role is not None:
            self._message_depth -= 1
            if self._message_depth == 0:
                text = _clean_dom_text("".join(self._message_data))
                if text:
                    self.messages.append((self._message_role, text, self._message_id))
                self._message_role = None
                self._message_id = None
                self._message_data = []

    def handle_data(self, data: str) -> None:
        if self._script_attrs is not None:
            self._script_data.append(data)
        if self._message_role is not None:
            self._message_data.append(data)


def _clean_dom_text(text: str) -> str:
    lines = [line.strip() for line in text.splitlines()]
    result: list[str] = []
    for line in lines:
        if line or result and result[-1]:
            result.append(line)
    return "\n".join(result).strip()


def fetch_share(url: str, *, timeout: float = 30.0) -> str:
    request = Request(
        url,
        headers={
            "User-Agent": USER_AGENT,
            "Accept": "text/html,application/xhtml+xml,application/json",
            "Accept-Encoding": "identity",
        },
    )
    try:
        with urlopen(request, timeout=timeout, context=ssl.create_default_context()) as response:
            data = response.read(MAX_DOWNLOAD_BYTES + 1)
            if len(data) > MAX_DOWNLOAD_BYTES:
                raise AcquisitionError("share response exceeded the 20 MiB safety limit")
            charset = response.headers.get_content_charset() or "utf-8"
            return data.decode(charset, errors="replace")
    except HTTPError as exc:
        raise AcquisitionError(f"share request returned HTTP {exc.code}: {url}") from exc
    except URLError as exc:
        raise AcquisitionError(f"could not fetch share URL: {exc.reason}") from exc


def read_chatgpt_share(text: str, *, source_uri: str | None = None, **_: Any) -> dict[str, Any]:
    collector = _parse_html(text)
    payload = _chatgpt_payload(collector)
    if payload is None:
        if collector.messages:
            conv = _dom_conversation(collector.messages, "chatgpt-share-html", "openai", source_uri)
            _add_share_warnings(conv, provider="ChatGPT")
            warning(conv, "dom_fallback", "Structured ChatGPT payload was unavailable; imported rendered DOM text.")
            return validate_conversation(conv)
        raise FormatError("ChatGPT share HTML did not contain a structured conversation or rendered messages")
    conversation_id = payload.get("conversation_id")
    conv = new_conversation(
        source_format="chatgpt-share-html",
        provider="openai",
        kind="public-share-snapshot",
        source_uri=source_uri,
        conversation_id=str(conversation_id) if conversation_id else None,
        title=payload.get("title"),
    )
    conv["created_at"] = normalize_timestamp(payload.get("create_time"))
    conv["updated_at"] = normalize_timestamp(payload.get("update_time"))
    conv["environment"]["model"] = payload.get("default_model_slug")
    mapping = payload.get("mapping")
    if not isinstance(mapping, dict):
        raise FormatError("ChatGPT share payload has no message mapping")
    for index, node in enumerate(_chatgpt_active_chain(payload)):
        native = node.get("message") if isinstance(node, dict) else None
        if not isinstance(native, dict):
            continue
        author = native.get("author") if isinstance(native.get("author"), dict) else {}
        role = author.get("role")
        if role not in {"system", "developer", "user", "assistant", "tool"}:
            continue
        blocks = _chatgpt_content(native.get("content"), conv, index)
        if not blocks:
            continue
        if role == "tool":
            # Share snapshots generally flatten the tool invocation; retain output without inventing a pairing.
            rendered = "\n".join(block.get("text", "") for block in blocks if block.get("type") == "text")
            blocks = [{"type": "tool_result", "tool_call_id": str(native.get("id") or "unavailable"), "content": rendered, "is_error": False}]
            warning(conv, "chatgpt_tool_call_pairing_unavailable", "ChatGPT share tool output was present but its structured call pairing was unavailable.")
        conv["messages"].append(
            message(
                role=role,
                content=blocks,
                source_format="chatgpt-share-html",
                source_id=native.get("id"),
                source_index=index,
                created_at=native.get("create_time"),
                metadata={
                    key: native[key]
                    for key in ("status", "end_turn", "recipient", "channel")
                    if native.get(key) is not None
                },
            )
        )
    _add_share_warnings(conv, provider="ChatGPT")
    return validate_conversation(conv)


def _parse_html(text: str) -> _HTMLCollector:
    collector = _HTMLCollector()
    try:
        collector.feed(text)
    except Exception as exc:
        raise FormatError(f"invalid share HTML: {exc}") from exc
    return collector


def _chatgpt_payload(collector: _HTMLCollector) -> dict[str, Any] | None:
    for _, script in collector.scripts:
        if "streamController.enqueue" not in script:
            continue
        for encoded in re.findall(r"streamController\.enqueue\((\"(?:[^\"\\]|\\.)*\")\)", script, re.DOTALL):
            try:
                chunk = json.loads(encoded)
            except json.JSONDecodeError:
                continue
            for line in chunk.splitlines():
                if not line.startswith("["):
                    continue
                try:
                    root = _decode_devalue(json.loads(line))
                except (json.JSONDecodeError, ValueError, TypeError, RecursionError):
                    continue
                route = _find_chatgpt_route(root)
                if route:
                    return route
    # Older deployments and saved browser exports may contain plain application/json.
    for attrs, script in collector.scripts:
        if attrs.get("type") not in {"application/json", "application/ld+json"}:
            continue
        try:
            root = json.loads(script)
        except json.JSONDecodeError:
            continue
        route = _find_chatgpt_route(root)
        if route:
            return route
    return None


def _decode_devalue(flat: Any) -> Any:
    if not isinstance(flat, list):
        raise ValueError("devalue payload is not an array")
    cache: dict[int, Any] = {}

    def decode(reference: Any) -> Any:
        if isinstance(reference, int) and reference < 0:
            return None
        if not isinstance(reference, int) or reference >= len(flat):
            return reference
        if reference in cache:
            return cache[reference]
        value = flat[reference]
        if isinstance(value, dict):
            result: dict[Any, Any] = {}
            cache[reference] = result
            for key, child in value.items():
                decoded_key: Any = key
                if isinstance(key, str) and key.startswith("_") and key[1:].isdigit():
                    decoded_key = decode(int(key[1:]))
                result[decoded_key] = decode(child)
            return result
        if isinstance(value, list):
            result_list: list[Any] = []
            cache[reference] = result_list
            result_list.extend(decode(child) for child in value)
            return result_list
        return value

    return decode(0)


def _find_chatgpt_route(value: Any, seen: set[int] | None = None) -> dict[str, Any] | None:
    if seen is None:
        seen = set()
    if isinstance(value, (dict, list)):
        identity = id(value)
        if identity in seen:
            return None
        seen.add(identity)
    if isinstance(value, dict):
        if isinstance(value.get("mapping"), dict) and ("conversation_id" in value or "current_node" in value):
            return value
        response = value.get("serverResponse")
        if isinstance(response, dict):
            data = response.get("data")
            if isinstance(data, dict) and isinstance(data.get("mapping"), dict):
                return data
        for child in value.values():
            found = _find_chatgpt_route(child, seen)
            if found:
                return found
    elif isinstance(value, list):
        for child in value:
            found = _find_chatgpt_route(child, seen)
            if found:
                return found
    return None


def _chatgpt_active_chain(payload: dict[str, Any]) -> list[dict[str, Any]]:
    mapping = payload.get("mapping", {})
    current = payload.get("current_node")
    chain: list[dict[str, Any]] = []
    seen: set[str] = set()
    while isinstance(current, str) and current in mapping and current not in seen:
        seen.add(current)
        node = mapping[current]
        if isinstance(node, dict):
            chain.append(node)
            current = node.get("parent")
        else:
            break
    if chain:
        chain.reverse()
        return chain
    linear = payload.get("linear_conversation")
    if isinstance(linear, list):
        return [item for item in linear if isinstance(item, dict)]
    return [item for item in mapping.values() if isinstance(item, dict)]


def _chatgpt_content(value: Any, conv: dict[str, Any], index: int) -> list[dict[str, Any]]:
    if not isinstance(value, dict):
        return []
    kind = value.get("content_type")
    if kind == "text":
        return [text_block(part) for part in value.get("parts", []) if isinstance(part, (str, int, float))]
    if kind == "code":
        return [{"type": "code", "language": value.get("language"), "text": str(value.get("text", ""))}]
    if kind == "thoughts":
        results: list[dict[str, Any]] = []
        for thought in value.get("thoughts", []):
            if isinstance(thought, dict):
                thought = thought.get("content") or thought.get("summary") or thought.get("text") or ""
            results.append({"type": "reasoning", "text": str(thought), "visibility": "shared-snapshot"})
        return results
    if kind == "reasoning_recap":
        return [{"type": "reasoning", "text": str(value.get("content", "")), "visibility": "recap"}]
    if kind == "model_editable_context":
        warning(conv, "chatgpt_model_context_not_message", "ChatGPT model-editable context was omitted from message history.", path=f"messages[{index}]")
        return []
    warning(conv, "chatgpt_content_not_represented", f"ChatGPT content type {kind!r} was not represented.", path=f"messages[{index}]")
    return []


def read_claude_share(text: str, *, source_uri: str | None = None, **_: Any) -> dict[str, Any]:
    stripped = text.lstrip()
    lowered = text.lower()
    if "challenge-platform" in lowered or "cf-chl-" in lowered or "verify you are human" in lowered:
        raise AcquisitionError(
            "Claude returned an anti-bot challenge, not a conversation. Open the share URL in your browser, "
            "complete the challenge, then use the browser/export fallback documented in docs/browser-export.md."
        )
    data: Any = None
    if stripped.startswith(("{", "[")):
        try:
            data = json.loads(stripped)
        except json.JSONDecodeError as exc:
            raise FormatError(f"invalid Claude export JSON: {exc}") from exc
    else:
        collector = _parse_html(text)
        for attrs, script in collector.scripts:
            if attrs.get("type") != "application/json":
                continue
            try:
                candidate = json.loads(script)
            except json.JSONDecodeError:
                continue
            if _find_chat_messages(candidate) is not None:
                data = candidate
                break
        if data is None and collector.messages:
            conv = _dom_conversation(collector.messages, "claude-share-html", "anthropic", source_uri)
            _add_share_warnings(conv, provider="Claude")
            warning(conv, "dom_fallback", "Structured Claude payload was unavailable; imported rendered browser DOM text.")
            return validate_conversation(conv)
    conversation = _select_claude_conversation(data)
    if conversation is None:
        raise FormatError(
            "Claude input contained no chat_messages. Use the browser export recipe in docs/browser-export.md."
        )
    source_url = source_uri or conversation.get("source_url") or conversation.get("url")
    conversation_id = conversation.get("uuid") or conversation.get("id")
    conv = new_conversation(
        source_format="claude-share-export",
        provider="anthropic",
        kind="public-share-snapshot" if source_url and "/share/" in source_url else "browser-export",
        source_uri=source_url,
        conversation_id=str(conversation_id) if conversation_id else None,
        title=conversation.get("name") or conversation.get("title"),
    )
    items = conversation.get("chat_messages") or conversation.get("messages") or []
    for index, native in enumerate(items):
        if not isinstance(native, dict):
            continue
        sender = native.get("sender") or native.get("role")
        role = {"human": "user", "ai": "assistant"}.get(sender, sender)
        if role not in {"system", "developer", "user", "assistant", "tool"}:
            continue
        blocks = _claude_export_content(native)
        if not blocks:
            continue
        conv["messages"].append(
            message(
                role=role,
                content=blocks,
                source_format="claude-share-export",
                source_id=native.get("uuid") or native.get("id"),
                source_index=index,
                created_at=native.get("created_at") or native.get("timestamp"),
                metadata={key: native[key] for key in ("updated_at", "index") if native.get(key) is not None},
            )
        )
    conv["created_at"] = normalize_timestamp(conversation.get("created_at")) or (
        conv["messages"][0]["created_at"] if conv["messages"] else None
    )
    conv["updated_at"] = normalize_timestamp(conversation.get("updated_at"))
    _add_share_warnings(conv, provider="Claude")
    return validate_conversation(conv)


def _select_claude_conversation(data: Any) -> dict[str, Any] | None:
    if isinstance(data, list):
        candidates = [item for item in data if isinstance(item, dict) and _find_chat_messages(item) is not None]
        if len(candidates) > 1:
            raise FormatError("Claude export contains multiple conversations; provide one conversation object")
        return candidates[0] if candidates else None
    if isinstance(data, dict):
        if isinstance(data.get("conversation"), dict):
            return data["conversation"]
        if isinstance(data.get("chat_messages"), list) or isinstance(data.get("messages"), list):
            return data
        found = _find_chat_messages(data)
        if found is not None:
            return found
    return None


def _find_chat_messages(value: Any, seen: set[int] | None = None) -> dict[str, Any] | None:
    if seen is None:
        seen = set()
    if isinstance(value, (dict, list)):
        identity = id(value)
        if identity in seen:
            return None
        seen.add(identity)
    if isinstance(value, dict):
        if isinstance(value.get("chat_messages"), list) or isinstance(value.get("messages"), list) and (
            "title" in value or "name" in value or "uuid" in value
        ):
            return value
        for child in value.values():
            found = _find_chat_messages(child, seen)
            if found is not None:
                return found
    elif isinstance(value, list):
        for child in value:
            found = _find_chat_messages(child, seen)
            if found is not None:
                return found
    return None


def _claude_export_content(native: dict[str, Any]) -> list[dict[str, Any]]:
    content = native.get("content")
    blocks: list[dict[str, Any]] = []
    if isinstance(content, list):
        for item in content:
            if isinstance(item, dict) and item.get("type") == "text":
                blocks.append(text_block(item.get("text", "")))
    if not blocks and native.get("text") is not None:
        blocks.append(text_block(native["text"]))
    if not blocks and isinstance(content, str):
        blocks.append(text_block(content))
    return blocks


def _dom_conversation(
    items: list[tuple[str, str, str | None]], source_format: str, provider: str, source_uri: str | None
) -> dict[str, Any]:
    conv = new_conversation(
        source_format=source_format,
        provider=provider,
        kind="browser-rendered-export",
        source_uri=source_uri,
    )
    for index, (role, text, native_id) in enumerate(items):
        conv["messages"].append(
            message(
                role=role,
                content=[text_block(text)],
                source_format=source_format,
                source_id=native_id,
                source_index=index,
            )
        )
    return conv


def _add_share_warnings(conv: dict[str, Any], *, provider: str) -> None:
    conv["capabilities"]["source"] = ["visible_messages", "visible_text", "snapshot_provenance"]
    unavailable = [
        "hidden_system_instructions",
        "original_tool_call_structure",
        "uploaded_file_contents",
        "alternative_branches",
        "continuation_state",
    ]
    conv["capabilities"]["unavailable"].extend(unavailable)
    warning(
        conv,
        "share_snapshot_limitations",
        f"{provider} public shares are visible snapshots; hidden instructions, uploads, branches, and resumable provider state may be absent.",
        severity="info",
    )


WEB_READERS = {"chatgpt-share": read_chatgpt_share, "claude-share": read_claude_share}
