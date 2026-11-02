#!/bin/bash
# DS core sources (run inside WSL/Linux)
set -e
cd ~/ngemu/src
for r in melonDS desmume2015; do [ -d "$r" ] || git clone -q --depth 1 "https://github.com/libretro/$r.git"; done
cd melonDS && git log -1 --format='%ci %s' && ls && grep -n "emscripten" Makefile* | head -5
grep -rn "bios7.bin\|FreeBIOS\|freebios\|bios_arm7\|ARM7BIOS" src/libretro/*.c* 2>/dev/null | head -10
