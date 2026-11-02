// Kaiser signaling on Cloudflare Workers: one Durable Object per room. Same protocol as
// server/signal.mjs (create / join / signal / relay → joined / peer-joined / peer-left / signal / relay).
// Introduces peers for WebRTC and relays small lobby messages; never sees game traffic or ROMs.
const MAX_PEERS = 8;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const code = n => Array.from(crypto.getRandomValues(new Uint8Array(n)), b => CODE_CHARS[b % CODE_CHARS.length]).join('');

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === '/' || url.pathname === '/health') return new Response('Kaiser signaling OK', { headers: { 'content-type': 'text/plain' } });
    const m = url.pathname.match(/^\/room\/([A-Za-z0-9]{1,12})$/);
    if (!m) return new Response('Not found', { status: 404 });
    if (req.headers.get('Upgrade') !== 'websocket') return new Response('Expected a WebSocket', { status: 426 });
    const room = m[1].toLowerCase() === 'new' ? code(6) : m[1].toUpperCase();
    const stub = env.ROOMS.get(env.ROOMS.idFromName(room));
    const fwd = new URL(req.url);
    fwd.searchParams.set('room', room);
    fwd.searchParams.set('create', m[1].toLowerCase() === 'new' ? '1' : '0');
    return stub.fetch(new Request(fwd, req));
  },
};

export class Room {
  constructor(state) { this.state = state; }

  peers() {
    return this.state.getWebSockets().map(ws => ({ ws, a: ws.deserializeAttachment() })).filter(p => p.a?.id);
  }
  send(ws, m) { try { ws.send(JSON.stringify(m)); } catch { /* closed */ } }

  async fetch(req) {
    const url = new URL(req.url);
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.state.acceptWebSocket(server);
    server.serializeAttachment({ room: url.searchParams.get('room'), create: url.searchParams.get('create') === '1' });
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, raw) {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m !== 'object') return;
    const a = ws.deserializeAttachment() ?? {};
    const name = String(m.name ?? 'Player').slice(0, 24);
    const others = this.peers().filter(p => p.ws !== ws);
    if (!a.id && (m.t === 'create' || m.t === 'join')) {
      if (m.t === 'join' && (a.create || !others.length)) return this.send(ws, { t: 'error', code: 'no-room', message: 'That room doesn’t exist (it may have ended).' });
      if (m.t === 'create' && others.length) return this.send(ws, { t: 'error', code: 'taken', message: 'Room code collision, please try again.' });
      if (others.length >= MAX_PEERS) return this.send(ws, { t: 'error', code: 'full', message: 'That room is full.' });
      const id = code(8);
      const host = (await this.state.storage.get('host')) && others.length ? await this.state.storage.get('host') : id;
      if (host === id) await this.state.storage.put('host', id);
      ws.serializeAttachment({ ...a, id, name });
      this.send(ws, { t: 'joined', room: a.room, you: id, host, peers: others.map(p => ({ id: p.a.id, name: p.a.name })) });
      for (const p of others) this.send(p.ws, { t: 'peer-joined', id, name });
      return;
    }
    if (!a.id) return;
    if (m.t === 'signal' && typeof m.to === 'string') {
      const p = others.find(x => x.a.id === m.to);
      if (p) this.send(p.ws, { t: 'signal', from: a.id, data: m.data });
    } else if (m.t === 'relay') {
      for (const p of others) if (!m.to || m.to === p.a.id) this.send(p.ws, { t: 'relay', from: a.id, data: m.data });
    } else if (m.t === 'ping') this.send(ws, { t: 'pong' });
  }

  async webSocketClose(ws) { await this.left(ws); }
  async webSocketError(ws) { await this.left(ws); }
  async left(ws) {
    const a = ws.deserializeAttachment();
    if (!a?.id) return;
    ws.serializeAttachment({ ...a, id: null });
    const rest = this.peers().filter(p => p.ws !== ws);
    for (const p of rest) this.send(p.ws, { t: 'peer-left', id: a.id });
    if (!rest.length) await this.state.storage.deleteAll();
  }
}
