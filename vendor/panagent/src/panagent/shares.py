"""Public share links of chat apps whose conversation a plain HTTPS client can read.

Each site says which links are its own, which request returns the conversation
(the share page, or the data the page loads) and how to read the answer. A site
is listed only once checked against real links; none of them is read through a
human-verification challenge (see docs/browser-export.md for the ones that are).
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Any, Callable
from urllib.parse import ParseResult, quote, unquote

from .errors import FormatError
from .model import message, new_conversation, normalize_timestamp, text_block, validate_conversation, warning

Request = tuple[str, bytes | None, dict[str, str]]


@dataclass(frozen=True)
class ShareSite:
    format: str
    name: str
    provider: str
    #: The share id of a link of this site, or None.
    match: Callable[[ParseResult], str | None]
    #: The request whose answer holds the conversation.
    request: Callable[[str], Request]
    read: Callable[..., dict[str, Any]]
    #: Recognises a saved answer (JSON value or HTML text) without --from.
    detect: Callable[[Any], bool]


def _unavailable(name: str) -> FormatError:
    return FormatError(f"this {name} share is unavailable; it may have been deleted or unshared")


def _conversation(site_format: str, provider: str, source_uri: str | None, conversation_id: Any, title: Any) -> dict[str, Any]:
    return new_conversation(
        source_format=site_format,
        provider=provider,
        kind="public-share-snapshot",
        source_uri=source_uri,
        conversation_id=str(conversation_id) if conversation_id else None,
        title=title.strip() if isinstance(title, str) and title.strip() else None,
    )


def _finish(conv: dict[str, Any], name: str) -> dict[str, Any]:
    if not conv["messages"]:
        raise FormatError(f"{name} share contained no messages")
    conv["created_at"] = conv["created_at"] or conv["messages"][0]["created_at"]
    conv["capabilities"]["source"] = ["visible_messages", "visible_text", "snapshot_provenance"]
    conv["capabilities"]["unavailable"].extend(["hidden_system_instructions", "uploaded_file_contents", "continuation_state"])
    warning(conv, "share_snapshot_limitations",
            f"{name} public shares are visible snapshots; hidden instructions, uploads and resumable provider state are absent.",
            severity="info")
    return validate_conversation(conv)


def _add(conv: dict[str, Any], role: str, blocks: list[dict[str, Any]], fmt: str, *, source_id: Any = None,
         index: int | None = None, created_at: Any = None, model: Any = None, message_id: str | None = None) -> None:
    if not blocks:
        return
    conv["messages"].append(message(
        role=role, content=blocks, source_format=fmt, source_id=str(source_id) if source_id is not None else None,
        source_index=index, created_at=normalize_timestamp(created_at), message_id=message_id,
        metadata={"model": model} if isinstance(model, str) and model else None,
    ))


def _json(text: str, name: str) -> Any:
    try:
        return json.loads(text.lstrip("﻿"))
    except json.JSONDecodeError as exc:
        raise FormatError(f"invalid {name} share response: {exc}") from exc


def _reasoning(text: Any) -> list[dict[str, Any]]:
    return [{"type": "reasoning", "text": text, "visibility": "source-visible"}] if isinstance(text, str) and text.strip() else []


def _text(text: Any) -> list[dict[str, Any]]:
    return [text_block(text)] if isinstance(text, str) and text.strip() else []


# ── DeepSeek: chat.deepseek.com/share/<id> → its page's JSON API ──

def read_deepseek_share(text: str, *, source_uri: str | None = None, **_: Any) -> dict[str, Any]:
    payload = _json(text, "DeepSeek")
    data = payload.get("data") if isinstance(payload, dict) else None
    biz = data.get("biz_data") if isinstance(data, dict) else None
    if not isinstance(biz, dict) or not isinstance(biz.get("messages"), list):
        raise _unavailable("DeepSeek")
    title = biz.get("title")
    conv = _conversation("deepseek-share", "deepseek", source_uri, None, None if title == "Shared Conversation" else title)
    for index, native in enumerate(sorted(biz["messages"], key=lambda m: m.get("message_id") or 0)):
        role = {"USER": "user", "ASSISTANT": "assistant"}.get(str(native.get("role")).upper())
        if role is None:
            continue
        blocks: list[dict[str, Any]] = []
        for fragment in native.get("fragments") or []:
            kind = fragment.get("type") if isinstance(fragment, dict) else None
            if kind in {"REQUEST", "RESPONSE"}:
                blocks += _text(fragment.get("content"))
            elif kind == "THINK":
                blocks += _reasoning(fragment.get("content"))
            elif kind == "FILE":
                blocks.append({"type": "attachment", "name": str(fragment.get("file_name") or "attachment")})
            else:
                warning(conv, "deepseek_fragment_not_represented", f"DeepSeek fragment type {kind!r} was not represented.",
                        path=f"messages[{index}]")
        _add(conv, role, blocks, "deepseek-share", source_id=native.get("message_id"), index=index,
             created_at=native.get("inserted_at"), model=native.get("model"))
    return _finish(conv, "DeepSeek")


# ── Grok: grok.com/share/<id> → its page's REST API ──

def read_grok_share(text: str, *, source_uri: str | None = None, **_: Any) -> dict[str, Any]:
    payload = _json(text, "Grok")
    if not isinstance(payload, dict) or not isinstance(payload.get("responses"), list):
        raise _unavailable("Grok")
    meta = payload.get("conversation") if isinstance(payload.get("conversation"), dict) else {}
    conv = _conversation("grok-share", "xai", source_uri, meta.get("conversationId"), meta.get("title"))
    conv["created_at"] = normalize_timestamp(meta.get("createTime"))
    conv["updated_at"] = normalize_timestamp(meta.get("modifyTime"))
    for index, native in enumerate(sorted(payload["responses"], key=lambda r: str(r.get("createTime") or ""))):
        role = {"human": "user", "assistant": "assistant"}.get(str(native.get("sender")).lower())
        if role is None:
            continue
        if role == "assistant" and native.get("model") and "model" not in conv["environment"]:
            conv["environment"]["model"] = native["model"]
        _add(conv, role, _text(native.get("message")), "grok-share", source_id=native.get("responseId"), index=index,
             created_at=native.get("createTime"), model=native.get("model") if role == "assistant" else None)
    return _finish(conv, "Grok")


# ── Perplexity: perplexity.ai/search/<slug> (threads) → its page's REST API ──

def read_perplexity_share(text: str, *, source_uri: str | None = None, **_: Any) -> dict[str, Any]:
    payload = _json(text, "Perplexity")
    if not isinstance(payload, dict) or not isinstance(payload.get("entries"), list):
        raise _unavailable("Perplexity")
    meta = payload.get("thread_metadata") if isinstance(payload.get("thread_metadata"), dict) else {}
    first = payload["entries"][0] if payload["entries"] else {}
    conv = _conversation("perplexity-share", "perplexity", source_uri, first.get("thread_url_slug") or meta.get("uuid"),
                         meta.get("title"))
    conv["updated_at"] = normalize_timestamp(meta.get("updated_at"))
    for index, entry in enumerate(payload["entries"]):
        created = entry.get("entry_created_datetime")
        # One entry is a question and its answer, under one id.
        uuid = entry.get("uuid")
        _add(conv, "user", _text(entry.get("query_str")), "perplexity-share", source_id=uuid, index=index,
             created_at=created, message_id=f"{uuid}:user" if uuid else None)
        answer = [b["markdown_block"].get("answer") for b in entry.get("blocks") or []
                  if isinstance(b, dict) and b.get("intended_usage") == "ask_text" and isinstance(b.get("markdown_block"), dict)]
        if not any(answer) and isinstance(entry.get("text"), str):
            try:
                answer = [json.loads(entry["text"]).get("answer")]
            except (json.JSONDecodeError, AttributeError):
                answer = []
        model = entry.get("display_model") or entry.get("user_selected_model")
        if model and "model" not in conv["environment"]:
            conv["environment"]["model"] = model
        _add(conv, "assistant", _text("\n\n".join(a for a in answer if isinstance(a, str))), "perplexity-share",
             source_id=uuid, index=index, created_at=created, model=model, message_id=f"{uuid}:assistant" if uuid else None)
    if payload.get("has_next_page"):
        warning(conv, "share_partial", "Only the first page of this Perplexity thread was read.")
    return _finish(conv, "Perplexity")


# ── Poe: poe.com/s/<code> → the share page (Next.js data) ──

_NEXT_DATA = re.compile(r'<script id="__NEXT_DATA__"[^>]*>(.*?)</script>', re.S)


def _poe_share(text: str) -> Any:
    match = _NEXT_DATA.search(text)
    if not match:
        raise FormatError("Poe share page carried no __NEXT_DATA__")
    try:
        page = json.loads(match.group(1))
    except json.JSONDecodeError as exc:
        raise FormatError(f"invalid Poe share data: {exc}") from exc
    props = page.get("props", {}).get("pageProps", {}) if isinstance(page, dict) else {}
    return ((props.get("data") or {}).get("mainQuery") or {}).get("chatShare")


def read_poe_share(text: str, *, source_uri: str | None = None, **_: Any) -> dict[str, Any]:
    share = _poe_share(text)
    if not isinstance(share, dict):
        raise _unavailable("Poe")
    title = None
    try:
        title = json.loads(share.get("opengraphProperties") or "{}").get("og:title")
    except (json.JSONDecodeError, AttributeError):
        pass
    conv = _conversation("poe-share", "poe", source_uri, share.get("shareCode") or share.get("id"), title)
    bot = share.get("chatBot") if isinstance(share.get("chatBot"), dict) else {}
    if bot.get("displayName"):
        conv["environment"]["model"] = bot["displayName"]
    created = share.get("creationTime")
    conv["created_at"] = normalize_timestamp(created / 1e6) if isinstance(created, (int, float)) else None
    connection = share.get("messagesConnection") if isinstance(share.get("messagesConnection"), dict) else {}
    for index, edge in enumerate(connection.get("edges") or []):
        node = edge.get("node") if isinstance(edge, dict) else None
        if not isinstance(node, dict):
            continue
        role = "user" if node.get("author") == "human" else "assistant"
        at = node.get("creationTime")
        author_bot = node.get("authorBot") if isinstance(node.get("authorBot"), dict) else {}
        blocks = _text(node.get("text"))
        for attachment in node.get("attachments") or []:
            if isinstance(attachment, dict):
                blocks.append({"type": "attachment", "name": str(attachment.get("name") or "attachment")})
        _add(conv, role, blocks, "poe-share", source_id=node.get("messageId"), index=index,
             created_at=at / 1e6 if isinstance(at, (int, float)) else None,
             model=author_bot.get("displayName") if role == "assistant" else None)
    if (connection.get("pageInfo") or {}).get("hasNextPage"):
        warning(conv, "share_partial", "Poe shows the first messages of a long share to anyone with the link; later ones were not read.")
    return _finish(conv, "Poe")


# ── Mistral Le Chat: chat.mistral.ai/chat/<uuid> (public chats) → the page's React Flight stream ──

_FLIGHT_CHUNK = re.compile(r'self\.__next_f\.push\(\[1,\s*"((?:[^"\\]|\\.)*)"\]\)')


def _flight_rows(html: str) -> dict[str, Any]:
    """The rows of a Next.js page's Flight stream: id → JSON value or text (a `T` row)."""
    stream = "".join(json.loads(f'"{chunk}"') for chunk in _FLIGHT_CHUNK.findall(html)).encode("utf-8")
    rows: dict[str, Any] = {}
    position = 0
    row = re.compile(rb"([0-9a-f]+):")
    while position < len(stream):
        match = row.match(stream, position)
        if not match:
            end = stream.find(b"\n", position)
            position = len(stream) if end < 0 else end + 1
            continue
        key = match.group(1).decode()
        position = match.end()
        if stream[position:position + 1] == b"T":
            comma = stream.index(b",", position)
            length = int(stream[position + 1:comma], 16)
            rows[key] = stream[comma + 1:comma + 1 + length].decode("utf-8", errors="replace")
            position = comma + 1 + length
            continue
        end = stream.find(b"\n", position)
        end = len(stream) if end < 0 else end
        try:
            rows[key] = json.loads(stream[position:end])
        except json.JSONDecodeError:
            rows[key] = stream[position:end].decode("utf-8", errors="replace")
        position = end + 1
    return rows


