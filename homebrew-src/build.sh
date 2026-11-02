#!/bin/bash
# Builds the original Kaiser demo ROMs (WSL/Linux). Needs: bash homebrew-src/setup-blocksds.sh
set -e
export PATH=/opt/wonderful/bin:$PATH BLOCKSDS=/opt/wonderful/thirdparty/blocksds/core BLOCKSDSEXT=/opt/wonderful/thirdparty/blocksds/external
HERE="$(cd "$(dirname "$0")" && pwd)"
for d in "$@"; do (cd "$HERE/$d" && make -s 2>&1 | grep -v "GNU-stack" ); done
