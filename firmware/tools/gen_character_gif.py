#!/usr/bin/env python3
"""
gen_character_gif.py — parametric 96x100 character GIF generator (PIL).

The hardware-buddy character system loads one GIF per visual state from a
`characters/<name>/` folder (see `characters/bufo/manifest.json` for the
shape of the contract). Every GIF must be **96x100** pixels. This tool
produces those GIFs from simple PIL drawing callbacks so a new character
can be wired up end-to-end with placeholder art, then swapped for real
anime assets later without touching any tooling.

Two ways to drive it
--------------------
1. As a library — call :func:`build_state` / :func:`save_gif` from your own
   per-frame draw callbacks (the "状态名 + 帧数 + 每帧绘制回调配置" API).

2. From the command line:

     # Emit the full placeholder "encourager" pack (manifest + all GIFs):
     python3 tools/gen_character_gif.py --placeholder \
         --out firmware/characters/encourager

     # Hand-generate a single state with the built-in placeholder drawer
     # (this is what --placeholder uses under the hood):
     python3 tools/gen_character_gif.py --state busy --frames 4 \
         --color "#FF9800" --motion typewriter --out busy.gif

The placeholder art is intentionally crude (round stick figures) so the
real anime assets can be dropped in later. See
`characters/encourager/README.md` for the replacement workflow.
"""
from __future__ import annotations

import argparse
import json
import math
import random
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

# --------------------------------------------------------------------------
# Constants
# --------------------------------------------------------------------------
W, H = 96, 100
DEFAULT_BG = (14, 14, 18)  # dark, screen-matched background

# state -> (top-left abbreviation label, default accent color rgb)
STATE_META = {
    "sleep":     ("slp", (91, 107, 142)),
    "idle":      ("idl", (76, 175, 80)),
    "busy":      ("bsy", (255, 152, 0)),
    "attention": ("att", (255, 235, 59)),
    "dizzy":     ("dzy", (156, 39, 176)),
    "celebrate": ("cel", (233, 30, 99)),
    "heart":     ("hrt", (244, 67, 54)),
}

# Per-state placeholder recipe: how many frames, per-frame duration (ms),
# and which built-in motion to use. Idle is a list of variants so the home
# screen can rotate through several "breathing" clips like bufo does.
PLACEHOLDER_RECIPE = {
    "sleep":     dict(frames=1,  duration=600, motion="sleep"),
    "idle":      dict(frames=6,  duration=130, motion="breathe"),
    "busy":      dict(frames=4,  duration=90,  motion="typewriter"),
    "attention": dict(frames=6,  duration=120, motion="wave"),
    "dizzy":     dict(frames=8,  duration=110, motion="tilt"),
    "celebrate": dict(frames=12, duration=80,  motion="confetti"),
    "heart":     dict(frames=10, duration=110, motion="heart"),
}
IDLE_VARIANTS = 4


# --------------------------------------------------------------------------
# Low-level drawing helpers
# --------------------------------------------------------------------------
def _font():
    return ImageFont.load_default()


def _ellipse(d, cx, cy, rx, ry, fill, outline=None, width=0):
    d.ellipse([cx - rx, cy - ry, cx + rx, cy + ry], fill=fill,
              outline=outline, width=width)


def render_figure(color, ink, *, cx=48, cy=58, bob=0, tilt=0.0,
                  eye="open", right_arm=None):
    """Draw the round stick figure onto a transparent RGBA layer.

    ``bob`` shifts the whole body vertically (breathing / typing jitter),
    ``tilt`` rotates it about its centre (head-sway), ``eye`` selects the
    eye style, and ``right_arm`` (degrees above horizontal, +up) raises the
    waving arm. Returns the RGBA layer to be composited onto the background.
    """
    layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)

    cyb = cy + bob
    bw, bh = 22, 26
    # body
    _ellipse(d, cx, cyb, bw, bh, fill=color, outline=ink, width=2)
    # head
    hr = 14
    hy = cyb - bh - 2
    _ellipse(d, cx, hy, hr, hr, fill=color, outline=ink, width=2)
    # eyes
    if eye == "closed":
        d.line([cx - 7, hy - 1, cx - 2, hy - 1], fill=ink, width=2)
        d.line([cx + 2, hy - 1, cx + 7, hy - 1], fill=ink, width=2)
    else:
        d.ellipse([cx - 8, hy - 4, cx - 4, hy], fill=ink)
        d.ellipse([cx + 4, hy - 4, cx + 8, hy], fill=ink)
    # arms
    ay = cyb - 2
    d.line([cx - bw, ay, cx - bw - 9, ay + 11], fill=color, width=4)
    if right_arm is None:
        d.line([cx + bw, ay, cx + bw + 9, ay + 11], fill=color, width=4)
    else:
        a = math.radians(right_arm)
        ex = cx + bw + 12 * math.cos(a)
        ey = ay - 12 * math.sin(a)
        d.line([cx + bw, ay, ex, ey], fill=color, width=4)
        d.ellipse([ex - 3, ey - 3, ex + 3, ey + 3], fill=color)

    if tilt != 0.0:
        layer = layer.rotate(tilt, resample=Image.BICUBIC,
                              center=(cx, cyb), expand=False)
    return layer


