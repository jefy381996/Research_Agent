#!/usr/bin/env python3
"""Pack the library into the file that ships.

A git host refuses a file over a hundred megabytes. The library was being cut
down to fit - make_shippable dropped the least-cited abstracts, thousands of
them, purely to get under the line. A SQLite database of text compresses about
five times over, so packing it is worth more than five times as much data as
pruning it saves.

What ships is this archive. What runs is unpacked from it on first use, by
db.ensure_database, which every entry point already calls through connect().
Nothing else in the project has to know.

The archive is verified before it replaces the old one: it is unpacked again
and checked byte for byte against the database it came from. An archive that
does not round-trip is worse than no archive at all, because it is the only
copy that ships.
"""

import argparse
import hashlib
import os
import shutil
import sys
import time

import db

LEVELS = {"zst": 19, "xz": 6}


def digest(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for block in iter(lambda: fh.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def pack(src: str, fmt: str, level: int) -> str:
    out = f"{src}.{fmt}"
    tmp = out + ".packing"
    if fmt == "zst":
        import zstandard
        packer = zstandard.ZstdCompressor(level=level, threads=-1)
        with open(src, "rb") as fh, open(tmp, "wb") as dst:
            packer.copy_stream(fh, dst)
    else:
        import lzma
        with open(src, "rb") as fh, lzma.open(tmp, "wb", preset=level) as dst:
            shutil.copyfileobj(fh, dst, 1 << 20)
    os.replace(tmp, out)
    return out


def main():
    p = argparse.ArgumentParser(description="Pack the library for shipping.")
    p.add_argument("--path", action="append", default=None,
                   help="repeatable; defaults to the library and the raw "
                        "collection file, both of which outgrew the limit")
    p.add_argument("--format", default="zst", choices=["zst", "xz"],
                   help="zst unpacks in a tenth of a second; xz needs nothing "
                        "installed")
    p.add_argument("--level", type=int, default=None)
    p.add_argument("--limit-mb", type=float, default=100.0,
                   help="what the git host refuses above")
    args = p.parse_args()

    paths = args.path or [db.DB_PATH, "data/papers.csv"]
    level = args.level if args.level is not None else LEVELS[args.format]
    worst = 0
    for src in paths:
        if not os.path.exists(src):
            print(f"{src} is not here; skipping.")
            continue
        worst = max(worst, pack_one(src, args, level))
    return worst


def pack_one(src, args, level):

    before = os.path.getsize(src)
    want = digest(src)
    started = time.time()
    out = pack(src, args.format, level)
    after = os.path.getsize(out)

    # Verify by unpacking it again. This is the only copy that ships.
    check = src + ".verify"
    db._unpack(out, check)
    got = digest(check)
    os.remove(check)
    if got != want:
        os.remove(out)
        sys.exit("the archive did not unpack to the database it came from; "
                 "nothing was written")

    print(f"packed {before/1e6:,.0f} MB -> {after/1e6:,.0f} MB"
          f"  ({before/after:.1f}x, {time.time()-started:.0f}s, verified)")
    room = args.limit_mb * (before / after)
    print(f"the git host accepts {args.limit_mb:,.0f} MB, so at this ratio"
          f" the repository can carry about {room:,.0f} MB of library")
    if after > args.limit_mb * 1e6:
        print(f"\nTHIS ARCHIVE IS STILL TOO BIG by"
              f" {(after - args.limit_mb*1e6)/1e6:,.0f} MB.")
        print("Publish it as a release asset instead and set DB_URL to its"
              " address; a release asset has no size limit.")
        return 1
    print(f"{out} is ready to commit; {src} itself is not.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
