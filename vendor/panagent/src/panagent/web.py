from __future__ import annotations

import json
import re
import ssl
from html.parser import HTMLParser
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import HTTPRedirectHandler, HTTPSHandler, Request, build_opener

from . import __version__
from .detect import url_format
from .errors import AcquisitionError, BrowserRequired, FormatError
from .model import message, new_conversation, normalize_timestamp, text_block, validate_conversation, warning

USER_AGENT = f"panagent/{__version__} (+https://github.com/abhimanyupallavisudhir/panagent)"
MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024


def _require_share_url(url: str) -> str:
    try:
        found = url_format(url) if url.startswith("https://") else None
    except FormatError:
        found = None
    if not found:
        raise AcquisitionError("only HTTPS public share URLs are supported")
    return found


class _ShareRedirectHandler(HTTPRedirectHandler):
    """Follow a redirect only to a share of the same kind (chat.openai.com → chatgpt.com)."""

    def redirect_request(self, req: Any, fp: Any, code: int, msg: str, headers: Any, newurl: str) -> Request | None:
        found = _require_share_url(newurl)
        if req is not None and found != _require_share_url(req.full_url):
            raise AcquisitionError("share redirected to a different kind of URL")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


_CHALLENGE_TITLES = ("just a moment", "attention required", "verify you are human", "one more step")
_CHALLENGE_IDS = {"challenge-form", "challenge-running", "challenge-stage", "cf-challenge-running"}