def _find_key(value: Any, key: str) -> Any:
    stack = [value]
    while stack:
        item = stack.pop()
        if isinstance(item, dict):
            if key in item:
                return item
            stack.extend(item.values())
        elif isinstance(item, list):
            stack.extend(item)
    return None


def read_mistral_share(text: str, *, source_uri: str | None = None, **_: Any) -> dict[str, Any]:
    rows = _flight_rows(text)

    def resolve(value: Any) -> Any:
        # "$<id>" points at another row; "$$" escapes a literal "$".
        if isinstance(value, str) and re.fullmatch(r"\$[0-9a-f]+", value):
            return rows.get(value[1:])
        return value[1:] if isinstance(value, str) and value.startswith("$$") else value

    holder = None
    for value in rows.values():
        holder = _find_key(value, "initialMessages")
        if holder:
            break
    messages = resolve(holder.get("initialMessages")) if holder else None
    if not isinstance(messages, list):
        raise FormatError("this Le Chat conversation is not public, or does not exist")
    meta = None
    for value in rows.values():
        meta = _find_key(value, "generatedTitle")
        if meta:
            break
    meta = meta or {}
    conv = _conversation("mistral-share", "mistral", source_uri, (messages[0] or {}).get("chatId") if messages else None,
                         resolve(meta.get("userTitle")) or resolve(meta.get("generatedTitle")) or resolve(meta.get("title")))
    stamp = lambda value: value[2:] if isinstance(value, str) and value.startswith("$D") else value  # noqa: E731
    ordered = sorted((m for m in messages if isinstance(m, dict)), key=lambda m: str(stamp(m.get("createdAt")) or ""))
    for index, native in enumerate(ordered):
        role = native.get("role") if native.get("role") in {"user", "assistant"} else None
        if role is None:
            continue
        content = resolve(native.get("content"))
        blocks: list[dict[str, Any]] = []
        chunks = resolve(native.get("contentChunks"))
        if isinstance(chunks, list) and chunks:
            for chunk in (resolve(c) for c in chunks):
                if not isinstance(chunk, dict):
                    continue
                if chunk.get("type") == "text":
                    context = resolve(chunk.get("_context"))
                    reasoning = isinstance(context, dict) and context.get("type") == "reasoning"
                    blocks += (_reasoning if reasoning else _text)(resolve(chunk.get("text")))
                else:
                    warning(conv, "mistral_chunk_not_represented",
                            f"A Le Chat {chunk.get('type')!r} part was not represented.", path=f"messages[{index}]")
        if not blocks:
            blocks = _text(content)
        _add(conv, role, blocks, "mistral-share", source_id=native.get("id"), index=index,
             created_at=stamp(native.get("createdAt")), model=resolve(native.get("model")))
    return _finish(conv, "Le Chat")


