#!/usr/bin/env python3
"""Generates the Android splash drawables from our own art (src/lib/assets/logo.svg and the wordmark font).

  python3 -m venv /tmp/v && /tmp/v/bin/pip install fonttools brotli
  /tmp/v/bin/python app/scripts/gen-android-splash.py

Writes into src-tauri/gen/android/app/src/main/res/drawable:
  splash_icon.xml      icon art for windowSplashScreenAnimatedIcon (Android 12+ draws the Sun circle behind it)
  splash_legacy.xml    Sun circle + icon, for the pre-12 window background
  splash_branding.xml  "Blockheads [Patcher]" wordmark for windowSplashScreenBrandingImage
The output is committed; rerun only when the logo or the wordmark changes.
"""
import io
import re
import sys
from pathlib import Path

from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont

APP = Path(__file__).resolve().parent.parent
RES = APP / "src-tauri/gen/android/app/src/main/res/drawable"
SVG = (APP / "src/lib/assets/logo.svg").read_text()
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


def icon_art():
    """The 512x512 logo as vector paths (rounded-square clip, Sun gradient, rays, pickaxe, face)."""
    out = [f'<clip-path android:pathData="{rrect(0, 0, 512, 512, 96)}"/>']
    out.append('<path android:pathData="M0,0H512V512H0Z"><aapt:attr name="android:fillColor">'
               '<gradient android:type="radial" android:centerX="256" android:centerY="128" android:gradientRadius="435">'
               '<item android:offset="0" android:color="#FFFFD27A"/><item android:offset="1" android:color="#FFE2553A"/>'
               '</gradient></aapt:attr></path>')
    for pts in re.findall(r'<polygon points="([^"]+)"', SVG):
        xy = [tuple(float(v) for v in p.split(",")) for p in pts.split()]
        out.append(fill("M" + "L".join(f"{n(x)},{n(y)}" for x, y in xy) + "Z", "#FFFFF2C0", 0.15))
    # pickaxe: translate(370,250) rotate(35)
    out.append('<group android:translateX="370" android:translateY="250" android:rotation="35">')
    out.append(fill(rrect(-12, -150, 24, 300, 9), "#FF8B5A2B"))
    out.append(fill("M-135,-114Q0,-186 135,-114L114,-90Q0,-144 -114,-90Z", "#FFC3CCD4"))
    out.append("</group>")
    # head: translate(240,280) rotate(-6)
    out.append('<group android:translateX="240" android:translateY="280" android:rotation="-6">')
    out.append(fill(rrect(-150, -150, 300, 300, 12), "#FFF6C79C"))
    out.append(fill("M129,-150H150V150H129Z", "#FFE3A97A", 0.6))
    out.append(fill("M-150,-150H150V-60Q144,-90 108,-90H-84Q-135,-90 -150,-48Z", "#FF1F1A17"))
    for x in (-103.5, 22.5):
        out.append(fill(rrect(x, -43.5, 75, 51, 21.42), "#FFFFFFFF"))
    for x in (-77.25, 48.75):
        out.append(fill(rrect(x, -40.5, 22.5, 45, 11.25), "#FF111111"))
    out.append(fill(rrect(-30, 9, 60, 27, 13.5), "#FFF0A35C"))
    out.append(fill("M-48,60Q0,114 48,60Z", "#FF8A2D0C"))
    out.append(fill("M-30,61.5H30V73.5H-30Z", "#FFFFFFFF"))
    out.append("</group>")
    return out


def vector(w, h, vw, vh, body):
    return HEAD + (f'<vector {NS} android:width="{w}dp" android:height="{h}dp" '
                   f'android:viewportWidth="{vw}" android:viewportHeight="{vh}">\n  ' + "\n  ".join(body) + "\n</vector>\n")


def icon_group(side, cx, cy):
    s = side / 512
    return [f'<group android:translateX="{n(cx - side / 2)}" android:translateY="{n(cy - side / 2)}" '
            f'android:scaleX="{s:.6f}" android:scaleY="{s:.6f}">'] + icon_art() + ["</group>"]


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


def main():
    RES.mkdir(parents=True, exist_ok=True)
    # Android 12 masks the animated icon to a circle of 2/3 of its canvas: the logo (a rounded square) fits inside.
    (RES / "splash_icon.xml").write_text(vector(240, 240, 240, 240, icon_group(112, 120, 120)))
    disc = '<path android:fillColor="#FFFFD27A" android:pathData="M120,36A84,84 0 1,0 120,204A84,84 0 1,0 120,36Z"/>'
    (RES / "splash_legacy.xml").write_text(vector(240, 240, 240, 240, [disc] + icon_group(118, 120, 120)))
    (RES / "splash_branding.xml").write_text(branding())
    print("wrote", [p.name for p in sorted(RES.glob("splash_*.xml"))])


if __name__ == "__main__":
    sys.exit(main())
