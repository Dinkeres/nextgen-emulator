#!/bin/bash
# Clone libretro core sources into ~/ngemu/src (run inside WSL/Linux)
set -e
mkdir -p ~/ngemu/src && cd ~/ngemu/src
rm -rf libretro
for r in libretro-fceumm snes9x2010 snes9x mgba Genesis-Plus-GX gambatte-libretro; do
  [ -d "$r" ] || git clone -q --depth 1 "https://github.com/libretro/$r.git" &
done
wait
ls
