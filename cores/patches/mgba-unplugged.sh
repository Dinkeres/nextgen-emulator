#!/bin/bash
# mGBA 0.11-dev completes multiplayer-mode link transfers even with no cable (reading 0 from every
# port). 0.10 left them pending, like an unplugged cable. Games' link code (and Pokémon Quetzal's
# Mplayer bridge in src/net/quetzal.ts) expect the 0.10 behaviour, so only start a transfer when a
# link driver is attached. Idempotent.
f="$1/src/gba/sio.c"
grep -q 'IsBusy(sio->siocnt) && sio->driver' "$f" || \
  sed -i 's/if (GBASIOMultiplayerIsBusy(value) \&\& !GBASIOMultiplayerIsBusy(sio->siocnt)) {/if (GBASIOMultiplayerIsBusy(value) \&\& !GBASIOMultiplayerIsBusy(sio->siocnt) \&\& sio->driver) {/' "$f"
grep -q 'IsBusy(sio->siocnt) && sio->driver' "$f"
