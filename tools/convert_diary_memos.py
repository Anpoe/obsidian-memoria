"""Convert memo sections from the Curtains diary into Memoria's format.

The converter is intentionally standalone and uses only Python's standard
library.  It reads the source diary files, never edits them, and writes yearly
Markdown files that Memoria can parse directly.

Typical use on Windows:

    python tools/convert_diary_memos.py --copy-assets

Use --dry-run first when working with a different source or output folder.
"""

from __future__ import annotations

import argparse
import re
import shutil
import sys
from collections import defaultdict
from dataclasses import dataclass
from datetime import date
from pathlib import Path


DEFAULT_SOURCE = Path(r"D:\Obsidian 库\Curtains\D-日记")
DEFAULT_VAULT = Path(r"D:\Obsidian 库\Memoria-Dev-Vault")
DEFAULT_OUTPUT_FOLDER = "Memoria"

MEMOS_HEADING_RE = re.compile(r"^(?P<hashes>#{1,6})\s+memos\s*$", re.IGNORECASE)
ATX_HEADING_RE = re.compile(r"^(?P<hashes>#{1,6})(?:\s+|$)")
MEMO_START_RE = re.compile(
    r"^-\s+"
    r"(?:(?P<task>\[[ xX]\])\s+)?"
    r"(?P<time>(?:[01]?\d|2[0-3]):[0-5]\d)"
    r"(?:[ \t]+(?P<inline>.*?))?[ \t]*$"
)
DATE_IN_NAME_RE = re.compile(
    r"(?P<year>\d{4})年(?P<month>\d{1,2})月(?P<day>\d{1,2})日"
)
DATE_IN_TEXT_RE = re.compile(
    r"(?P<year>\d{4})[-年/](?P<month>\d{1,2})[-月/](?P<day>\d{1,2})日?"
)
FRONTMATTER_DATE_RE = re.compile(
    r"^date:\s*['\"]?(?P<date>\d{4}-\d{1,2}-\d{1,2})",
    re.IGNORECASE,
)
DELETED_MARKER_RE = re.compile(r"\[deleted::[^\]]+\]", re.IGNORECASE)
ARCHIVED_LINE_RE = re.compile(r"^\s*\[archived::(?:true|false)\]\s*$", re.IGNORECASE)
IMAGE_WIKILINK_RE = re.compile(r"!\[\[([^\]|#]+)(\|[^\]]*)?\]\]")

WEEKDAYS_CN = ("周一", "周二", "周三", "周四", "周五", "周六", "周日")


@dataclass
class Memo:
    date: str
    time: str
    content: str
    source: str
    line: int
    had_task_marker: bool = False


@dataclass
class Report:
    files_seen: int = 0
    files_with_sections: int = 0
    files_with_orphan_memos: int = 0
    files_skipped_no_date: int = 0
    files_skipped_no_memos: int = 0
    memos_found: int = 0
    memos_converted: int = 0
    memos_skipped_deleted: int = 0
    task_markers_normalized: int = 0
    missing_assets: int = 0
    copied_assets: int = 0


def read_text(path: Path) -> str:
    """Read normal UTF-8 files and gracefully handle legacy GB18030 files."""

    try:
        return path.read_text(encoding="utf-8-sig")
    except UnicodeDecodeError:
        return path.read_text(encoding="gb18030")


def parse_date_from_text(value: str) -> str | None:
    match = DATE_IN_TEXT_RE.search(value)
    if not match:
        return None
    try:
        parsed = date(
            int(match.group("year")),
            int(match.group("month")),
            int(match.group("day")),
        )
    except ValueError:
        return None
    return parsed.isoformat()


def extract_date(path: Path, text: str) -> str | None:
    """Prefer the diary filename, then frontmatter, then a date heading."""

    name_match = DATE_IN_NAME_RE.search(path.stem)
    if name_match:
        try:
            return date(
                int(name_match.group("year")),
                int(name_match.group("month")),
                int(name_match.group("day")),
            ).isoformat()
        except ValueError:
            pass

    for line in text.splitlines()[:40]:
        frontmatter_match = FRONTMATTER_DATE_RE.match(line.strip())
        if frontmatter_match:
            parsed = parse_date_from_text(frontmatter_match.group("date"))
            if parsed:
                return parsed

    for line in text.splitlines():
        if line.startswith("#"):
            parsed = parse_date_from_text(line)
            if parsed:
                return parsed
    return None


def section_ranges(lines: list[str]) -> list[tuple[int, int]]:
    """Return ranges belonging to one or more top-level `memos` sections."""

    ranges: list[tuple[int, int]] = []
    for index, line in enumerate(lines):
        match = MEMOS_HEADING_RE.match(line)
        if not match:
            continue
        level = len(match.group("hashes"))
        end = len(lines)
        for candidate in range(index + 1, len(lines)):
            heading = ATX_HEADING_RE.match(lines[candidate])
            if heading and len(heading.group("hashes")) <= level:
                end = candidate
                break
        ranges.append((index + 1, end))
    return ranges


