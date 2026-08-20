#!/usr/bin/env python3
"""
validate_character.py — character-pack sanity checker.

Verifies that a `characters/<name>/` folder is loadable by the firmware:

  * manifest.json parses and declares a ``name`` + ``colors`` + ``states``
  * every GIF referenced by the manifest exists, is 96x100, and is decodable
  * there are no stray/orphan GIF files (manifest <-> files are 1:1)
  * the whole pack fits the size budget (default 600 KB)

Prints a PASS/FAIL report and exits non-zero if anything fails, so it can
be used as a CI gate:

    python3 tools/validate_character.py firmware/characters/encourager

Usage:
    python3 tools/validate_character.py <character-dir> [--budget-kb 600]
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from PIL import Image, ImageSequence

EXPECTED_W, EXPECTED_H = 96, 100
DEFAULT_BUDGET_KB = 600

KNOWN_STATES = {"sleep", "idle", "busy", "attention", "dizzy",
                "celebrate", "heart"}


def _collect_expected(states):
    """Flatten the manifest ``states`` map into a set of GIF filenames."""
    expected = set()
    if not isinstance(states, dict):
        return expected
    for key, val in states.items():
        if isinstance(val, list):
            for entry in val:
                expected.add(entry)
        elif isinstance(val, str):
            expected.add(val)
    return expected


def validate(pack_dir: Path, budget_bytes: int):
    errors = []
    warnings = []
    rows = []  # (name, frames, bytes, note)

    manifest_path = pack_dir / "manifest.json"
    if not manifest_path.exists():
        errors.append("manifest.json missing")
        return errors, warnings, rows, 0

    try:
        manifest = json.loads(manifest_path.read_text())
    except Exception as exc:  # noqa: BLE001
        errors.append(f"manifest.json is not valid JSON: {exc}")
        return errors, warnings, rows, 0

    if not manifest.get("name"):
        errors.append("manifest.json: 'name' is missing/empty")
    if not isinstance(manifest.get("colors"), dict):
        errors.append("manifest.json: 'colors' block missing")
    states = manifest.get("states")
    if not isinstance(states, dict):
        errors.append("manifest.json: 'states' block missing/not a dict")

    expected = _collect_expected(states) if isinstance(states, dict) else set()
    total = 0

    # 1) every manifest-referenced GIF must exist and be well-formed
    for name in sorted(expected):
        path = pack_dir / name
        if not path.exists():
            errors.append(f"missing file for manifest entry: {name}")
            rows.append((name, "-", "-", "MISSING"))
            continue
        try:
            with Image.open(path) as im:
                im.load()  # force decode of the first frame
                size = im.size
                nframes = sum(1 for _ in ImageSequence.Iterator(im))
        except Exception as exc:  # noqa: BLE001
            errors.append(f"{name}: cannot decode GIF ({exc})")
            rows.append((name, "-", "-", "UNREADABLE"))
            continue
        note = "ok"
        if size != (EXPECTED_W, EXPECTED_H):
            errors.append(f"{name}: wrong size {size} (expected "
                          f"{EXPECTED_W}x{EXPECTED_H})")
            note = f"size {size[0]}x{size[1]}"
        if name.lower().endswith(".gif") is False:
            errors.append(f"{name}: not a .gif")
        b = path.stat().st_size
        total += b
        rows.append((name, nframes, b, note))

    # 2) no orphan GIFs (manifest <-> files 1:1)
    for gif in sorted(pack_dir.glob("*.gif")):
        if gif.name not in expected:
            errors.append(f"orphan GIF not referenced by manifest: {gif.name}")
            b = gif.stat().st_size
            total += b
            rows.append((gif.name, "-", b, "ORPHAN"))

    # 3) total budget
    if total > budget_bytes:
        errors.append(f"pack too large: {total:,}B > budget {budget_bytes:,}B")
    elif total > budget_bytes * 0.9:
        warnings.append(f"pack near budget: {total:,}B "
                        f"({(total/budget_bytes*100):.0f}% of "
                        f"{budget_bytes:,}B)")

    return errors, warnings, rows, total


def _fmt_rows(rows):
    out = []
    out.append(f"  {'file':14s} {'frames':>6s} {'bytes':>9s}  note")
    out.append("  " + "-" * 40)
    for name, nframes, b, note in rows:
        out.append(f"  {name:14s} {str(nframes):>6s} {b:>9,}  {note}")
    return "\n".join(out)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("pack", help="character pack directory")
    ap.add_argument("--budget-kb", type=int, default=DEFAULT_BUDGET_KB,
                    help=f"total size budget in KB (default {DEFAULT_BUDGET_KB})")
    args = ap.parse_args(argv)

    pack_dir = Path(args.pack)
    if not pack_dir.is_dir():
        print(f"FAIL: not a directory: {pack_dir}")
        return 2

    errors, warnings, rows, total = validate(pack_dir, args.budget_kb * 1024)

    print(f"character pack: {pack_dir}")
    print(_fmt_rows(rows))
    print(f"  {'':14s} {'':>6s} {total:>9,}  total"
          f"  (budget {args.budget_kb*1024:,}B)")
    for w in warnings:
        print(f"  WARNING: {w}")
    print()

    if errors:
        print("RESULT: FAIL")
        for e in errors:
            print(f"  - {e}")
        return 1

    print("RESULT: PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
