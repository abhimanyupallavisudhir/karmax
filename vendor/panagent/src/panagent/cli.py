from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
from pathlib import Path
from typing import Any, Sequence
from uuid import UUID

from . import __version__
from .api import NATIVE_TARGETS, install, load, parse, render
from .detect import FORMAT_ALIASES, canonical_format, detect_text
from .errors import PanagentError
from .readers import READERS, read_file
from .web import WEB_READERS, list_conversations
from .writers import WRITERS, Rendered

INPUTS = sorted(name for name, fmt in FORMAT_ALIASES.items() if fmt in READERS or fmt in WEB_READERS)
OUTPUTS = sorted(name for name, fmt in FORMAT_ALIASES.items() if fmt in WRITERS)


def _session_id(value: str) -> str:
    try:
        return str(UUID(value))
    except ValueError as exc:
        raise argparse.ArgumentTypeError("session id must be a UUID") from exc


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(
        prog="panagent",
        description="Move conversations between Claude Code, Codex, ChatGPT, Claude and tavya through a provenance-preserving neutral format.",
    )
    result.add_argument("--version", action="version", version=f"%(prog)s {__version__}")
    subparsers = result.add_subparsers(dest="command", required=True)

    convert = subparsers.add_parser("convert", help="convert a conversation or public share")
    convert.add_argument("source", help="input file, '-' for stdin, or a public share URL")
    convert.add_argument("--from", dest="source_format", choices=INPUTS, help="source format (default: detect)")
    convert.add_argument("--to", dest="target_format", required=True, choices=OUTPUTS, help="destination format")
    destination = convert.add_mutually_exclusive_group()
    destination.add_argument("-o", "--output", default="-", help="output file (default: stdout)")
    destination.add_argument(
        "--install",
        action="store_true",
        help="add the result to the destination CLI's own history as a new session and print its resume command",
    )
    convert.add_argument("--conversation", help="conversation id or exact title, for exports holding several")
    convert.add_argument(
        "--mode",
        choices=["auto", "context", "transcript"],
        default="auto",
        help="native output strategy; auto uses guarded context for web chats and transcript for agent sessions",
    )
    convert.add_argument("--cwd", help="working directory recorded in a generated native session (--install: default current)")
    convert.add_argument(
        "--session-id",
        type=_session_id,
        help="destination native session id (default: preserve a UUID source id; --install: a new id)",
    )
    convert.add_argument("--timeout", type=float, default=30.0, help="share request timeout in seconds (default: 30)")
    convert.add_argument(
        "--browser",
        choices=["auto", "never", "headless", "headed"],
        default="auto",
        help="browser fallback for challenged ChatGPT/Claude shares (default: auto; Playwright is optional)",
    )
    convert.add_argument(
        "--browser-timeout",
        type=float,
        default=120.0,
        help="seconds to wait for browser rendering or a user-completed challenge (default: 120)",
    )
    convert.add_argument("--cdp-url", help="connect to an existing Chrome debugging endpoint, for example http://127.0.0.1:9222")
    convert.add_argument("--browser-profile", help="dedicated Chrome/Chromium profile directory used by browser acquisition")
    convert.add_argument("--report", help="write a machine-readable conversion/loss report")
    convert.add_argument("--quiet", action="store_true", help="do not print warnings or summary to stderr")
    convert.add_argument("--fail-on-warning", action="store_true", help="return exit status 3 when any warning is emitted")
    convert.set_defaults(handler=_convert)

    validate = subparsers.add_parser("validate", help="parse and validate an input without converting it")
    validate.add_argument("source", help="input file or '-' for stdin")
    validate.add_argument("--from", dest="source_format", choices=INPUTS, help="source format (default: detect)")
    validate.add_argument("--conversation", help="conversation id or exact title, for exports holding several")
    validate.add_argument("--quiet", action="store_true")
    validate.set_defaults(handler=_validate)

    listing = subparsers.add_parser("list", help="list the conversations in a ChatGPT or Claude data export")
    listing.add_argument("source", help="conversations.json, or '-' for stdin")
    listing.add_argument("--from", dest="source_format", choices=INPUTS, help="source format (default: detect)")
    listing.set_defaults(handler=_list)
    return result


def _read_source(source: str) -> str:
    if source == "-":
        return sys.stdin.read()
    if "://" in source:
        raise PanagentError("this command reads local files or stdin; use convert for a share URL")
    return read_file(Path(source))


