#!/usr/bin/env python3
"""
Turn a screen capture into a Chrome Web Store screenshot.

    python3 cws/fit-screenshot.py ~/Desktop/shot.png cws/screenshot-1.png

The store wants EXACTLY 1280x800 (or 640x400), JPEG or 24-bit PNG with NO ALPHA.
A macOS window capture is none of those: it is whatever size the window was, it
is 32-bit, and `Cmd+Shift+4` adds a transparent drop shadow around the window —
which is alpha, so the upload is rejected with a message that does not mention
shadows.

This scales the capture to fit, centres it on the panel's own background colour
so the letterboxing looks deliberate rather than like a mistake, and flattens
the result. Nothing is cropped: a screenshot with the point cut off is worse
than one with a margin.
"""

import sys
from PIL import Image

TARGET = (1280, 800)
BG = (15, 15, 15)  # --bg from sidepanel.css, so the padding reads as chrome


def fit(src_path: str, out_path: str) -> None:
    im = Image.open(src_path).convert("RGBA")

    # Trim the transparent shadow a window capture carries, or the artwork ends
    # up scaled to fit a border of nothing.
    bbox = im.getbbox()
    if bbox:
        im = im.crop(bbox)

    scale = min(TARGET[0] / im.width, TARGET[1] / im.height)
    # Never upscale past 1:1 — enlarging a 700px panel to 1280 makes the text
    # soft, and soft text in the first screenshot is what the listing is judged
    # on.
    scale = min(scale, 1.0)
    size = (max(1, round(im.width * scale)), max(1, round(im.height * scale)))
    im = im.resize(size, Image.LANCZOS)

    canvas = Image.new("RGB", TARGET, BG)
    canvas.paste(im, ((TARGET[0] - size[0]) // 2, (TARGET[1] - size[1]) // 2), im)
    canvas.save(out_path, "PNG")

    print(f"{out_path}  {TARGET[0]}x{TARGET[1]}  24-bit RGB, no alpha")
    if size != TARGET:
        pad = (TARGET[0] - size[0], TARGET[1] - size[1])
        print(f"  (capture placed at {size[0]}x{size[1]}, padded {pad[0]}x{pad[1]})")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print(__doc__)
        sys.exit(2)
    fit(sys.argv[1], sys.argv[2])
