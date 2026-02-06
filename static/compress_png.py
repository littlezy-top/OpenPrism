#!/usr/bin/env python
"""Compress PNG/JPG images in the static directory.

Usage:
    python compress_png.py [--max-width 1200] [--quality 85]
"""

import os
import sys
import argparse
from PIL import Image

STATIC_DIR = os.path.dirname(os.path.abspath(__file__))


def human_size(size_bytes):
    for unit in ["B", "KB", "MB"]:
        if size_bytes < 1024:
            return f"{size_bytes:.1f} {unit}"
        size_bytes /= 1024
    return f"{size_bytes:.1f} GB"


def compress_image(filepath, max_width=1200, quality=85):
    """Compress a single image. Returns (old_size, new_size)."""
    old_size = os.path.getsize(filepath)
    img = Image.open(filepath)
    orig_dims = (img.width, img.height)

    # Resize if wider than max_width
    if img.width > max_width:
        ratio = max_width / img.width
        new_h = int(img.height * ratio)
        img = img.resize((max_width, new_h), Image.LANCZOS)

    ext = os.path.splitext(filepath)[1].lower()
    if ext == ".png":
        img.save(filepath, "PNG", optimize=True)
    elif ext in (".jpg", ".jpeg"):
        if img.mode == "RGBA":
            img = img.convert("RGB")
        img.save(filepath, "JPEG", quality=quality, optimize=True)

    new_size = os.path.getsize(filepath)
    new_dims = (img.width, img.height)
    return old_size, new_size, orig_dims, new_dims


def main():
    parser = argparse.ArgumentParser(description="Compress PNG/JPG images")
    parser.add_argument("--max-width", type=int, default=1200,
                        help="Max width in pixels (default: 1200)")
    parser.add_argument("--quality", type=int, default=85,
                        help="JPEG quality 1-100 (default: 85)")
    args = parser.parse_args()

    exts = {".png", ".jpg", ".jpeg"}
    files = sorted(
        f for f in os.listdir(STATIC_DIR)
        if os.path.splitext(f)[1].lower() in exts
    )

    if not files:
        print("No PNG/JPG files found.")
        return

    total_old, total_new = 0, 0
    print(f"Compressing with max_width={args.max_width}, quality={args.quality}")
    print(f"{'File':<35} {'Before':>10} {'After':>10} {'Saved':>10} {'Dims'}")
    print("-" * 90)

    for f in files:
        path = os.path.join(STATIC_DIR, f)
        old_sz, new_sz, old_d, new_d = compress_image(
            path, args.max_width, args.quality
        )
        total_old += old_sz
        total_new += new_sz
        saved = old_sz - new_sz
        dims_str = f"{old_d[0]}x{old_d[1]}"
        if old_d != new_d:
            dims_str += f" -> {new_d[0]}x{new_d[1]}"
        print(f"{f:<35} {human_size(old_sz):>10} {human_size(new_sz):>10} "
              f"{human_size(saved):>10} {dims_str}")

    print("-" * 90)
    saved_total = total_old - total_new
    pct = (saved_total / total_old * 100) if total_old else 0
    print(f"{'Total':<35} {human_size(total_old):>10} {human_size(total_new):>10} "
          f"{human_size(saved_total):>10} ({pct:.1f}% saved)")


if __name__ == "__main__":
    main()
