#!/bin/bash
# Installs the Wonderful toolchain + BlocksDS (DS homebrew SDK) into /opt/wonderful (WSL/Linux, x86_64).
set -e
if [ ! -x /opt/wonderful/bin/wf-pacman ]; then
  mkdir -p /opt/wonderful ~/ngemu/wf-dl
  curl -sL -o ~/ngemu/wf-dl/bootstrap.tar.gz https://wonderful.asie.pl/bootstrap/wf-bootstrap-x86_64.tar.gz
  tar -xzf ~/ngemu/wf-dl/bootstrap.tar.gz -C /opt/wonderful/
fi
export PATH=/opt/wonderful/bin:$PATH
wf-pacman -Syu --noconfirm wf-tools
wf-config repo enable blocksds
wf-pacman -Syu --noconfirm
wf-pacman -S --noconfirm blocksds-toolchain
ls /opt/wonderful/thirdparty/blocksds/core | head
