#!/bin/bash
# Build libretro cores to WebAssembly with our thin frontend (cores/glue/frontend.c).
# Usage (Linux/WSL with emsdk at ~/ngemu/emsdk):  bash cores/build.sh [core ...]
# Variant: FLAVOR=baseline uses plain -O2 (no LTO/SIMD) for benchmark comparison.
set -eo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SRC=~/ngemu/src
OUT="${OUT:-$HERE/../public/cores}"
source ~/ngemu/emsdk/emsdk_env.sh >/dev/null 2>&1
mkdir -p "$OUT"

FLAVOR="${FLAVOR:-fast}"
if [ "$FLAVOR" = fast ]; then OPT="-O3 -flto -msimd128"; SUFFIX=""; else OPT="-O2"; SUFFIX="-baseline"; fi
export EMCC_CFLAGS="$OPT"
J=$(nproc)

build_make() { # dir makefile target_bc extra...
  local dir=$1 mk=$2 bc=$3; shift 3
  (cd "$SRC/$dir" && make -f "$mk" platform=emscripten clean >/dev/null 2>&1 || true
   cd "$SRC/$dir" && emmake make -f "$mk" platform=emscripten -j$J "$@" >"$HERE/../.build-$bc.log" 2>&1) \
    || { echo "make failed: $dir (see .build-$bc.log)"; tail -20 "$HERE/../.build-$bc.log"; return 1; }
  echo "$SRC/$dir/$bc"
}

link() { # name archive
  local name=$1 lib=$2
  [ -f "$lib" ] || return 1
  case $lib in *.bc) cp "$lib" "/tmp/$name.a"; lib="/tmp/$name.a";; esac
  # libretro-common pieces RetroArch normally provides in static builds
  local LC="$SRC/libretro-fceumm/src/drivers/libretro/libretro-common" extra=""
  for f in streams/file_stream.c streams/file_stream_transforms.c vfs/vfs_implementation.c \
           file/file_path.c file/file_path_io.c string/stdstring.c compat/compat_strl.c \
           compat/compat_strcasestr.c compat/fopen_utf8.c encodings/encoding_utf.c time/rtime.c \
           compat/compat_posix_string.c encodings/encoding_deflate.c; do
    if [ -f "$LC/$f" ]; then extra="$extra $LC/$f"
    else alt=$(find "$SRC" -path "*libretro-common/$f" | head -1); [ -n "$alt" ] && extra="$extra $alt"; fi
  done
  local objs="" o; rm -rf /tmp/ngobj-$name; mkdir -p /tmp/ngobj-$name
  for f in "$HERE/glue/frontend.c" $extra; do
    o=/tmp/ngobj-$name/$(basename "$f" .c).o; emcc $OPT -c "$f" -I"$HERE/glue" -I"$LC/include" -o "$o" -w; objs="$objs $o"
  done
  em++ $OPT $objs "$lib" -Wl,--allow-multiple-definition -o "$OUT/$name$SUFFIX.mjs" \
    -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createCore \
    -sENVIRONMENT=web,worker,node -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=64MB -sSTACK_SIZE=4MB \
    -sEXPORTED_FUNCTIONS=_malloc,_free -sFORCE_FILESYSTEM=1 -sINVOKE_RUN=0 -sEXIT_RUNTIME=0 \
    -sEXPORTED_RUNTIME_METHODS=FS,HEAPU8,HEAP16,HEAPU16,HEAPU32,HEAPF64,UTF8ToString,stringToNewUTF8 \
    -sUSE_ZLIB=1 2>&1 | grep -v "warning:" || true
  ls -la "$OUT/$name$SUFFIX.wasm"
}

core() {
  case $1 in
    fceumm)   link fceumm "$(build_make libretro-fceumm Makefile.libretro fceumm_libretro_emscripten.bc)";;
    snes9x2010) link snes9x2010 "$(build_make snes9x2010 Makefile.libretro snes9x2010_libretro_emscripten.bc)";;
    snes9x)   link snes9x "$(build_make snes9x/libretro Makefile snes9x_libretro_emscripten.bc)";;
    genesis)  link genesis_plus_gx "$(build_make Genesis-Plus-GX Makefile.libretro genesis_plus_gx_libretro_emscripten.bc)";;
    # gambatte miscompiles (wasm 'unreachable' at load) under -O3 -flto; -O2 without LTO is correct
    gambatte) local keep="$OPT"; [ "$FLAVOR" = fast ] && { OPT="-O2 -msimd128"; export EMCC_CFLAGS="$OPT"; }
              link gambatte "$(build_make gambatte-libretro Makefile.libretro gambatte_libretro_emscripten.bc)"
              OPT="$keep"; export EMCC_CFLAGS="$OPT";;
    mgba)
      mkdir -p "$SRC/mgba/build-em$SUFFIX" && cd "$SRC/mgba/build-em$SUFFIX"
      emcmake cmake .. -DCMAKE_BUILD_TYPE=Release -DBUILD_LIBRETRO=ON -DBUILD_QT=OFF -DBUILD_SDL=OFF \
        -DBUILD_SHARED=OFF -DBUILD_STATIC=OFF -DLIBRETRO_STATIC=ON -DUSE_DEBUGGERS=OFF -DUSE_GDB_STUB=OFF \
        -DUSE_FFMPEG=OFF -DUSE_ZLIB=OFF -DUSE_PNG=OFF -DUSE_LIBZIP=OFF -DUSE_SQLITE3=OFF -DUSE_ELF=OFF \
        -DUSE_LUA=OFF -DUSE_EDITLINE=OFF -DUSE_EPOXY=OFF -DUSE_DISCORD_RPC=OFF -DENABLE_SCRIPTING=OFF \
        -DM_CORE_GB=ON -DM_CORE_GBA=ON -DUSE_LZMA=OFF -DUSE_MINIZIP=OFF -DUSE_JSON_C=OFF -DBUILD_GL=OFF \
        -DBUILD_GLES2=OFF -DBUILD_GLES3=OFF -DUSE_PTHREADS=OFF -DDISABLE_THREADING=ON >"$HERE/../.build-mgba.log" 2>&1
      emmake make -j$J mgba_libretro >>"$HERE/../.build-mgba.log" 2>&1 || { tail -30 "$HERE/../.build-mgba.log"; return 1; }
      link mgba "$PWD/mgba_libretro.bc";;
    *) echo "unknown core $1"; return 1;;
  esac
}

for c in "${@:-fceumm snes9x genesis gambatte mgba}"; do for x in $c; do echo "### $x ($FLAVOR)"; core $x || echo "!!! $x failed"; done; done