def _star(d, x, y, r, color):
    d.polygon([(x, y - r), (x + r, y), (x, y + r), (x - r, y)], fill=color)


def _draw_confetti(d, i, n, color):
    rnd = random.Random(1000 + i)
    palette = [(255, 215, 0), (233, 30, 99), (76, 175, 80),
               (33, 150, 243), (255, 255, 255)]
    for _ in range(14):
        x = rnd.randint(6, 90)
        y0 = rnd.randint(6, 96)
        y = (y0 - i * 6) % 100          # particles drift upward each frame
        c = rnd.choice(palette)
        _star(d, x, y, rnd.randint(2, 4), c)


def _draw_heart(d, t, color):
    y = 70 - int(t * 56)                # rises from the body toward the top
    x = 48 + int(8 * math.sin(t * 6))   # gentle sway
    d.ellipse([x - 6, y - 6, x, y], fill=color)
    d.ellipse([x, y - 6, x + 6, y], fill=color)
    d.polygon([(x - 6, y), (x + 6, y), (x, y + 7)], fill=color)


def _draw_accessory(d, motion, i, n, color, spec):
    if motion == "sleep":
        d.text((72, 16), "Z", font=_font(), fill=(200, 200, 220))
        d.text((82, 8), "z", font=_font(), fill=(160, 160, 190))
    elif motion == "typewriter":
        if spec.get("cursor"):
            d.rectangle([42, 84, 54, 89], fill=(225, 225, 225))
        d.rectangle([34, 90, 62, 95], outline=(180, 180, 180), width=1)
    elif motion == "wave":
        if spec.get("halo"):
            d.ellipse([30, 8, 66, 40], outline=(255, 240, 120), width=2)
    elif motion == "tilt":
        if spec.get("mark"):
            d.text((70, 18), "?", font=_font(), fill=(230, 230, 250))
    elif motion == "confetti":
        _draw_confetti(d, i, n, color)
    elif motion == "heart":
        # lighter heart so it pops off the red body
        _draw_heart(d, spec.get("heart", 0.0), (255, 205, 210))


def _draw_label(d, abbr):
    # small drop-shadowed abbreviation in the top-left for easy acceptance
    d.text((3, 2), abbr, font=_font(), fill=(0, 0, 0))
    d.text((2, 1), abbr, font=_font(), fill=(255, 255, 255))


def _motion_spec(motion, i, n, variant=0):
    """Map (motion, frame index) -> figure + accessory params."""
    t = i / max(1, n)
    if motion == "sleep":
        return dict(bob=0, tilt=0.0, eye="closed", right_arm=None)
    if motion == "breathe":
        # each idle variant breathes on a different phase so the home-screen
        # rotation shows visibly distinct clips (and never collapses to 1
        # frame during GIF optimization)
        b = round(2 * math.sin(2 * math.pi * t + variant * math.pi / 2.0))
        return dict(bob=b, tilt=0.0, eye="open", right_arm=None)
    if motion == "typewriter":
        b = round(1.5 * math.sin(2 * math.pi * t * 2))
        return dict(bob=b, tilt=0.0, eye="open", right_arm=None,
                    cursor=(i % 2 == 0))
    if motion == "wave":
        ang = 55 + 22 * math.sin(2 * math.pi * t)
        return dict(bob=0, tilt=0.0, eye="open", right_arm=ang,
                    halo=(i % 2 == 0))
    if motion == "tilt":
        tilt = 14 * math.sin(2 * math.pi * t)
        return dict(bob=0, tilt=tilt, eye="open", right_arm=None, mark=True)
    if motion == "confetti":
        return dict(bob=0, tilt=0.0, eye="open", right_arm=None, confetti=i)
    if motion == "heart":
        return dict(bob=0, tilt=0.0, eye="open", right_arm=None, heart=t)
    return dict(bob=0, tilt=0.0, eye="open", right_arm=None)


# --------------------------------------------------------------------------
# Public API
# --------------------------------------------------------------------------
def build_state(state, *, frames=None, color=None, motion=None, bg=DEFAULT_BG,
                variant=0):
    """Return ``(frames, durations)`` for one state.

    This is the parameterized entry point: pass a state name, frame count,
    accent color and motion recipe (the "每帧绘制回调配置"). ``variant``
    distinguishes idle clips so the home screen can rotate through several.
    """
    if state not in STATE_META:
        raise ValueError(f"unknown state: {state!r} "
                         f"(expected one of {sorted(STATE_META)})")
    abbr, default_color = STATE_META[state]
    recipe = PLACEHOLDER_RECIPE[state]
    n = int(frames if frames is not None else recipe["frames"])
    dur = recipe["duration"]
    motion = motion or recipe["motion"]
    color = tuple(color) if color is not None else default_color
    ink = (10, 10, 14)

    fig_keys = {"bob", "tilt", "eye", "right_arm"}
    out, durations = [], []
    for i in range(n):
        canvas = Image.new("RGB", (W, H), bg)
        spec = _motion_spec(motion, i, n, variant)
        fig = render_figure(color, ink, **{k: spec[k] for k in fig_keys})
        canvas.paste(fig, mask=fig.split()[3])
        d = ImageDraw.Draw(canvas)
        _draw_accessory(d, motion, i, n, color, spec)
        _draw_label(d, abbr)
        out.append(canvas)
        durations.append(dur if dur else 100)
    return out, durations


