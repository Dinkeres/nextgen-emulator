# Kaiser signaling server

A tiny WebSocket server (≈80 lines, `ws` only) that lets players find each other. It only:

- creates rooms and hands out room codes,
- relays WebRTC offers/answers/ICE candidates between peers,
- relays small lobby messages (names, ready state, chat).

Game inputs travel **peer-to-peer** over WebRTC data channels; ROMs are never sent anywhere.

## Run locally

```bash
npm install
npm run signal            # ws://localhost:8787
PORT=9000 npm run signal  # custom port
```

In Kaiser: **Settings → Multiplayer → Signaling server**, set `ws://localhost:8787`.
Two browser tabs (or two devices on your LAN using `ws://<your-lan-ip>:8787`) can then play.

## Deploying it yourself

Any Node 18+ host works (a small VPS, Fly.io, Render, Railway…). Put it behind TLS so browsers
on `https://` pages can connect with `wss://`, e.g. with Caddy:

```
signal.example.com {
  reverse_proxy localhost:8787
}
```

## Connectivity (STUN/TURN)

Kaiser uses a public STUN server by default, which works for most home networks. Players behind
strict/symmetric NATs (some mobile carriers, corporate networks) need a TURN relay, e.g.
[coturn](https://github.com/coturn/coturn). TURN servers can be configured in `src/net/session.ts`
(`ICE_SERVERS`).
