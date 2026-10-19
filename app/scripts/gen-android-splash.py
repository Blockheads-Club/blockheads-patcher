#!/usr/bin/env python3
"""Generates the Android splash drawables from our own art (the adaptive icon layers in src-tauri/icons and the wordmark font).

  python3 -m venv /tmp/v && /tmp/v/bin/pip install fonttools brotli
  /tmp/v/bin/python app/scripts/gen-android-splash.py

Needs rsvg-convert and ImageMagick. Writes into src-tauri/gen/android/app/src/main/res:
  drawable-*/splash_icon.png         windowSplashScreenAnimatedIcon: the adaptive icon (background + foreground) on
                                     the 240 dp canvas, which Android 12+ masks to its 160 dp circle (design: the
                                     adaptive icon in a circle)
  drawable-*/splash_legacy_icon.png  the same circle, for drawable/splash_legacy.xml (pre-12 window background)
  splash_branding.xml  "Blockheads [Patcher]" wordmark for windowSplashScreenBrandingImage
The output is committed; rerun only when the logo or the wordmark changes.
"""
import io
import subprocess
import tempfile
import re
import sys
from pathlib import Path

from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont

APP = Path(__file__).resolve().parent.parent
RES = APP / "src-tauri/gen/android/app/src/main/res/drawable"
RES_ROOT = RES.parent
LAYERS = [APP / "src-tauri/icons/adaptive-background.svg", APP / "src-tauri/icons/adaptive-foreground.svg"]
DENSITIES = {"mdpi": 1, "hdpi": 1.5, "xhdpi": 2, "xxhdpi": 3, "xxxhdpi": 4}
FONT = APP / "node_modules/@fontsource-variable/bricolage-grotesque/files/bricolage-grotesque-latin-opsz-normal.woff2"
HEAD = '<?xml version="1.0" encoding="utf-8"?>\n'
NS = 'xmlns:android="http://schemas.android.com/apk/res/android" xmlns:aapt="http://schemas.android.com/aapt"'


def n(v):
    return f"{v:.2f}".rstrip("0").rstrip(".")


def rrect(x, y, w, h, r):
    return (f"M{n(x + r)},{n(y)}H{n(x + w - r)}Q{n(x + w)},{n(y)} {n(x + w)},{n(y + r)}V{n(y + h - r)}"
            f"Q{n(x + w)},{n(y + h)} {n(x + w - r)},{n(y + h)}H{n(x + r)}Q{n(x)},{n(y + h)} {n(x)},{n(y + h - r)}"
            f"V{n(y + r)}Q{n(x)},{n(y)} {n(x + r)},{n(y)}Z")


def fill(path, color, alpha=None, extra=""):
    a = f' android:fillAlpha="{alpha}"' if alpha is not None else ""
    return f'<path android:fillColor="{color}"{a} android:pathData="{path}"{extra}/>'


def vector(w, h, vw, vh, body):
    return HEAD + (f'<vector {NS} android:width="{w}dp" android:height="{h}dp" '
                   f'android:viewportWidth="{vw}" android:viewportHeight="{vh}">\n  ' + "\n  ".join(body) + "\n</vector>\n")


def glyph_run(font, text, size, x, baseline):
    gs, cmap, upm = font.getGlyphSet(), font.getBestCmap(), font["head"].unitsPerEm
    k = size / upm
    parts, pen_x = [], x
    for ch in text:
        name = cmap[ord(ch)]
        pen = SVGPathPen(gs, ntos=n)
        gs[name].draw(TransformPen(pen, (k, 0, 0, -k, pen_x, baseline)))
        if pen.getCommands():
            parts.append(pen.getCommands())
        pen_x += gs[name].width * k
    return "".join(parts), pen_x - x


def branding():
    raw = TTFont(io.BytesIO(FONT.read_bytes()))
    big = instantiateVariableFont(TTFont(io.BytesIO(FONT.read_bytes())), {"wght": 800, "opsz": 20})
    small = instantiateVariableFont(raw, {"wght": 800, "opsz": 16})
    pad = 4
    height, base = 40, 25
    word, ww = glyph_run(big, "Blockheads", 20, pad, base)
    # tag text 16px with padding 3px 8px 4px, gap 8, drawn on a baseline that centres the caps with the word
    _, tw = glyph_run(small, "Patcher", 16, 0, 0)
    bw, bh = tw + 16, 16 * 1.0 + 7
    tx = pad + ww + 8
    ty = base - 16 * 0.78 - 3
    parts = [fill(word, "#FFFFFFFF")]
    cx, cy = tx + bw / 2, ty + bh / 2
    parts.append(f'<group android:rotation="-6" android:pivotX="{n(cx)}" android:pivotY="{n(cy)}">')
    parts.append(fill(rrect(tx, ty + 3, bw, bh, 7), "#FF7A2A08"))
    parts.append(fill(rrect(tx, ty, bw, bh, 7), "#FFFFD27A"))
    # re-run the glyphs at the tag's text origin
    tag_txt, _ = glyph_run(small, "Patcher", 16, tx + 8, ty + 3 + 16 * 0.78 + 0.5)
    parts.append(fill(tag_txt, "#FF1F1A17"))
    parts.append("</group>")
    width = round(tx + bw + pad + 4)
    return vector(width, height, width, height, parts)


def run(*cmd, data=None):
    return subprocess.run(cmd, input=data, check=True, capture_output=True).stdout


def adaptive(px):
    """Background and foreground layers composited at px x px (the full 108 dp adaptive canvas)."""
    bg, fg = (run("rsvg-convert", "-w", str(px), "-h", str(px), str(layer)) for layer in LAYERS)
    with tempfile.TemporaryDirectory() as d:
        Path(d, "fg.png").write_bytes(fg)
        return run("magick", "png:-", str(Path(d, "fg.png")), "-composite", "png:-", data=bg)


def icon_pngs():
    for d, f in DENSITIES.items():
        out = RES_ROOT / f"drawable-{d}"
        out.mkdir(exist_ok=True)
        # Android 12+ shows the central 2/3 of the 240 dp icon as a circle: the adaptive icon's visible part.
        art = adaptive(round(240 * f))
        (out / "splash_icon.png").write_bytes(art)
        c = round(160 * f)
        run("magick", "png:-", "-alpha", "set", "-gravity", "center", "-crop", f"{c}x{c}+0+0", "+repage",
            "(", "-size", f"{c}x{c}", "xc:none", "-fill", "white", "-draw", f"circle {c // 2},{c // 2} {c // 2},0", ")",
            "-compose", "DstIn", "-composite", str(out / "splash_legacy_icon.png"), data=art)


def main():
    RES.mkdir(parents=True, exist_ok=True)
    # Android 12 masks the animated icon to a circle of 2/3 of its canvas: the icon (a rounded square) fits inside.
    icon_pngs()
    (RES / "splash_branding.xml").write_text(branding())
    print("wrote splash_icon, splash_legacy_icon, splash_branding")


if __name__ == "__main__":
    sys.exit(main())
