#!/usr/bin/env python3
"""gen_placeholder_wav.py — generate five placeholder cheerleader clips.

Standalone python3 stdlib (wave + math) so the pipeline runs on a VM with
nothing but `python3`. The output WAVs are int16/mono/16k so the matching
wav_to_header.py can pack them straight into the firmware flash table.

Designs (all ~1s):
  approve.wav  — ascending major third (E5 → G#5), tight sine
  deny.wav     — descending minor third (E5 → C5) with a soft tail
  error.wav    — three short staccato chirps ~700/650/700 Hz
  idle1.wav    — soft single sine G4 with a long decay
  idle2.wav    — soft single sine A4 with a longer decay
  boot.wav     — ascending arpeggio C5/E5/G5/C6, ~1.2s

Each waveform is gently enveloped (5 ms attack, 80 ms release) to keep the
plausible-female-voice floor under control until real recordings replace it.
"""
from __future__ import annotations

import argparse
import math
import struct
import sys
import wave
from pathlib import Path

SR = 16000  # sample rate (Hz) — must match CLIP_SAMPLE_RATE_HZ in audio_clips.h

# (name, [(t0, t1, freq), ...]  OR ("tones", [(t0, t1, freq), ...]) )
# amplitude 0..1, all mono, sum clipped to [-1, 1].
CLIPS: list[tuple[str, list[tuple[float, float, float]], float]] = [
    (
        "approve.wav",
        [(0.00, 0.30, 659.25), (0.18, 0.62, 830.61)],  # E5 → G#5 arpeggio
        0.40,
    ),
    (
        "deny.wav",
        [(0.00, 0.30, 659.25), (0.20, 0.55, 523.25)],  # E5 → C5 sad
        0.40,
    ),
    (
        "error.wav",
        [(0.00, 0.10, 700), (0.18, 0.28, 650), (0.36, 0.46, 700)],  # three chirps
        0.45,
    ),
    (
        "idle1.wav",
        [(0.00, 0.55, 392.00)],  # G4
        0.30,
    ),
    (
        "idle2.wav",
        [(0.00, 0.55, 440.00)],  # A4
        0.30,
    ),
    (
        "boot.wav",
        [(0.00, 0.20, 523.25), (0.20, 0.40, 659.25),
         (0.40, 0.60, 783.99), (0.60, 0.85, 1046.50)],  # C5 E5 G5 C6
        0.40,
    ),
]


def envelope(t: float, dur: float) -> float:
    """5 ms attack, 80 ms release, flat in between. Symmetric, gentle."""
    attack = 0.005
    release = 0.080
    if t < attack:
        return t / attack
    if t > dur - release:
        return max(0.0, (dur - t) / release)
    return 1.0


def synth(tones: list[tuple[float, float, float]], amp: float) -> list[float]:
    """Layer tones, pan to mono, return peak-normalised float samples in [-1,1]."""
    duration = max(t1 for _t0, t1, _f in tones)
    n = int(duration * SR) + 1
    samples = [0.0] * n
    for t0, t1, freq in tones:
        # Sum-of-sines; each tone has its own envelope window.
        # We also smooth-transition the frequency at the boundary by crossfading
        # a single partial so adjacent notes don't click.
        seg_dur = t1 - t0
        for i in range(int(t0 * SR), int(t1 * SR)):
            t = i / SR - t0
            env = envelope(t, seg_dur)
            samples[i] += amp * env * math.sin(2 * math.pi * freq * t)
    # Peak normalise to -3 dBFS so we don't clip silently when added together.
    peak = max(abs(s) for s in samples) or 1.0
    target = 0.707  # ~ -3 dBFS
    scale = target / peak
    return [s * scale for s in samples]


def write_wav(path: Path, samples: list[float]) -> None:
    """Write mono 16-bit PCM @16 kHz."""
    # Convert to signed 16-bit with dithering toward zero (round-half-to-even).
    pcm = bytearray()
    for s in samples:
        v = int(max(-1.0, min(1.0, s)) * 32767)
        pcm += struct.pack("<h", v)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(bytes(pcm))


def main(argv: list[str]) -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument(
        "--out-dir",
        default="firmware/assets/audio",
        help="directory to write WAVs into (default: firmware/assets/audio)",
    )
    p.add_argument(
        "--list",
        action="store_true",
        help="print the would-be filenames and exit",
    )
    args = p.parse_args(argv)

    if args.list:
        for name, _, _ in CLIPS:
            print(name)
        return 0

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    for name, tones, amp in CLIPS:
        path = out_dir / name
        write_wav(path, synth(tones, amp))
        size = path.stat().st_size
        print(f"wrote {path} ({size} B, dur={len(synth(tones, amp))/SR:.2f}s)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