def save_gif(frames, durations, path, *, colors=64, dither=True,
             max_bytes=None):
    """Quantize to a shared adaptive palette (+ optional Floyd–Steinberg
    dithering) and write a looping GIF. Retries with fewer colors if the
    result exceeds ``max_bytes`` so the character pack stays within budget.
    Returns the final byte size.
    """
    method = Image.FLOYDSTEINBERG if dither else Image.NONE
    rgb = [f.convert("RGB") for f in frames]
    path = Path(path)
    palette_sizes = [colors] + [c for c in (32, 16, 8) if c < colors]

    size = 0
    for c in palette_sizes:
        base = rgb[0].quantize(colors=c, method=Image.MEDIANCUT, dither=method)
        pimg = Image.new("P", (1, 1))
        pimg.putpalette(base.getpalette())
        out = [f.quantize(palette=pimg, dither=method) for f in rgb]
        out[0].save(path, save_all=True, append_images=out[1:],
                    duration=durations, loop=0, optimize=True, disposal=2)
        size = path.stat().st_size
        if max_bytes is None or size <= max_bytes:
            break
    return size


# --------------------------------------------------------------------------
# Placeholder pack assembly
# --------------------------------------------------------------------------
def build_placeholder_pack(out_dir, *, colors=64, dither=True,
                           max_bytes_per_file=None, total_budget=None):
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    states_map = {}
    # idle: several breathing variants (rotated on the home screen)
    idle_files = []
    for k in range(IDLE_VARIANTS):
        fr, du = build_state("idle", variant=k)
        save_gif(fr, du, out_dir / f"idle_{k}.gif", colors=colors,
                 dither=dither, max_bytes=max_bytes_per_file)
        idle_files.append(f"idle_{k}.gif")
    states_map["idle"] = idle_files

    for s in ("sleep", "busy", "attention", "dizzy", "celebrate", "heart"):
        fr, du = build_state(s)
        save_gif(fr, du, out_dir / f"{s}.gif", colors=colors,
                 dither=dither, max_bytes=max_bytes_per_file)
        states_map[s] = f"{s}.gif"

    manifest = {
        "name": "encourager",
        "colors": {
            "body": "#4CAF50",
            "bg": "#0E0E12",
            "text": "#FFFFFF",
            "textDim": "#9AA0A6",
            "ink": "#0E0E12",
        },
        "states": states_map,
    }
    (out_dir / "manifest.json").write_text(json.dumps(manifest, indent=2))

    if total_budget is not None:
        used = sum(p.stat().st_size for p in out_dir.glob("*.gif"))
        if used > total_budget:
            print(f"warning: placeholder pack is {used:,}B "
                  f"(budget {total_budget:,}B)")
    return out_dir


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------
def _hex_to_rgb(h):
    h = h.lstrip("#")
    if len(h) != 6:
        raise ValueError(f"bad hex color: {h!r}")
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--placeholder", action="store_true",
                    help="generate the full placeholder 'encourager' pack")
    ap.add_argument("--out", required=True,
                    help="output dir (--placeholder) or .gif file (single)")
    ap.add_argument("--state", help="state name for single-mode generation")
    ap.add_argument("--frames", type=int, help="frame count (single mode)")
    ap.add_argument("--color", help="accent color hex, e.g. #FF9800")
    ap.add_argument("--motion", help="motion recipe (single mode)")
    ap.add_argument("--bg", default=None, help="background hex (single mode)")
    ap.add_argument("--colors", type=int, default=64,
                    help="palette size for quantization")
    ap.add_argument("--no-dither", action="store_true",
                    help="disable Floyd–Steinberg dithering")
    args = ap.parse_args(argv)

    if args.placeholder:
        build_placeholder_pack(
            args.out, colors=args.colors, dither=not args.no_dither,
            max_bytes_per_file=120 * 1024, total_budget=600 * 1024)
        print(f"wrote placeholder pack -> {args.out}")
        return 0

    if not args.state:
        ap.error("--state is required in single mode (or use --placeholder)")
    color = _hex_to_rgb(args.color) if args.color else None
    bg = _hex_to_rgb(args.bg) if args.bg else DEFAULT_BG
    fr, du = build_state(args.state, frames=args.frames, color=color,
                         motion=args.motion, bg=bg)
    size = save_gif(fr, du, args.out, colors=args.colors,
                    dither=not args.no_dither)
    print(f"wrote {args.out} ({len(fr)} frames, {size:,}B)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
