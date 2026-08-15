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
from .browser import fetch_share_browser
from .detect import FORMAT_ALIASES, canonical_format, detect_text, url_format
from .errors import AcquisitionError, PanagentError
from .model import validate_conversation
from .readers import READERS, read_file
from .web import WEB_READERS, fetch_share
from .writers import WRITERS, Rendered


def _session_id(value: str) -> str:
    try:
        return str(UUID(value))
    except ValueError as exc:
        raise argparse.ArgumentTypeError("session id must be a UUID") from exc


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(
        prog="panagent",
        description="Convert native agent sessions and public chat shares through a provenance-preserving neutral format.",
    )
    result.add_argument("--version", action="version", version=f"%(prog)s {__version__}")
    subparsers = result.add_subparsers(dest="command", required=True)

    convert = subparsers.add_parser("convert", help="convert a conversation or public share")
    convert.add_argument("source", help="input file, '-' for stdin, or a public /share/ URL")
    convert.add_argument(
        "--from",
        dest="source_format",
        choices=sorted(FORMAT_ALIASES),
        help="source format (default: detect)",
    )
    convert.add_argument(
        "--to",
        dest="target_format",
        required=True,
        choices=["ir", "panagent", "claude", "claude-code", "codex", "markdown", "md"],
        help="destination format",
    )
    convert.add_argument("-o", "--output", default="-", help="output file (default: stdout)")
    convert.add_argument(
        "--mode",
        choices=["auto", "context", "transcript"],
        default="auto",
        help="native output strategy; auto uses guarded context for web shares and transcript for native sessions",
    )
    convert.add_argument("--cwd", help="working directory recorded in a generated native session")
    convert.add_argument(
        "--session-id",
        type=_session_id,
        help="destination native session id (default: preserve a UUID source id or generate one)",
    )
    convert.add_argument("--timeout", type=float, default=30.0, help="share request timeout in seconds (default: 30)")
    convert.add_argument(
        "--browser",
        choices=["auto", "never", "headless", "headed"],
        default="auto",
        help="browser fallback for challenged shares (default: auto; Playwright is optional)",
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
    validate.add_argument("--from", dest="source_format", choices=sorted(FORMAT_ALIASES), help="source format (default: detect)")
    validate.add_argument("--quiet", action="store_true")
    validate.set_defaults(handler=_validate)
    return result


def _load(args: argparse.Namespace, *, allow_url: bool) -> tuple[dict[str, Any], str]:
    source = args.source
    detected_url = url_format(source) if "://" in source else None
    if detected_url:
        if not allow_url:
            raise PanagentError("validate accepts local files/stdin; use convert to acquire a share URL")
        source_format = canonical_format(args.source_format) if args.source_format else detected_url
        if source_format not in WEB_READERS:
            raise PanagentError(f"URL does not match source format {source_format}")
        reader = WEB_READERS[source_format]
        if args.browser in {"headless", "headed"} or args.cdp_url:
            text = fetch_share_browser(
                source,
                timeout=args.browser_timeout,
                mode=args.browser,
                cdp_url=args.cdp_url,
                profile=args.browser_profile,
            )
            return reader(text, source_uri=source), source_format
        try:
            text = fetch_share(source, timeout=args.timeout)
            return reader(text, source_uri=source), source_format
        except AcquisitionError:
            if args.browser == "never":
                raise
            text = fetch_share_browser(
                source,
                timeout=args.browser_timeout,
                mode=args.browser,
                profile=args.browser_profile,
            )
            return reader(text, source_uri=source), source_format
    if source == "-":
        text = sys.stdin.read()
        source_uri = None
    else:
        path = Path(source)
        text = read_file(path)
        source_uri = str(path.resolve())
    source_format = canonical_format(args.source_format) if args.source_format else detect_text(text, None if source == "-" else Path(source))
    if source_format in WEB_READERS:
        return WEB_READERS[source_format](text, source_uri=source_uri), source_format
    try:
        reader = READERS[source_format]
    except KeyError as exc:
        raise PanagentError(f"{source_format} is output-only") from exc
    return reader(text, source_uri=source_uri), source_format


def _convert(args: argparse.Namespace) -> int:
    conv, source_format = _load(args, allow_url=True)
    validate_conversation(conv)
    target_format = canonical_format(args.target_format)
    try:
        writer = WRITERS[target_format]
    except KeyError as exc:
        raise PanagentError(f"{target_format} is input-only") from exc
    mode = args.mode
    if mode == "auto":
        mode = "context" if source_format in WEB_READERS and target_format in {"claude-code", "codex"} else "transcript"
    rendered = writer(conv, mode=mode, cwd=args.cwd, session_id=args.session_id)
    _write_output(args.output, rendered.text)
    warnings = [*conv.get("warnings", []), *rendered.warnings]
    report = _report(conv, source_format, target_format, mode, rendered, warnings)
    if args.report:
        _write_output(args.report, json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    if not args.quiet:
        _print_report(report, args.output)
    return 3 if args.fail_on_warning and warnings else 0


def _validate(args: argparse.Namespace) -> int:
    conv, source_format = _load(args, allow_url=False)
    validate_conversation(conv)
    if not args.quiet:
        print(
            f"valid {source_format}: {len(conv['messages'])} messages, {len(conv.get('warnings', []))} warnings",
            file=sys.stderr,
        )
    return 0


def _report(
    conv: dict[str, Any],
    source_format: str,
    target_format: str,
    mode: str,
    rendered: Rendered,
    warnings: list[dict[str, Any]],
) -> dict[str, Any]:
    blocks: dict[str, int] = {}
    roles: dict[str, int] = {}
    for item in conv["messages"]:
        roles[item["role"]] = roles.get(item["role"], 0) + 1
        for block in item["content"]:
            kind = block["type"]
            blocks[kind] = blocks.get(kind, 0) + 1
    return {
        "source_format": source_format,
        "target_format": target_format,
        "mode": mode,
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
    for item in report["warnings"]:
        location = f" [{item['path']}]" if item.get("path") else ""
        print(f"panagent: {item.get('severity', 'warning')}: {item.get('code', 'warning')}{location}: {item.get('message', '')}", file=sys.stderr)


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
    except (PanagentError, OSError) as exc:
        print(f"panagent: error: {exc}", file=sys.stderr)
        return 2
