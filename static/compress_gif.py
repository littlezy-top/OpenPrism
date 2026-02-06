#!/usr/bin/env python
"""Compress GIF files using gifsicle and optional resizing via Pillow.

Usage:
    python compress_gif.py [--max-width 800] [--lossy 80] [--colors 128]
"""

import os
import sys
import argparse
import subprocess
import shutil
from PIL import Image

STATIC_DIR = os.path.dirname(os.path.abspath(__file__))


def human_size(size_bytes):
    for unit in ["B", "KB", "MB"]:
        if size_bytes < 1024:
            return f"{size_bytes:.1f} {unit}"
        size_bytes /= 1024
    return f"{size_bytes:.1f} GB"


def get_gif_dims(filepath):
    img = Image.open(filepath)
    return img.width, img.height


def compress_gif(filepath, max_width=800, lossy=80, colors=128):
    """Compress a GIF using gifsicle. Returns (old_size, new_size)."""
    old_size = os.path.getsize(filepath)
    old_dims = get_gif_dims(filepath)

    cmd = [
        "gifsicle", "--optimize=3",
        f"--lossy={lossy}",
        f"--colors={colors}",
    ]

    # Resize if needed
    if old_dims[0] > max_width:
        ratio = max_width / old_dims[0]
        new_h = int(old_dims[1] * ratio)
        cmd.append(f"--resize={max_width}x{new_h}")

    tmp = filepath + ".tmp"
    cmd += ["-o", tmp, filepath]

    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        if os.path.exists(tmp):
            os.remove(tmp)
        return old_size, old_size, old_dims, old_dims, result.stderr.strip()

    new_size = os.path.getsize(tmp)
    # Only replace if actually smaller
    if new_size < old_size:
        shutil.move(tmp, filepath)
    else:
        os.remove(tmp)
        new_size = old_size

    new_dims = get_gif_dims(filepath)
    return old_size, new_size, old_dims, new_dims, None


def main():
    parser = argparse.ArgumentParser(description="Compress GIF files")
    parser.add_argument("--max-width", type=int, default=800,
                        help="Max width in pixels (default: 800)")
    parser.add_argument("--lossy", type=int, default=80,
                        help="Lossy compression level (default: 80)")
    parser.add_argument("--colors", type=int, default=128,
                        help="Max colors 2-256 (default: 128)")
    args = parser.parse_args()

    files = sorted(
        f for f in os.listdir(STATIC_DIR)
        if f.lower().endswith(".gif")
    )

    if not files:
        print("No GIF files found.")
        return

    print(f"Compressing GIFs: max_width={args.max_width}, "
          f"lossy={args.lossy}, colors={args.colors}")
    print(f"{'File':<45} {'Before':>10} {'After':>10} "
          f"{'Saved':>10} {'Dims'}")
    print("-" * 100)

    total_old, total_new = 0, 0
    for f in files:
        path = os.path.join(STATIC_DIR, f)
        old_sz, new_sz, old_d, new_d, err = compress_gif(
            path, args.max_width, args.lossy, args.colors
        )
        total_old += old_sz
        total_new += new_sz
        saved = old_sz - new_sz
        dims_str = f"{old_d[0]}x{old_d[1]}"
        if old_d != new_d:
            dims_str += f" -> {new_d[0]}x{new_d[1]}"
        status = f" [ERR: {err}]" if err else ""
        print(f"{f:<45} {human_size(old_sz):>10} {human_size(new_sz):>10} "
              f"{human_size(saved):>10} {dims_str}{status}")

    print("-" * 100)
    saved_total = total_old - total_new
    pct = (saved_total / total_old * 100) if total_old else 0
    print(f"{'Total':<45} {human_size(total_old):>10} "
          f"{human_size(total_new):>10} {human_size(saved_total):>10} "
          f"({pct:.1f}% saved)")


if __name__ == "__main__":
    main()