# ── Kimi: kimi.com/share/<id> → its page's chat service ──

def read_kimi_share(text: str, *, source_uri: str | None = None, **_: Any) -> dict[str, Any]:
    payload = _json(text, "Kimi")
    share = payload.get("share") if isinstance(payload, dict) else None
    if not isinstance(share, dict) or not isinstance(share.get("messages"), list):
        raise _unavailable("Kimi")
    chat = share.get("chat") if isinstance(share.get("chat"), dict) else {}
    conv = _conversation("kimi-share", "moonshot", source_uri, share.get("id"), chat.get("name"))
    by_id = {m.get("id"): m for m in share["messages"] if isinstance(m, dict)}
    # A tree: walk from the root down the latest child of each message.
    current = next((m for m in sorted(by_id.values(), key=lambda m: str(m.get("createTime") or "")) if not m.get("parentId")), None)
    seen: set[Any] = set()
    index = 0
    while current is not None and current.get("id") not in seen:
        seen.add(current.get("id"))
        role = current.get("role") if current.get("role") in {"user", "assistant"} else None
        blocks: list[dict[str, Any]] = []
        for block in current.get("blocks") or []:
            body = block.get("text") if isinstance(block, dict) else None
            if isinstance(body, dict):
                blocks += _text(body.get("content"))
            elif isinstance(body, str):
                blocks += _text(body)
            elif isinstance(block, dict) and block.get("file"):
                blocks.append({"type": "attachment", "name": str((block.get("file") or {}).get("name") or "attachment")})
        if role:
            _add(conv, role, blocks, "kimi-share", source_id=current.get("id"), index=index, created_at=current.get("createTime"))
        index += 1
        children = current.get("childrenMessageIds") or []
        current = by_id.get(children[-1]) if children else None
    return _finish(conv, "Kimi")


