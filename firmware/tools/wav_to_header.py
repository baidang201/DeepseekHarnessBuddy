#!/usr/bin/env python3
"""wav_to_header.py — pack 16 kHz / 16-bit / mono WAVs into a C header.

Reads each path argument in order and emits a single .h file that follows the
audio_clips_data.h contract:

    static const int16_t kClipPcm_Approve[] CLIP_PROGMEM = { ... };
    static const int16_t kClipPcm_Deny[]    CLIP_PROGMEM = { ... };
    ...
    static const size_t kClipSamples_Approve = ...;
    ...
    #define CLIP_TABLE_INIT { \
        { kClipPcm_Approve, kClipSamples_Approve }, \
        { kClipPcm_Deny,    kClipSamples_Deny    }, \
        ... \
    }

CLIP_PROGMEM expands to PROGMEM when Arduino/ESP headers are present, and to
nothing in standalone syntax-check builds. .rodata already lives in flash on
the device, so the attribute is informational on real hardware — but it lets
the validator (g++ -fsyntax-only on a vanilla VM) compile without pulling in
pgmspace.h.

Each sample is little-endian int16, mono, 16 kHz. Inputs that disagree are
rejected with a non-zero exit code — that prevents accidentally shipping 44.1
kHz stereo or 8-bit material to the device.

Usage:
    python3 wav_to_header.py --out src/audio_clips_data.h src/approve.wav ...
"""
from __future__ import annotations

import argparse
import struct
import sys
import wave
from pathlib import Path

EXPECTED_RATE = 16000
EXPECTED_CHANNELS = 1
EXPECTED_SAMPWIDTH = 2  # bytes per sample (16-bit PCM)

# Stable order tied to Clip enum in audio_clips.h. Edit together or the wiring
# shifts and the device plays the wrong word for the wrong action.
NAME_ORDER = ["approve", "deny", "error", "idle1", "idle2", "boot"]


def read_wav(path: Path) -> bytes:
    """Open a WAV and validate format. Return raw little-endian int16 bytes."""
    with wave.open(str(path), "rb") as w:
        if w.getframerate() != EXPECTED_RATE:
            raise SystemExit(
                f"{path}: rate={w.getframerate()} Hz, expected {EXPECTED_RATE} Hz"
            )
        if w.getnchannels() != EXPECTED_CHANNELS:
            raise SystemExit(
                f"{path}: channels={w.getnchannels()}, expected mono"
            )
        if w.getsampwidth() != EXPECTED_SAMPWIDTH:
            raise SystemExit(
                f"{path}: sampwidth={w.getsampwidth()} B, expected {EXPECTED_SAMPWIDTH} B (16-bit PCM)"
            )
        if w.getcomptype() != "NONE":
            raise SystemExit(f"{path}: compressed WAVs are not supported")
        return w.readframes(w.getnframes())


def render_header(out: Path, samples: dict[str, int], arrays: dict[str, list[int]]) -> None:
    parts: list[str] = []
    parts.append("""#pragma once

#include <stdint.h>
#include <stddef.h>
#include "audio_clips.h"

// PROGMEM comes from <pgmspace.h> (Arduino/ESP). On a vanilla validator build
// (g++ -fsyntax-only with no M5Unified install) the macro is undefined, so we
// fall through to plain const — harmless since the device's .rodata lives in
// flash regardless.
#ifndef CLIP_PROGMEM
#define CLIP_PROGMEM
#endif

// --- Clip payloads ----------------------------------------------------------
""")
    for name in NAME_ORDER:
        arr = arrays[name]
        parts.append(
            f"static const int16_t kClipPcm_{name.capitalize()}[] CLIP_PROGMEM = {{"
        )
        # 12 samples per line keeps reads aligned
        for i in range(0, len(arr), 12):
            chunk = ", ".join(str(v) for v in arr[i:i + 12])
            parts.append(f"  {chunk},")
        parts.append("};")
        parts.append(f"static const size_t kClipSamples_{name.capitalize()} = {samples[name]};")
        parts.append("")

    parts.append("// Initialiser for the kClipTable inside audio_clips.cpp. Order MUST")
    parts.append("// follow the Clip enum (Approve, Deny, Error, Idle1, Idle2, Boot).")
    parts.append("#define CLIP_TABLE_INIT { \\")
    for name in NAME_ORDER:
        parts.append(f"  {{ kClipPcm_{name.capitalize()}, kClipSamples_{name.capitalize()} }}, \\")
    parts.append("}")
    parts.append("")

    out.write_text("\n".join(parts))


def main(argv: list[str]) -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--out", type=Path, required=True, help="output header path")
    p.add_argument(
        "--names",
        default=",".join(NAME_ORDER),
        help=(
            "comma-separated clip names matching input order "
            f"(default: {','.join(NAME_ORDER)})"
        ),
    )
    p.add_argument(
        "wavs",
        nargs="+",
        type=Path,
        help="input WAVs (must be 16 kHz / 16-bit / mono)",
    )
    args = p.parse_args(argv)

    names = args.names.split(",")
    if len(names) != len(args.wavs):
        raise SystemExit(
            f"expected {len(names)} WAVs (names={names}), got {len(args.wavs)}"
        )
    for want, got in zip(names, args.wavs):
        if got.stem != want:
            raise SystemExit(
                f"input order mismatch: --names said {want!r} but file is {got.name!r}"
            )

    samples: dict[str, int] = {}
    arrays: dict[str, list[int]] = {}
    for name, path in zip(names, args.wavs):
        raw = read_wav(path)
        # unpack little-endian signed 16-bit
        n = len(raw) // 2
        array = list(struct.unpack(f"<{n}h", raw))
        samples[name] = n
        arrays[name] = array
        print(f"packed {path.name}: {n} samples, {len(raw)} B")

    render_header(args.out, samples, arrays)
    print(f"wrote {args.out} ({args.out.stat().st_size} B)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
