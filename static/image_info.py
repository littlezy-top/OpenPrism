#!/usr/bin/env python
"""Report image/gif file sizes and dimensions in the static directory."""

import os
import sys
from PIL import Image

STATIC_DIR = os.path.dirname(os.path.abspath(__file__))


def human_size(size_bytes):
    for unit in ["B", "KB", "MB", "GB"]:
        if size_bytes < 1024:
            return f"{size_bytes:.1f} {unit}"
        size_bytes /= 1024
    return f"{size_bytes:.1f} TB"


def get_gif_info(filepath):
    """Get GIF frame count and duration."""
    img = Image.open(filepath)
    frames = 0
    try:
        while True:
            frames += 1
            img.seek(img.tell() + 1)
    except EOFError:
        pass
    duration = img.info.get("duration", 0)
    return frames, duration


def main():
    exts = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp"}
    files = sorted(
        f for f in os.listdir(STATIC_DIR)
        if os.path.splitext(f)[1].lower() in exts
    )

    if not files:
        print("No image files found.")
        return

    print(f"{'File':<45} {'Size':>10} {'Dimensions':>14} {'Extra'}")
    print("-" * 90)

    total_size = 0
    for f in files:
        path = os.path.join(STATIC_DIR, f)
        size = os.path.getsize(path)
        total_size += size

        try:
            img = Image.open(path)
            dims = f"{img.width}x{img.height}"
        except Exception:
            dims = "N/A"

        extra = ""
        if f.lower().endswith(".gif"):
            frames, duration = get_gif_info(path)
            extra = f"frames={frames}, duration={duration}ms/frame"

        print(f"{f:<45} {human_size(size):>10} {dims:>14} {extra}")

    print("-" * 90)
    print(f"{'Total':<45} {human_size(total_size):>10}")
    print(f"\nGitHub recommended: single file < 25MB, repo < 1GB")


if __name__ == "__main__":
    main()
