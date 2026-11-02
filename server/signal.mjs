// Kaiser signaling server: introduces peers so they can open WebRTC connections, and relays
// small lobby messages. It never sees game traffic or ROMs. Run: npm run signal  (PORT=8787)
import { WebSocketServer } from 'ws';
import { randomBytes } from 'node:crypto';

const PORT = Number(process.env.PORT ?? 8787);
const MAX_PEERS = 8;
const rooms = new Map(); // roomId -> Map(peerId -> { ws, name })
const wss = new WebSocketServer({ port: PORT, maxPayload: 64 * 1024 });
const id = n => randomBytes(n).toString('base64url').replace(/[-_]/g, '').slice(0, n + 2).toUpperCase();

const send = (ws, m) => { if (ws.readyState === 1) ws.send(JSON.stringify(m)); };

wss.on('connection', ws => {
  let room = null, me = null;
  const alive = setInterval(() => ws.readyState === 1 && ws.ping(), 20000);
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (typeof m !== 'object' || !m) return;
    const name = String(m.name ?? 'Player').slice(0, 24);
    if (m.t === 'create' && !room) {
      room = id(4); me = id(6);
      rooms.set(room, new Map([[me, { ws, name }]]));
      send(ws, { t: 'joined', room, you: me, host: me, peers: [] });
    } else if (m.t === 'join' && !room) {
      const r = rooms.get(String(m.room).toUpperCase());
      if (!r) return send(ws, { t: 'error', code: 'no-room', message: 'That room doesn’t exist (it may have ended).' });
      if (r.size >= MAX_PEERS) return send(ws, { t: 'error', code: 'full', message: 'That room is full.' });
      room = String(m.room).toUpperCase(); me = id(6);
      const host = r.keys().next().value;
      send(ws, { t: 'joined', room, you: me, host, peers: [...r].map(([pid, p]) => ({ id: pid, name: p.name })) });
      for (const p of r.values()) send(p.ws, { t: 'peer-joined', id: me, name });
      r.set(me, { ws, name });
    } else if (room && m.t === 'signal' && typeof m.to === 'string') {
      const p = rooms.get(room)?.get(m.to);
      if (p) send(p.ws, { t: 'signal', from: me, data: m.data });
    } else if (room && m.t === 'relay') {
      for (const [pid, p] of rooms.get(room) ?? []) if (pid !== me && (!m.to || m.to === pid)) send(p.ws, { t: 'relay', from: me, data: m.data });
    }
  });
  ws.on('close', () => {
    clearInterval(alive);
    const r = room && rooms.get(room);
    if (!r) return;
    r.delete(me);
    for (const p of r.values()) send(p.ws, { t: 'peer-left', id: me });
    if (!r.size) rooms.delete(room);
  });
});
console.log(`Kaiser signaling server on ws://localhost:${PORT}`);