def unindent_source_line(line: str) -> str:
    """Remove one source memo indentation level while preserving nested lists."""

    if line.startswith("\t"):
        return line[1:]
    if line.startswith("    "):
        return line[4:]
    if line.startswith("  "):
        return line[2:]
    return line


def clean_body(lines: list[str], inline: str | None) -> str:
    body: list[str] = []
    if inline and inline.strip():
        body.append(inline.rstrip())
    body.extend(lines)

    cleaned: list[str] = []
    for line in body:
        if ARCHIVED_LINE_RE.match(line):
            continue
        line = DELETED_MARKER_RE.sub("", line).rstrip()
        if line.strip():
            cleaned.append(unindent_source_line(line))
        else:
            cleaned.append("")

    while cleaned and not cleaned[0].strip():
        cleaned.pop(0)
    while cleaned and not cleaned[-1].strip():
        cleaned.pop()
    return "\n".join(cleaned)


def extract_memos(
    lines: list[str],
    source_name: str,
    memo_date: str,
    include_orphans: bool,
    include_deleted: bool,
    report: Report,
) -> list[Memo]:
    ranges = section_ranges(lines)
    if ranges:
        report.files_with_sections += 1
    elif not include_orphans:
        report.files_skipped_no_memos += 1
        return []
    else:
        ranges = [(0, len(lines))]
        report.files_with_orphan_memos += 1

    result: list[Memo] = []
    for start, end in ranges:
        starts: list[tuple[int, re.Match[str]]] = []
        for index in range(start, end):
            match = MEMO_START_RE.fullmatch(lines[index])
            if match:
                starts.append((index, match))

        for position, (index, match) in enumerate(starts):
            next_index = starts[position + 1][0] if position + 1 < len(starts) else end
            raw_body = lines[index + 1 : next_index]
            raw_text = "\n".join(raw_body)
            if match.group("inline"):
                raw_text = f"{match.group('inline')}\n{raw_text}"

            report.memos_found += 1
            if DELETED_MARKER_RE.search(raw_text):
                if not include_deleted:
                    report.memos_skipped_deleted += 1
                    continue

            normalized_time = match.group("time")
            hour, minute = normalized_time.split(":")
            normalized_time = f"{int(hour):02d}:{minute}"
            content = clean_body(raw_body, match.group("inline"))
            result.append(
                Memo(
                    date=memo_date,
                    time=normalized_time,
                    content=content,
                    source=source_name,
                    line=index + 1,
                    had_task_marker=bool(match.group("task")),
                )
            )
            report.memos_converted += 1
            if match.group("task"):
                report.task_markers_normalized += 1
    return result


def render_year(year: str, memos: list[Memo]) -> str:
    lines = [f"# {year}", ""]
    current_date = ""
    for memo in memos:
        if memo.date != current_date:
            if current_date:
                lines.append("")
            current_date = memo.date
            parsed = date.fromisoformat(memo.date)
            lines.extend([f"## {memo.date} {WEEKDAYS_CN[parsed.weekday()]}", ""])

        lines.append(f"- {memo.time}")
        if memo.content:
            for body_line in memo.content.splitlines():
                lines.append(f"  {body_line}" if body_line else "")
        lines.append("")

    return "\n".join(lines).rstrip() + "\n"


def find_asset(asset_root: Path, diary_root: Path, reference: str) -> Path | None:
    reference_path = Path(reference.replace("/", "\\"))
    candidates = [diary_root / reference_path, asset_root / reference_path]
    for candidate in candidates:
        if candidate.is_file():
            return candidate

    basename = reference_path.name
    matches = list(asset_root.rglob(basename))
    return matches[0] if matches else None


def copy_and_rewrite_assets(
    memos: list[Memo],
    diary_root: Path,
    asset_root: Path,
    output_root: Path,
    vault_root: Path,
    report: Report,
) -> None:
    """Copy local Obsidian image embeds and rewrite them to vault-relative paths."""

    assets_dir = output_root / "attachments"
    copied: dict[str, str] = {}
    source_for_name: dict[str, Path | None] = {}

    for memo in memos:
        for match in IMAGE_WIKILINK_RE.finditer(memo.content):
            reference = match.group(1).strip()
            if reference.lower().startswith(("http://", "https://")):
                continue
            if reference not in source_for_name:
                source_for_name[reference] = find_asset(asset_root, diary_root, reference)

    for reference, source in source_for_name.items():
        if source is None:
            report.missing_assets += 1
            continue
        assets_dir.mkdir(parents=True, exist_ok=True)
        target = assets_dir / source.name
        if target.exists() and target.read_bytes() != source.read_bytes():
            stem = target.stem
            suffix = target.suffix
            counter = 2
            while True:
                candidate = assets_dir / f"{stem}-{counter}{suffix}"
                if not candidate.exists() or candidate.read_bytes() == source.read_bytes():
                    target = candidate
                    break
                counter += 1
        if not target.exists():
            shutil.copy2(source, target)
            report.copied_assets += 1
        relative = target.relative_to(vault_root).as_posix()
        copied[reference] = relative

    if not copied:
        return

    for memo in memos:
        def replace(match: re.Match[str]) -> str:
            reference = match.group(1).strip()
            replacement = copied.get(reference)
            if not replacement:
                return match.group(0)
            alias = match.group(2) or ""
            return f"![[{replacement}{alias}]]"

        memo.content = IMAGE_WIKILINK_RE.sub(replace, memo.content)