# ── Qwen: chat.qwen.ai/s/<uuid> → its page's JSON API ──

def read_qwen_share(text: str, *, source_uri: str | None = None, **_: Any) -> dict[str, Any]:
    payload = _json(text, "Qwen")
    data = payload.get("data") if isinstance(payload, dict) and payload.get("success") else None
    chat = data.get("chat") if isinstance(data, dict) else None
    if not isinstance(chat, dict):
        raise _unavailable("Qwen")
    conv = _conversation("qwen-share", "qwen", source_uri, data.get("id"), data.get("title"))
    conv["created_at"] = normalize_timestamp(data.get("created_at"))
    conv["updated_at"] = normalize_timestamp(data.get("updated_at"))
    history = (chat.get("history") or {}).get("messages") if isinstance(chat.get("history"), dict) else None
    ordered: list[dict[str, Any]] = []
    if isinstance(history, dict) and data.get("currentId") in history:
        # The shown branch: from the current message up its parents.
        node, seen = history.get(data["currentId"]), set()
        while isinstance(node, dict) and node.get("id") not in seen:
            seen.add(node.get("id"))
            ordered.insert(0, node)
            node = history.get(node.get("parentId"))
    if not ordered:
        ordered = [m for m in chat.get("messages") or [] if isinstance(m, dict)]
    for index, native in enumerate(ordered):
        role = native.get("role") if native.get("role") in {"user", "assistant"} else None
        if role is None:
            continue
        parts = [p for p in native.get("content_list") or [] if isinstance(p, dict)]
        blocks: list[dict[str, Any]] = []
        for part in parts:
            if part.get("phase") in {"think", "thinking", "thinking_summary"}:
                blocks += _reasoning(part.get("content"))
        answer = native.get("content") if isinstance(native.get("content"), str) and native["content"].strip() else \
            "\n\n".join(p.get("content") for p in parts if p.get("phase") == "answer" and isinstance(p.get("content"), str))
        blocks += _text(answer)
        model = native.get("modelName") or native.get("model")
        if role == "assistant" and model and "model" not in conv["environment"]:
            conv["environment"]["model"] = model
        _add(conv, role, blocks, "qwen-share", source_id=native.get("id"), index=index, created_at=native.get("timestamp"),
             model=model if role == "assistant" else None)
    return _finish(conv, "Qwen")