class _HTMLCollector(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        # Set by an interstitial's structure only (title, challenge form or
        # script), never by message or body text.
        self.challenge = False
        self._title: list[str] | None = None
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
        if values.get("id") in _CHALLENGE_IDS or tag == "form" and "__cf_chl_" in (values.get("action") or ""):
            self.challenge = True
        if tag == "title":
            self._title = []
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
        if tag == "title" and self._title is not None:
            self.challenge |= " ".join("".join(self._title).split()).lower().startswith(_CHALLENGE_TITLES)
            self._title = None
        if tag == "script" and self._script_attrs is not None:
            self.challenge |= "_cf_chl_opt" in "".join(self._script_data)
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
        if self._title is not None:
            self._title.append(data)
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
    _require_share_url(url)
    request = Request(
        url,
        headers={
            "User-Agent": USER_AGENT,
            "Accept": "text/html,application/xhtml+xml,application/json",
            "Accept-Encoding": "identity",
        },
    )
    try:
        opener = build_opener(_ShareRedirectHandler(), HTTPSHandler(context=ssl.create_default_context()))
        with opener.open(request, timeout=timeout) as response:
            data = response.read(MAX_DOWNLOAD_BYTES + 1)
            if len(data) > MAX_DOWNLOAD_BYTES:
                raise AcquisitionError("share response exceeded the 20 MiB safety limit")
            charset = response.headers.get_content_charset() or "utf-8"
            return data.decode(charset, errors="replace")
    except HTTPError as exc:
        if exc.code in {404, 410}:
            raise AcquisitionError(f"share not found; it may have been deleted or unshared: {url}", status=exc.code) from exc
        raise AcquisitionError(f"share request returned HTTP {exc.code}: {url}", status=exc.code) from exc
    except URLError as exc:
        raise AcquisitionError(f"could not fetch share URL: {exc.reason}") from exc


def read_chatgpt_share(
    text: str, *, source_uri: str | None = None, conversation: str | None = None, **_: Any
) -> dict[str, Any]:
    """A ChatGPT share page, or one conversation of a ChatGPT data export (conversations.json)."""
    if text.lstrip("\ufeff \t\r\n").startswith(("{", "[")):
        try:
            data = json.loads(text.lstrip("\ufeff"))
        except json.JSONDecodeError as exc:
            raise FormatError(f"invalid ChatGPT export JSON: {exc}") from exc
        payload = _select_conversation(
            [item for item in (data if isinstance(data, list) else [data])
             if isinstance(item, dict) and isinstance(item.get("mapping"), dict)],
            conversation, provider="ChatGPT")
        return _chatgpt_conversation(payload, "chatgpt-export-json", "account-export", source_uri)
    collector = _parse_html(text)
    payload = _chatgpt_payload(collector)
    if payload is None:
        if collector.messages:
            conv = _dom_conversation(collector.messages, "chatgpt-share-html", "openai", source_uri)
            _add_snapshot_warnings(conv, "ChatGPT")
            warning(conv, "dom_fallback", "Structured ChatGPT payload was unavailable; imported rendered DOM text.")
            return validate_conversation(conv)
        raise FormatError("ChatGPT share HTML did not contain a structured conversation or rendered messages")
    return _chatgpt_conversation(payload, "chatgpt-share-html", "public-share-snapshot", source_uri)


def _chatgpt_conversation(payload: dict[str, Any], source_format: str, kind: str, source_uri: str | None) -> dict[str, Any]:
    conversation_id = payload.get("conversation_id") or payload.get("id")
    conv = new_conversation(
        source_format=source_format,
        provider="openai",
        kind=kind,
        source_uri=source_uri,
        conversation_id=str(conversation_id) if conversation_id else None,
        title=payload.get("title"),
    )
    conv["created_at"] = normalize_timestamp(payload.get("create_time"))
    conv["updated_at"] = normalize_timestamp(payload.get("update_time"))
    if payload.get("default_model_slug"):
        conv["environment"]["model"] = payload["default_model_slug"]
    if not isinstance(payload.get("mapping"), dict):
        raise FormatError("ChatGPT conversation has no message mapping")
    for index, node in enumerate(_chatgpt_active_chain(payload)):
        native = node.get("message") if isinstance(node, dict) else None
        if not isinstance(native, dict):
            continue
        author = native.get("author") if isinstance(native.get("author"), dict) else {}
        role = author.get("role")
        if role not in {"system", "developer", "user", "assistant", "tool"}:
            continue
        if not _chatgpt_visible(native):
            continue
        blocks = _chatgpt_content(native.get("content"), conv, index)
        if not blocks:
            continue
        if role == "tool":
            # ChatGPT records tool output without a structured call; keep it without inventing a pairing.
            rendered = "\n".join(block.get("text", "") for block in blocks if block.get("type") in {"text", "code"})
            blocks = [{"type": "tool_result", "tool_call_id": str(native.get("id") or "unavailable"), "content": rendered, "is_error": False}]
            warning(conv, "chatgpt_tool_call_pairing_unavailable", "ChatGPT tool output was present but its structured call pairing was unavailable.")
        conv["messages"].append(
            message(
                role=role,
                content=blocks,
                source_format=source_format,
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
    _add_snapshot_warnings(conv, "ChatGPT")
    return validate_conversation(conv)


_CHATGPT_CONTEXT_KINDS = {"model_editable_context", "user_editable_context"}


def _chatgpt_visible(native: Any) -> bool:
    """Not hidden scaffolding (an empty system message, for instance)."""
    return isinstance(native, dict) and not (native.get("metadata") or {}).get("is_visually_hidden_from_conversation")


def is_challenge_page(html: str, url: str = "") -> bool:
    """Whether a page is an anti-bot interstitial rather than content. Only its
    structure counts: a conversation may quote challenge text, and ordinary
    Cloudflare pages load /cdn-cgi/challenge-platform/ bot-management scripts."""
    if "challenge_redirect" in url or "__cf_chl_" in url:
        return True
    try:
        return _parse_html(html).challenge
    except FormatError:
        return False


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
        return [text_block(part) for part in value.get("parts", []) if isinstance(part, (str, int, float)) and str(part)]
    if kind == "multimodal_text":
        blocks: list[dict[str, Any]] = []
        for part in value.get("parts", []):
            if isinstance(part, (str, int, float)):
                if str(part):
                    blocks.append(text_block(part))
            elif isinstance(part, dict) and part.get("content_type") == "image_asset_pointer":
                # Asset pointers name files inside ChatGPT; the bytes are not part of the export.
                blocks.append({"type": "attachment", "name": str(part.get("asset_pointer") or "image"), "media_type": "image"})
                warning(conv, "chatgpt_image_unavailable", "ChatGPT images are referenced by asset pointers whose contents are not exported.")
        return blocks
    if kind in {"execution_output", "system_error", "tether_quote", "tether_browsing_display"}:
        body = value.get("text") or value.get("result") or ""
        return [text_block(body)] if body else []
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
    if kind in _CHATGPT_CONTEXT_KINDS:
        warning(conv, "chatgpt_model_context_not_message", "ChatGPT memory and custom-instruction context was omitted from message history.")
        return []
    warning(conv, "chatgpt_content_not_represented", f"ChatGPT content type {kind!r} was not represented.", path=f"messages[{index}]")
    return []


def read_claude_share(
    text: str, *, source_uri: str | None = None, conversation: str | None = None, **_: Any
) -> dict[str, Any]:
    """A Claude share (page, rendered DOM or captured JSON), or one conversation of a Claude data export."""
    stripped = text.lstrip("\ufeff \t\r\n")
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
            _add_snapshot_warnings(conv, "Claude")
            warning(conv, "dom_fallback", "Structured Claude payload was unavailable; imported rendered browser DOM text.")
            return validate_conversation(conv)
        if data is None and collector.challenge:
            raise BrowserRequired(
                "Claude returned an anti-bot challenge, not a conversation. Open the share URL in your browser, "
                "complete the challenge, then use the browser/export fallback at https://github.com/abhimanyupallavisudhir/panagent/blob/master/docs/browser-export.md"
            )
        if data is None:
            raise BrowserRequired(
                "Claude share HTML contained no conversation; it renders only in a browser. Retry with "
                "--browser headed or --cdp-url, or use the browser/export fallback at https://github.com/abhimanyupallavisudhir/panagent/blob/master/docs/browser-export.md"
            )
    account_export = isinstance(data, list)
    if account_export:
        selected = _select_conversation(
            [item for item in data if isinstance(item, dict) and _find_chat_messages(item) is not None],
            conversation, provider="Claude")
    else:
        selected = _claude_conversation_object(data)
    if selected is None:
        raise FormatError(
            "Claude input contained no chat_messages. Use the browser export recipe at https://github.com/abhimanyupallavisudhir/panagent/blob/master/docs/browser-export.md"
        )
    source_url = source_uri or selected.get("source_url") or selected.get("url")
    conversation_id = selected.get("uuid") or selected.get("id")
    kind = "account-export" if account_export else (
        "public-share-snapshot" if source_url and "/share/" in source_url else "browser-export")
    conv = new_conversation(
        source_format="claude-share-export",
        provider="anthropic",
        kind=kind,
        source_uri=source_url,
        conversation_id=str(conversation_id) if conversation_id else None,
        title=selected.get("name") or selected.get("title"),
    )
    pending: list[str] = []
    items = selected.get("chat_messages") or selected.get("messages") or []
    for index, native in enumerate(items):
        if not isinstance(native, dict):
            continue
        sender = native.get("sender") or native.get("role")
        role = {"human": "user", "ai": "assistant"}.get(sender, sender)
        if role not in {"system", "developer", "user", "assistant", "tool"}:
            continue
        native_id = native.get("uuid") or native.get("id")
        for part, (part_role, blocks) in enumerate(_split_tool_results(role, _claude_export_content(native, conv, index, pending))):
            conv["messages"].append(
                message(
                    role=part_role,
                    content=blocks,
                    source_format="claude-share-export",
                    source_id=native_id,
                    message_id=f"{native_id}:{part}" if native_id and part else None,
                    source_index=index,
                    created_at=native.get("created_at") or native.get("timestamp"),
                    metadata={key: native[key] for key in ("updated_at", "index") if native.get(key) is not None},
                )
            )
    conv["created_at"] = normalize_timestamp(selected.get("created_at")) or (
        conv["messages"][0]["created_at"] if conv["messages"] else None
    )
    conv["updated_at"] = normalize_timestamp(selected.get("updated_at"))
    _add_snapshot_warnings(conv, "Claude")
    return validate_conversation(conv)


def _claude_conversation_object(data: Any) -> dict[str, Any] | None:
    if not isinstance(data, dict):
        return None
    if isinstance(data.get("conversation"), dict):
        return data["conversation"]
    if isinstance(data.get("chat_messages"), list) or isinstance(data.get("messages"), list):
        return data
    return _find_chat_messages(data)


def _select_conversation(candidates: list[dict[str, Any]], wanted: str | None, *, provider: str) -> dict[str, Any]:
    """One conversation of an export, chosen by id or exact title when there are several."""
    if not candidates:
        raise FormatError(f"{provider} export contains no conversations")
    if wanted is None:
        if len(candidates) == 1:
            return candidates[0]
        raise FormatError(
            f"{provider} export contains {len(candidates)} conversations; choose one with --conversation ID "
            "(list them with `panagent list FILE`)"
        )
    matches = [item for item in candidates if wanted in _conversation_ids(item)]
    matches = matches or [item for item in candidates if (item.get("title") or item.get("name")) == wanted]
    if not matches:
        raise FormatError(f"no conversation with id or title {wanted!r} in this {provider} export")
    if len(matches) > 1:
        raise FormatError(f"{len(matches)} conversations are titled {wanted!r}; choose one by id")
    return matches[0]


def _conversation_ids(item: dict[str, Any]) -> set[str]:
    return {str(item[key]) for key in ("conversation_id", "id", "uuid") if item.get(key)}


def list_conversations(text: str, source_format: str) -> list[dict[str, Any]]:
    """The conversations of a ChatGPT or Claude data export: id, title, update time and message count."""
    try:
        data = json.loads(text.lstrip("\ufeff"))
    except json.JSONDecodeError as exc:
        raise FormatError(f"invalid export JSON: {exc}") from exc
    items = data if isinstance(data, list) else [data]
    result = []
    for item in items:
        if not isinstance(item, dict):
            continue
        if source_format == "chatgpt-share" and isinstance(item.get("mapping"), dict):
            count = sum(1 for node in _chatgpt_active_chain(item) if _chatgpt_visible(node.get("message"))
                        and (node["message"].get("content") or {}).get("content_type") not in _CHATGPT_CONTEXT_KINDS)
        elif source_format == "claude-share" and isinstance(item.get("chat_messages"), list):
            count = len(item["chat_messages"])
        else:
            continue
        result.append({
            "id": item.get("conversation_id") or item.get("id") or item.get("uuid"),
            "title": item.get("title") or item.get("name") or "",
            "updated_at": normalize_timestamp(item.get("update_time") or item.get("updated_at")),
            "messages": count,
        })
    return result


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


def _claude_export_content(
    native: dict[str, Any], conv: dict[str, Any], index: int, pending: list[str]
) -> list[dict[str, Any]]:
    content = native.get("content")
    blocks: list[dict[str, Any]] = []
    for part_index, item in enumerate(content if isinstance(content, list) else []):
        kind = item.get("type") if isinstance(item, dict) else None
        if kind == "text":
            if item.get("text"):
                blocks.append(text_block(item["text"]))
        elif kind == "thinking":
            if item.get("thinking"):
                blocks.append({"type": "reasoning", "text": str(item["thinking"]), "visibility": "source-visible"})
        elif kind == "tool_use":
            call_id = str(item.get("id") or f"claude-tool-{index}-{part_index}")
            pending.append(call_id)
            blocks.append({"type": "tool_call", "id": call_id, "name": str(item.get("name") or "unknown"),
                           "arguments": item.get("input", {})})
        elif kind == "tool_result":
            call_id = str(item.get("tool_use_id") or (pending[0] if pending else "unavailable"))
            if call_id in pending:
                pending.remove(call_id)
            output = item.get("content", "")
            if isinstance(output, list):
                output = "\n".join(str(part.get("text", "")) if isinstance(part, dict) else str(part) for part in output)
            blocks.append({"type": "tool_result", "tool_call_id": call_id, "content": str(output),
                           "is_error": bool(item.get("is_error", False))})
        else:
            warning(conv, "claude_block_not_represented", f"Claude content block type {kind!r} was not represented.",
                    path=f"chat_messages[{index}].content[{part_index}]")
    if not blocks and native.get("text"):
        blocks.append(text_block(native["text"]))
    if not blocks and isinstance(content, str) and content:
        blocks.append(text_block(content))
    for attachment in native.get("attachments") or []:
        if isinstance(attachment, dict):
            block = {"type": "attachment", "name": str(attachment.get("file_name") or "attachment")}
            if attachment.get("file_type"):
                block["media_type"] = str(attachment["file_type"])
            if attachment.get("extracted_content"):
                block["text"] = str(attachment["extracted_content"])
            blocks.append(block)
    for file in native.get("files") or []:
        if isinstance(file, dict) and file.get("file_name"):
            blocks.append({"type": "attachment", "name": str(file["file_name"])})
    return blocks


def _split_tool_results(role: str, blocks: list[dict[str, Any]]) -> list[tuple[str, list[dict[str, Any]]]]:
    """Web chats keep a tool's call and result in one assistant message; native histories
    put results in a message of their own, so split each run of results out."""
    parts: list[tuple[str, list[dict[str, Any]]]] = []
    for block in blocks:
        part_role = "tool" if block["type"] == "tool_result" else role
        if parts and parts[-1][0] == part_role:
            parts[-1][1].append(block)
        else:
            parts.append((part_role, [block]))
    return parts


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


def _add_snapshot_warnings(conv: dict[str, Any], provider: str) -> None:
    conv["capabilities"]["source"] = ["visible_messages", "visible_text", "snapshot_provenance"]
    conv["capabilities"]["unavailable"].extend([
        "hidden_system_instructions",
        "original_tool_call_structure",
        "uploaded_file_contents",
        "alternative_branches",
        "continuation_state",
    ])
    what = "exports" if conv["source"]["kind"] == "account-export" else "public shares"
    warning(
        conv,
        "share_snapshot_limitations",
        f"{provider} {what} are visible snapshots; hidden instructions, uploads, branches, and resumable provider state may be absent.",
        severity="info",
    )


class _TavyaShareParser(HTMLParser):
    """tavya's share page: an <h1> title, a snapshot <time>, and one
    <article data-share-message class="msg user|agent"> per message whose
    <div class="msg-text"> holds the message's escaped source text."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.title: str | None = None
        self.shared_at: str | None = None
        self.unavailable = False
        self.messages: list[tuple[str, str]] = []
        self._role: str | None = None
        self._title: list[str] | None = None
        self._text: list[str] | None = None
        self._div_depth = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        values = dict(attrs)
        classes = set((values.get("class") or "").split())
        if self._text is not None:
            self._div_depth += tag == "div"
        elif tag == "article" and "data-share-message" in values:
            self._role = "user" if "user" in classes else "assistant"
        elif tag == "div" and "msg-text" in classes and self._role:
            self._text, self._div_depth = [], 1
        elif tag == "h1" and self.title is None:
            self._title = []
        elif tag == "time" and self.shared_at is None:
            self.shared_at = values.get("datetime")
        elif tag == "section" and "shared-unavailable" in classes:
            self.unavailable = True

    def handle_endtag(self, tag: str) -> None:
        if self._text is not None and tag == "div":
            self._div_depth -= 1
            if self._div_depth == 0:
                self.messages.append((self._role or "assistant", "".join(self._text)))
                self._text = None
        elif tag == "article":
            self._role = None
        elif tag == "h1" and self._title is not None:
            self.title = " ".join("".join(self._title).split())
            self._title = None

    def handle_data(self, data: str) -> None:
        if self._text is not None:
            self._text.append(data)
        elif self._title is not None:
            self._title.append(data)


def read_tavya_share(text: str, *, source_uri: str | None = None, **_: Any) -> dict[str, Any]:
    """A tavya (karmax) shared conversation page."""
    parser = _TavyaShareParser()
    try:
        parser.feed(text)
        parser.close()
    except Exception as exc:
        raise FormatError(f"invalid tavya share HTML: {exc}") from exc
    if parser.unavailable:
        raise FormatError("this tavya share is unavailable; the link was revoked or sharing is disabled")
    if not parser.messages:
        raise FormatError("tavya share HTML contained no messages")
    share_id = source_uri.rstrip("/").rsplit("/", 1)[-1] if source_uri and "://" in source_uri else None
    conv = new_conversation(
        source_format="tavya-share-html",
        provider="tavya",
        kind="public-share-snapshot",
        source_uri=source_uri,
        conversation_id=share_id,
        title=parser.title,
    )
    conv["updated_at"] = normalize_timestamp(parser.shared_at)
    for index, (role, body) in enumerate(parser.messages):
        conv["messages"].append(message(role=role, content=[text_block(body)], source_format="tavya-share-html",
                                        source_index=index, message_id=f"message-{index + 1}"))
    conv["capabilities"]["source"] = ["visible_messages", "visible_text", "snapshot_provenance"]
    conv["capabilities"]["unavailable"].extend(["timestamps", "attachments", "tool_activity", "continuation_state"])
    warning(conv, "share_snapshot_limitations",
            "tavya shares keep message text only; attachments, tool activity and the agent's resumable state are absent.",
            severity="info")
    return validate_conversation(conv)


WEB_READERS = {"chatgpt-share": read_chatgpt_share, "claude-share": read_claude_share, "tavya-share": read_tavya_share}