def convert(args: argparse.Namespace) -> int:
    source = args.source.resolve()
    vault = args.vault.resolve()
    output_root = (vault / args.output_folder).resolve()
    if not source.is_dir():
        print(f"Source directory does not exist: {source}", file=sys.stderr)
        return 2
    if not vault.is_dir():
        print(f"Vault directory does not exist: {vault}", file=sys.stderr)
        return 2

    if not args.dry_run:
        output_root.mkdir(parents=True, exist_ok=True)
    report = Report()
    memos: list[Memo] = []

    for path in sorted(source.rglob("*.md")):
        report.files_seen += 1
        text = read_text(path)
        memo_date = extract_date(path, text)
        if memo_date is None:
            report.files_skipped_no_date += 1
            continue
        lines = text.splitlines()
        memos.extend(
            extract_memos(
                lines,
                str(path.relative_to(source)),
                memo_date,
                args.include_orphans,
                args.include_deleted,
                report,
            )
        )

    memos.sort(key=lambda memo: (memo.date, memo.time, memo.source, memo.line))

    if args.copy_assets and memos and not args.dry_run:
        copy_and_rewrite_assets(
            memos,
            source,
            args.asset_root.resolve(),
            output_root,
            vault,
            report,
        )

    by_year: dict[str, list[Memo]] = defaultdict(list)
    for memo in memos:
        by_year[memo.date[:4]].append(memo)

    if not args.dry_run:
        existing = [output_root / f"{year}.md" for year in sorted(by_year)]
        conflicts = [path for path in existing if path.exists()]
        if conflicts and not args.overwrite:
            print("Refusing to overwrite existing output files:", file=sys.stderr)
            for path in conflicts:
                print(f"  {path}", file=sys.stderr)
            print("Use --overwrite if this is an intentional rerun.", file=sys.stderr)
            return 2
        for year, year_memos in by_year.items():
            (output_root / f"{year}.md").write_text(
                render_year(year, year_memos), encoding="utf-8", newline="\n"
            )

    print(f"Source files scanned: {report.files_seen}")
    print(f"Files with # memos: {report.files_with_sections}")
    print(f"Files with orphan time memos included: {report.files_with_orphan_memos}")
    print(f"Files skipped without a usable date: {report.files_skipped_no_date}")
    print(f"Files skipped without # memos: {report.files_skipped_no_memos}")
    print(f"Memos found: {report.memos_found}")
    print(f"Memos converted: {report.memos_converted}")
    print(f"Deleted memos skipped: {report.memos_skipped_deleted}")
    print(f"Task-style timestamps normalized: {report.task_markers_normalized}")
    if args.copy_assets:
        print(f"Local image assets copied: {report.copied_assets}")
        print(f"Local image assets not found: {report.missing_assets}")
    print(f"Output folder: {output_root}")
    print(f"Output years: {', '.join(sorted(by_year)) or '(none)'}")
    if args.dry_run:
        print("Dry run: no yearly Markdown files were written.")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Convert Curtains diary # memos sections into Memoria yearly Markdown files."
    )
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE)
    parser.add_argument("--vault", type=Path, default=DEFAULT_VAULT)
    parser.add_argument("--output-folder", default=DEFAULT_OUTPUT_FOLDER)
    parser.add_argument(
        "--asset-root",
        type=Path,
        default=DEFAULT_SOURCE.parent,
        help="Vault root to search for local ![[image]] embeds.",
    )
    parser.add_argument(
        "--include-orphans",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Include time bullets in files without a # memos heading (default: yes).",
    )
    parser.add_argument(
        "--include-deleted",
        action="store_true",
        help="Include memo blocks containing [deleted::...] markers.",
    )
    parser.add_argument(
        "--copy-assets",
        action="store_true",
        help="Copy local image embeds into <output-folder>/attachments and rewrite links.",
    )
    parser.add_argument("--overwrite", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    return parser


def main() -> int:
    return convert(build_parser().parse_args())


if __name__ == "__main__":
    raise SystemExit(main())