def _load(args: argparse.Namespace, *, allow_url: bool) -> dict[str, Any]:
    if args.source == "-" or not allow_url:
        return parse(_read_source(args.source), args.source_format, conversation=args.conversation)
    return load(
        args.source,
        args.source_format,
        conversation=args.conversation,
        timeout=args.timeout,
        browser=args.browser,
        browser_timeout=args.browser_timeout,
        cdp_url=args.cdp_url,
        browser_profile=args.browser_profile,
    )


def _convert(args: argparse.Namespace) -> int:
    conv = _load(args, allow_url=True)
    options = {"mode": args.mode, "cwd": args.cwd, "session_id": args.session_id}
    if args.install:
        if canonical_format(args.target_format) not in NATIVE_TARGETS:
            raise PanagentError("--install needs --to claude-code or --to codex")
        installed = install(conv, args.target_format, **options)
        rendered, destination = installed.rendered, str(installed.path)
        print(installed.command)
    else:
        rendered, destination = render(conv, args.target_format, **options), args.output
        _write_output(args.output, rendered.text)
    warnings = [*conv.get("warnings", []), *rendered.warnings]
    report = _report(conv, rendered, warnings)
    if args.report:
        _write_output(args.report, json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    if not args.quiet:
        _print_report(report, destination)
    return 3 if args.fail_on_warning and any(item.get("severity", "warning") != "info" for item in warnings) else 0


def _validate(args: argparse.Namespace) -> int:
    conv = _load(args, allow_url=False)
    if not args.quiet:
        print(
            f"valid {conv['source']['format']}: {len(conv['messages'])} messages, {len(conv.get('warnings', []))} warnings",
            file=sys.stderr,
        )
    return 0


def _list(args: argparse.Namespace) -> int:
    text = _read_source(args.source)
    fmt = canonical_format(args.source_format) if args.source_format else detect_text(text)
    if fmt in {"chatgpt-share", "claude-share"} and text.lstrip("\ufeff \t\r\n").startswith(("[", "{")):
        rows = list_conversations(text, fmt)
    else:
        conv = parse(text, fmt)
        rows = [{"id": conv["id"], "title": conv.get("title") or "", "updated_at": conv.get("updated_at"),
                 "messages": len(conv["messages"])}]
    for row in rows:
        print("\t".join([str(row["id"] or ""), (row["updated_at"] or "")[:10], str(row["messages"]), row["title"]]))
    return 0


def _report(conv: dict[str, Any], rendered: Rendered, warnings: list[dict[str, Any]]) -> dict[str, Any]:
    blocks: dict[str, int] = {}
    roles: dict[str, int] = {}
    for item in conv["messages"]:
        roles[item["role"]] = roles.get(item["role"], 0) + 1
        for block in item["content"]:
            kind = block["type"]
            blocks[kind] = blocks.get(kind, 0) + 1
    return {
        "source_format": conv["source"]["format"],
        "target_format": rendered.format,
        "mode": rendered.mode,
        "conversation_id": conv.get("id"),
        "messages": len(conv["messages"]),
        "roles": roles,
        "content_blocks": blocks,
        "capabilities": conv.get("capabilities", {}),
        "warnings": warnings,
        "output_bytes": len(rendered.text.encode("utf-8")),
    }


def _print_report(report: dict[str, Any], output: str) -> None:
    destination = "stdout" if output == "-" else output
    print(
        f"panagent: {report['source_format']} -> {report['target_format']} ({report['mode']}): "
        f"{report['messages']} messages written to {destination}",
        file=sys.stderr,
    )
    # Readers warn once per affected record; one line per code is enough on a terminal.
    grouped: dict[str, list[dict[str, Any]]] = {}
    for item in report["warnings"]:
        grouped.setdefault(item.get("code", "warning"), []).append(item)
    for code, items in grouped.items():
        count = f" ({len(items)}x)" if len(items) > 1 else ""
        print(f"panagent: {items[0].get('severity', 'warning')}: {code}{count}: {items[0].get('message', '')}", file=sys.stderr)


def _write_output(target: str, content: str) -> None:
    if target == "-":
        sys.stdout.write(content)
        return
    path = Path(target)
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent, text=True)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="") as handle:
            handle.write(content)
        os.replace(temporary, path)
    except BaseException:
        try:
            os.unlink(temporary)
        except OSError:
            pass
        raise


def main(argv: Sequence[str] | None = None) -> int:
    args = parser().parse_args(argv)
    try:
        return int(args.handler(args))
    except (PanagentError, OSError, UnicodeError, ValueError, TypeError, KeyError) as exc:
        print(f"panagent: error: {exc}", file=sys.stderr)
        return 2