def _path(pattern: str) -> Callable[[ParseResult], str | None]:
    compiled = re.compile(pattern)
    return lambda parsed: (m.group(1) if (m := compiled.fullmatch(parsed.path)) else None)


def _host(hosts: set[str], pattern: str) -> Callable[[ParseResult], str | None]:
    path = _path(pattern)
    return lambda parsed: path(parsed) if (parsed.hostname or "").lower() in hosts else None


_JSON = {"Accept": "application/json"}

SITES: list[ShareSite] = [
    ShareSite("deepseek-share", "DeepSeek", "deepseek", _host({"chat.deepseek.com"}, r"/share/([A-Za-z0-9]+)/?"),
              lambda id_: (f"https://chat.deepseek.com/api/v0/share/content?share_id={quote(id_)}", None, _JSON),
              read_deepseek_share,
              lambda v: isinstance(v, dict) and isinstance(v.get("data"), dict) and "biz_data" in v["data"]),
    ShareSite("grok-share", "Grok", "xai", _host({"grok.com", "www.grok.com"}, r"/share/([^/]+)/?"),
              lambda id_: (f"https://grok.com/rest/app-chat/share_links_data/{quote(unquote(id_), safe='')}", None, _JSON),
              read_grok_share,
              lambda v: isinstance(v, dict) and isinstance(v.get("responses"), list) and isinstance(v.get("conversation"), dict)),
    ShareSite("perplexity-share", "Perplexity", "perplexity",
              _host({"perplexity.ai", "www.perplexity.ai"}, r"/search/([A-Za-z0-9._-]+)/?"),
              lambda id_: (f"https://www.perplexity.ai/rest/thread/{quote(id_)}?with_parent_info=true&with_schematized_response=true"
                           "&version=2.18&source=default&limit=100&offset=0&from_first=true", None,
                           {**_JSON, "Sec-Fetch-Mode": "navigate"}),
              read_perplexity_share,
              lambda v: isinstance(v, dict) and isinstance(v.get("entries"), list) and "thread_metadata" in v),
    ShareSite("poe-share", "Poe", "poe", _host({"poe.com", "www.poe.com"}, r"/s/([A-Za-z0-9]+)/?"),
              lambda id_: (f"https://poe.com/s/{id_}", None, {}), read_poe_share,
              lambda v: isinstance(v, str) and "__NEXT_DATA__" in v and '"chatShare"' in v),
    ShareSite("mistral-share", "Le Chat", "mistral",
              _host({"chat.mistral.ai"}, r"/chat/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/?"),
              lambda id_: (f"https://chat.mistral.ai/chat/{id_}", None, {}), read_mistral_share,
              lambda v: isinstance(v, str) and "self.__next_f" in v and "chat.mistral.ai" in v),
    ShareSite("kimi-share", "Kimi", "moonshot", _host({"kimi.com", "www.kimi.com"}, r"/share/(?:[a-z]{2}(?:-[A-Za-z]{2})?/)?([a-z0-9]+)/?"),
              lambda id_: ("https://www.kimi.com/apiv2/kimi.gateway.chat.v1.ChatService/GetChatShare",
                           json.dumps({"share_id": id_}).encode(),
                           {**_JSON, "Content-Type": "application/json", "Referer": f"https://www.kimi.com/share/{id_}"}),
              read_kimi_share,
              lambda v: isinstance(v, dict) and isinstance(v.get("share"), dict) and "messages" in v["share"]),
    ShareSite("qwen-share", "Qwen", "qwen",
              _host({"chat.qwen.ai"}, r"/s/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/?"),
              lambda id_: (f"https://chat.qwen.ai/api/v2/chats/share/{id_}", None, {**_JSON, "Referer": "https://chat.qwen.ai/"}),
              read_qwen_share,
              lambda v: isinstance(v, dict) and isinstance(v.get("data"), dict) and isinstance(v["data"].get("chat"), dict)),
]

SITE_READERS = {site.format: site.read for site in SITES}


def share_site(parsed: ParseResult) -> tuple[ShareSite, str] | None:
    """The site and share id of a link, if it is one of these sites'."""
    for site in SITES:
        share_id = site.match(parsed)
        if share_id:
            return site, share_id
    return None
