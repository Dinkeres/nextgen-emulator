// Multiplayer session: signaling (WebSocket) + WebRTC mesh + lobby state + game start barrier.
// Lobby state is host-authoritative and travels through the signaling relay; game inputs travel
// peer-to-peer over unreliable/unordered data channels.
import type { NetMsg } from './rollback.ts';
import type { Session } from '../app/session.ts';
import type { Input } from '../engine/input.ts';
import { padKind } from '../engine/input.ts';
import { SYSTEMS } from '../engine/systems.ts';
import { toast } from '../app/store.ts';
import { db } from '../app/db.ts';
import { romFor } from '../app/library.ts';
import { isQuetzal, type QzMsg } from './quetzal.ts';

type StartCfg = { players: number[]; delay: number; maxRollback: number; link?: boolean; shared?: boolean };

export const ICE_SERVERS: RTCIceServer[] = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];

export interface LobbyGame { id: string; title: string; system: string }
export interface LobbyPeer { id: string; name: string; port: number | null; ready: boolean; hasRom: boolean | null; pad: string; ping: number }
export interface ChatLine { from: string; name: string; text: string; ts: number; sys?: boolean }
export interface LobbyState { room: string; hostId: string; game: LobbyGame | null; peers: LobbyPeer[]; started: boolean }

type Relay =
  | { k: 'hello'; name: string; hasRom: boolean | null; pad: string }
  | { k: 'ready'; ready: boolean } | { k: 'spectate'; on: boolean } | { k: 'chat'; text: string }
  | { k: 'lobby'; state: LobbyState } | { k: 'chatline'; line: ChatLine }
  | { k: 'start'; players: number[]; delay: number; maxRollback: number; link?: boolean; shared?: boolean }
  | { k: 'sram'; port: number; i: number; n: number; data: string }
  | { k: 'loaded' } | { k: 'go' } | { k: 'rom'; hasRom: boolean | null }
  // fallback transport through the signaling server when no direct WebRTC channel is open
  | { k: 'net'; m: NetMsg } | { k: 'qz'; m: QzMsg } | { k: 'syncPart'; from: number; frame: number; i: number; n: number; data: string };

type Peer = { pc: RTCPeerConnection; input?: RTCDataChannel; ctl?: RTCDataChannel; rtt: number; pingAt: number };

export class NetSession {
  private ws!: WebSocket;
  me = '';
  state: LobbyState = { room: '', hostId: '', game: null, peers: [], started: false };
  chat: ChatLine[] = [];
  error = '';
  private peers = new Map<string, Peer>();
  private ls = new Set<() => void>();
  onStart?: (cfg: StartCfg) => void;
  private startCfg: StartCfg | null = null;
  /** link play: everyone's battery save, gathered before boot (port -> chunks) */
  private sramParts = new Map<number, string[]>();
  private sramWaiter: (() => void) | null = null;
  private loaded = new Set<string>();
  private goResolve: (() => void) | null = null;
  private sess: Session | null = null;
  private syncRx = new Map<string, { hdr: { frame: number; size: number; from: number }; chunks: Uint8Array[]; got: number }>();
  private pingTimer = 0;
  private seenAt = new Map<string, number>();
  private ended = false;

  get isHost() { return this.me === this.state.hostId; }
  get mePeer() { return this.state.peers.find(p => p.id === this.me); }
  sub(l: () => void) { this.ls.add(l); return () => { this.ls.delete(l); }; }
  private emit() { this.ls.forEach(l => l()); }

  static async connect(url: string, name: string, opts: { create?: LobbyGame; room?: string; hasRom?: (g: LobbyGame) => boolean | null }): Promise<NetSession> {
    const s = new NetSession();
    s.hasRomFn = opts.hasRom ?? (() => null);
    await new Promise<void>((res, rej) => {
      let ws: WebSocket;
      // rooms are URL paths (Cloudflare routes each room to its own Durable Object)
      const base = url.replace(/\/+$/, '');
      const target = `${base}/room/${opts.create ? 'new' : encodeURIComponent((opts.room ?? '').toUpperCase())}`;
      try { ws = new WebSocket(target); } catch { rej(new Error('Invalid signaling server address.')); return; }
      s.ws = ws;
      const t = setTimeout(() => { ws.close(); rej(new Error(`Couldn't reach the signaling server at ${url}. Is it running?`)); }, 6000);
      ws.onerror = () => { clearTimeout(t); rej(new Error(`Couldn't reach the signaling server at ${url}. Is it running? (npm run signal)`)); };
      ws.onopen = () => ws.send(JSON.stringify(opts.create ? { t: 'create', name } : { t: 'join', room: opts.room, name }));
      ws.onmessage = ev => {
        const m = JSON.parse(ev.data);
        if (m.t === 'error') { clearTimeout(t); rej(new Error(m.message)); return; }
        if (m.t === 'joined') {
          clearTimeout(t);
          s.me = m.you; s.state.room = m.room; s.state.hostId = m.host;
          ws.onmessage = e2 => s.onSignal(JSON.parse(e2.data));
          ws.onclose = () => { if (!s.ended) { s.error = 'Lost connection to the signaling server.'; s.emit(); } };
          if (opts.create) {
            s.state.game = opts.create;
            s.state.peers = [{ id: s.me, name, port: 0, ready: true, hasRom: true, pad: s.padName(), ping: 0 }];
          } else {
            for (const p of m.peers) { s.seenAt.set(p.id, Date.now()); s.connectTo(p.id); } // newcomer offers to everyone already here
            s.relay({ k: 'hello', name, hasRom: null, pad: s.padName() });
          }
          s.pingTimer = window.setInterval(() => s.pingAll(), 1000);
          res();
        }
      };
    });
    return s;
  }
  private hasRomFn: (g: LobbyGame) => boolean | null = () => null;

  private padName() { const g = (navigator.getGamepads?.() ?? []).find(Boolean); return g ? padKind(g.id) : 'keyboard'; }

  private send(m: object) { if (this.ws.readyState === 1) this.ws.send(JSON.stringify(m)); }
  private relay(data: Relay, to?: string) { this.send({ t: 'relay', data, to }); }

  // ---------------- signaling ----------------
  private async onSignal(m: { t: string; from?: string; id?: string; name?: string; data?: unknown }) {
    switch (m.t) {
      case 'peer-joined': this.seenAt.set(m.id!, Date.now()); this.sysChat(`${m.name} joined`); break;
      case 'peer-left': this.peerLeft(m.id!); break;
      case 'signal': await this.onRtc(m.from!, m.data as { sdp?: RTCSessionDescriptionInit; ice?: RTCIceCandidateInit }); break;
      case 'relay': this.onRelay(m.from!, m.data as Relay); break;
    }
  }

  private newPc(id: string): Peer {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    const p: Peer = { pc, rtt: -1, pingAt: 0 };
    pc.onicecandidate = e => { if (e.candidate) this.send({ t: 'signal', to: id, data: { ice: e.candidate.toJSON() } }); };
    pc.ondatachannel = e => this.wire(id, p, e.channel);
    pc.onconnectionstatechange = () => { if (pc.connectionState === 'failed') this.sysChat(`Couldn't connect directly to ${this.nameOf(id)} (a TURN server may be needed).`); };
    this.peers.set(id, p);
    return p;
  }

  private async connectTo(id: string) {
    const p = this.newPc(id);
    this.wire(id, p, p.pc.createDataChannel('input', { ordered: false, maxRetransmits: 0 }));
    this.wire(id, p, p.pc.createDataChannel('ctl', { ordered: true }));
    await p.pc.setLocalDescription(await p.pc.createOffer());
    this.send({ t: 'signal', to: id, data: { sdp: p.pc.localDescription } });
  }

  private async onRtc(from: string, d: { sdp?: RTCSessionDescriptionInit; ice?: RTCIceCandidateInit }) {
    const p = this.peers.get(from) ?? this.newPc(from);
    if (d.sdp) {
      await p.pc.setRemoteDescription(d.sdp);
      if (d.sdp.type === 'offer') {
        await p.pc.setLocalDescription(await p.pc.createAnswer());
        this.send({ t: 'signal', to: from, data: { sdp: p.pc.localDescription } });
      }
    } else if (d.ice) await p.pc.addIceCandidate(d.ice).catch(() => {});
  }

  private wire(id: string, p: Peer, ch: RTCDataChannel) {
    ch.binaryType = 'arraybuffer';
    if (ch.label === 'input') p.input = ch; else p.ctl = ch;
    ch.onmessage = e => this.onData(id, p, ch, e.data);
    ch.onopen = () => this.emit();
  }

  // ---------------- data channels ----------------
  private onData(id: string, p: Peer, ch: RTCDataChannel, data: string | ArrayBuffer) {
    if (typeof data !== 'string') { this.onSyncChunk(id, new Uint8Array(data)); return; }
    const m = JSON.parse(data);
    if (m.k === 'ping') { ch.send(JSON.stringify({ k: 'pong', ts: m.ts })); return; }
    if (m.k === 'pong') { p.rtt = performance.now() - m.ts; this.reportPing(id, p.rtt); return; }
    if (m.k === 'qz') { this.sess?.emu.qzReceive(m.m); return; }
    if (m.k === 'syncHdr') { this.syncRx.set(id, { hdr: m, chunks: [], got: 0 }); return; }
    if (m.t) this.sess?.emu.netReceive(m as NetMsg);
  }

  private onSyncChunk(id: string, c: Uint8Array) {
    const rx = this.syncRx.get(id);
    if (!rx) return;
    rx.chunks.push(c); rx.got += c.length;
    if (rx.got < rx.hdr.size) return;
    const state = new Uint8Array(rx.hdr.size);
    let o = 0; for (const x of rx.chunks) { state.set(x, o); o += x.length; }
    this.syncRx.delete(id);
    this.sess?.emu.netReceive({ t: 'sync', from: rx.hdr.from, frame: rx.hdr.frame, state });
    toast('Resynced with host', 'rotate', 'info');
  }

  private pingAll() {
    for (const p of this.peers.values()) if (p.ctl?.readyState === 'open') p.ctl.send(JSON.stringify({ k: 'ping', ts: performance.now() }));
    if (!this.state.started) this.emit(); // lobby state that depends on time (connection grace period)
  }
  private reportPing(id: string, rtt: number) {
    const peer = this.state.peers.find(x => x.id === id);
    if (peer) { peer.ping = Math.round(rtt); this.emit(); }
  }

  /** Broadcast a rollback message to every peer (unreliable for inputs, reliable otherwise). */
  private broadcast(m: NetMsg) {
    for (const lp of this.state.peers) {
      if (lp.id === this.me) continue;
      const p = this.peers.get(lp.id);
      const spectator = lp.port === null;
      if (m.t === 'sync') {
        if (p?.ctl?.readyState === 'open') {
          p.ctl.send(JSON.stringify({ k: 'syncHdr', frame: m.frame, size: m.state.length, from: m.from }));
          for (let i = 0; i < m.state.length; i += 16384) p.ctl.send(m.state.slice(i, i + 16384));
        } else this.relaySync(m, lp.id);
        continue;
      }
      const ch = spectator || m.t === 'hash' ? p?.ctl : p?.input;
      if (ch?.readyState === 'open') ch.send(JSON.stringify(m));
      else this.relay({ k: 'net', m }, lp.id); // no direct path (strict NAT): go through the server
    }
  }

  private relaySync(m: Extract<NetMsg, { t: 'sync' }>, to: string) {
    let bin = ''; for (let i = 0; i < m.state.length; i += 0x8000) bin += String.fromCharCode(...m.state.subarray(i, i + 0x8000));
    const b64 = btoa(bin), CH = 48000, n = Math.ceil(b64.length / CH);
    for (let i = 0; i < n; i++) this.relay({ k: 'syncPart', from: m.from, frame: m.frame, i, n, data: b64.slice(i * CH, (i + 1) * CH) }, to);
  }
  private syncParts: string[] = [];

  /** 'direct' when a WebRTC channel is open to that peer, otherwise 'relay'. */
  linkType(id: string): 'direct' | 'relay' { return this.peers.get(id)?.input?.readyState === 'open' ? 'direct' : 'relay'; }

  // ---------------- lobby (host authoritative) ----------------
  private onRelay(from: string, d: Relay) {
    if (d.k === 'net') { this.sess?.emu.netReceive(d.m); return; }
    if (d.k === 'qz') { this.sess?.emu.qzReceive(d.m); return; }
    if (d.k === 'sram') {
      const parts = this.sramParts.get(d.port) ?? [];
      parts[d.i] = d.data;
      this.sramParts.set(d.port, parts);
      this.sramTotals.set(d.port, d.n);
      this.sramWaiter?.();
      return;
    }
    if (d.k === 'syncPart') {
      this.syncParts[d.i] = d.data;
      if (this.syncParts.filter(Boolean).length === d.n) {
        const state = Uint8Array.from(atob(this.syncParts.join('')), c => c.charCodeAt(0));
        this.syncParts = [];
        this.sess?.emu.netReceive({ t: 'sync', from: d.from, frame: d.frame, state });
        toast('Resynced with host', 'rotate', 'info');
      }
      return;
    }
    if (this.isHost) {
      const peer = this.state.peers.find(p => p.id === from);
      if (d.k === 'hello' && !peer && !this.state.started) {
        const max = SYSTEMS[this.state.game!.system]?.maxPlayers ?? 2;
        const used = new Set(this.state.peers.map(p => p.port));
        let port: number | null = null;
        for (let i = 0; i < max; i++) if (!used.has(i)) { port = i; break; }
        this.state.peers.push({ id: from, name: d.name.slice(0, 20) || 'Player', port, ready: false, hasRom: null, pad: d.pad, ping: -1 });
        this.pushLobby();
      } else if (peer && d.k === 'ready') { peer.ready = d.ready; this.pushLobby(); }
      else if (peer && d.k === 'rom') { peer.hasRom = d.hasRom; if (!d.hasRom) peer.ready = false; this.pushLobby(); }
      else if (peer && d.k === 'spectate') {
        if (d.on) peer.port = null;
        else { const max = SYSTEMS[this.state.game!.system]?.maxPlayers ?? 2; const used = new Set(this.state.peers.map(p => p.port)); for (let i = 0; i < max; i++) if (!used.has(i)) { peer.port = i; break; } }
        this.pushLobby();
      } else if (peer && d.k === 'chat') this.addChat({ from, name: peer.name, text: d.text.slice(0, 300), ts: Date.now() }, true);
      else if (d.k === 'loaded') { this.loaded.add(from); this.checkGo(); }
      return;
    }
    // non-host: only trust the host for authoritative messages
    if (from !== this.state.hostId) return;
    if (d.k === 'lobby') {
      const known = new Map(this.state.peers.map(p => [p.id, p.ping]));
      const first = !this.state.game;
      this.state = { ...d.state, peers: d.state.peers.map(p => ({ ...p, ping: p.id === this.me ? 0 : known.get(p.id) ?? p.ping })) };
      if (first && this.state.game) this.relay({ k: 'rom', hasRom: this.hasRomFn(this.state.game) }, this.state.hostId);
      this.emit();
    } else if (d.k === 'chatline') this.addChat(d.line, false);
    else if (d.k === 'start') { this.startCfg = d; this.state.started = true; this.emit(); this.onStart?.(d); }
    else if (d.k === 'go') this.goResolve?.();
  }

  private pushLobby() { this.relay({ k: 'lobby', state: this.state }); this.emit(); }
  private addChat(line: ChatLine, rebroadcast: boolean) {
    this.chat = [...this.chat.slice(-99), line];
    if (rebroadcast && this.isHost) this.relay({ k: 'chatline', line });
    this.emit();
  }
  private sysChat(text: string) { this.chat = [...this.chat.slice(-99), { from: '', name: '', text, ts: Date.now(), sys: true }]; this.emit(); }
  nameOf(id: string) { return this.state.peers.find(p => p.id === id)?.name ?? 'A player'; }

  sendChat(text: string) {
    if (!text.trim()) return;
    if (this.isHost) this.addChat({ from: this.me, name: this.mePeer?.name ?? 'Host', text: text.slice(0, 300), ts: Date.now() }, true);
    else this.relay({ k: 'chat', text });
  }
  setReady(ready: boolean) { if (this.isHost) return; this.relay({ k: 'ready', ready }, this.state.hostId); }
  setSpectator(on: boolean) { this.relay({ k: 'spectate', on }, this.state.hostId); }
  /** Tell the host whether we have the exact ROM (after adding it). */
  reportRom(hasRom: boolean | null) { if (!this.isHost) this.relay({ k: 'rom', hasRom }, this.state.hostId); }

  canStart(): string | null {
    const players = this.state.peers.filter(p => p.port !== null);
    if (players.length < 2) return 'Waiting for another player to join…';
    const missing = players.find(p => p.hasRom === false || p.hasRom === null && p.id !== this.me);
    if (missing) return `${missing.name} doesn't have the same ROM yet.`;
    const notReady = players.find(p => !p.ready);
    if (notReady) return `Waiting for ${notReady.name} to ready up…`;
    // wait a few seconds for a direct WebRTC link; after that the server relay is used instead
    for (const p of players) if (p.id !== this.me && this.linkType(p.id) === 'relay' && Date.now() - (this.seenAt.get(p.id) ?? 0) < 8000) return `Connecting to ${p.name}…`;
    return null;
  }

  /** Host: pick input delay from the worst ping and start everyone. */
  start(opts: { inputDelay: number | 'auto'; maxRollback: number }) {
    if (!this.isHost || this.canStart()) return;
    const sys = SYSTEMS[this.state.game!.system];
    // renumber player slots 0..n-1 so a link cable / port list never has gaps
    this.state.peers.filter(p => p.port !== null).sort((a, b) => a.port! - b.port!).forEach((p, i) => { p.port = i; });
    const players = this.state.peers.filter(p => p.port !== null).map(p => p.port!).sort((a, b) => a - b);
    const worst = Math.max(0, ...this.state.peers.filter(p => p.port !== null && p.id !== this.me).map(p => p.ping));
    const oneWayFrames = worst / 2 / (1000 / 60);
    const maxRollback = sys.rollback ? opts.maxRollback : 0;
    const delay = opts.inputDelay !== 'auto' ? opts.inputDelay
      : maxRollback ? Math.min(4, Math.max(0, Math.round(oneWayFrames) - 1)) : Math.min(8, Math.max(2, Math.ceil(oneWayFrames) + 1));
    const cfg: StartCfg = { players, delay, maxRollback, link: sys.id === 'gba', shared: sys.id === 'nds' };
    this.startCfg = cfg;
    this.state.started = true;
    this.pushLobby(); // (renumbered ports) must reach everyone before 'start'
    this.relay({ k: 'start', ...cfg });
    this.onStart?.(cfg);
  }

  // ---------------- game phase ----------------
  /** Called by the Player: boots the game fresh on every machine, waits for all, then goes. */
  async attach(sess: Session, _input: Input) {
    this.sess = sess;
    const cfg = this.startCfg!;
    sess.emu.setNetHandlers(m => this.broadcast(m), frame => {
      if (this.isHost) { sess.emu.netResync(); toast(`Desync at frame ${frame} — resyncing everyone`, 'rotate', 'warn'); }
      console.warn('[netplay] desync detected at frame', frame);
    });
    const mine = this.mePeer?.port ?? null;
    if (cfg.link && cfg.players.length === 2 && mine !== null && isQuetzal(new Uint8Array(await romFor(sess.game)))) {
      await this.startQuetzal(sess, mine === 0);
      return;
    }
    if (cfg.link) {
      // GBA link cable: each machine runs every player's GBA, each with that player's own save
      const srams = await this.exchangeSrams(mine, cfg.players.length);
      await sess.start({ netplay: true, link: { players: cfg.players.length, srams, view: mine ?? 0 } });
    } else await sess.start({ netplay: true });
    sess.emu.pause();
    const go = new Promise<void>(res => { this.goResolve = res; });
    if (this.isHost) { this.loaded.add(this.me); this.checkGo(); } else this.relay({ k: 'loaded' }, this.state.hostId);
    await Promise.race([go, new Promise((_, rej) => setTimeout(() => rej(new Error('Timed out waiting for the other players to load the game.')), 30000))]);
    sess.emu.netStart({ localPort: this.mePeer?.port ?? -1, players: cfg.players, inputDelay: cfg.delay, maxRollback: cfg.maxRollback, shared: cfg.shared });
    await sess.emu.resume();
    toast(cfg.maxRollback ? `Online · ${cfg.delay}f delay · rollback on` : `Online · ${cfg.delay}f delay`, 'users', 'success');
  }

  /** Pokémon Quetzal: no lockstep at all. Each player plays their own game with their own save
   *  (auto-save, save states and speed-up all work); Mplayer's link messages go over the reliable
   *  channel. Much lighter than running both GBAs on every machine. */
  private async startQuetzal(sess: Session, host: boolean) {
    const other = () => this.state.peers.find(p => p.id !== this.me && p.port !== null);
    await sess.start();
    sess.emu.qzStart(host, m => {
      const o = other();
      if (!o) return;
      const ch = this.peers.get(o.id)?.ctl;
      if (ch?.readyState === 'open') ch.send(JSON.stringify({ k: 'qz', m }));
      else this.relay({ k: 'qz', m }, o.id);
    }, text => toast('Co-op: ' + text, 'users', 'info', 3000));
    toast('Quetzal co-op ready: both open START → MPLAYER → 2P, then the host presses A', 'users', 'success', 7000);
  }

  /** Send our battery save to everyone and collect theirs (empty string = no save). */
  private async exchangeSrams(mine: number | null, players: number): Promise<(ArrayBuffer | null)[]> {
    if (mine !== null) {
      const s = await db.sram(this.state.game!.id);
      let bin = '';
      if (s) for (let i = 0; i < s.length; i += 0x8000) bin += String.fromCharCode(...s.subarray(i, i + 0x8000));
      const b64 = btoa(bin), CH = 48000, n = Math.max(1, Math.ceil(b64.length / CH));
      for (let i = 0; i < n; i++) this.relay({ k: 'sram', port: mine, i, n, data: b64.slice(i * CH, (i + 1) * CH) });
      this.sramParts.set(mine, [b64]);
      this.sramTotals.set(mine, 1);
    }
    const ready = () => Array.from({ length: players }, (_, p) => this.sramComplete(p)).every(Boolean);
    if (!ready()) await Promise.race([
      new Promise<void>(res => { this.sramWaiter = () => { if (ready()) res(); }; }),
      new Promise((_, rej) => setTimeout(() => rej(new Error("Couldn't receive every player's save data.")), 30000)),
    ]);
    this.sramWaiter = null;
    return Array.from({ length: players }, (_, p) => {
      const b64 = this.sramParts.get(p)!.join('');
      return b64 ? Uint8Array.from(atob(b64), c => c.charCodeAt(0)).buffer as ArrayBuffer : null;
    });
  }
  private sramTotals = new Map<number, number>();
  private sramComplete(port: number) {
    const parts = this.sramParts.get(port);
    if (!parts) return false;
    const n = this.sramTotals.get(port);
    return n === undefined ? parts.length === 1 : parts.filter(x => x !== undefined).length === n;
  }

  private checkGo() {
    if (!this.isHost || !this.startCfg) return;
    if (this.state.peers.every(p => this.loaded.has(p.id))) { this.relay({ k: 'go' }); this.goResolve?.(); }
  }

  names(): Record<number, string> {
    const o: Record<number, string> = {};
    for (const p of this.state.peers) if (p.port !== null) o[p.port] = p.name;
    return o;
  }

  private peerLeft(id: string) {
    const p = this.state.peers.find(x => x.id === id);
    this.peers.get(id)?.pc.close();
    this.peers.delete(id);
    const name = p?.name ?? 'A player';
    if (id === this.state.hostId) {
      this.error = 'The host closed the room.';
      if (this.sess) { this.sess.emu.netStop(); toast('Host left — continuing offline', 'alert', 'warn', 4000); }
    } else if (this.sess && p?.port !== null && p) {
      this.sess.emu.netStop();
      toast(`${name} disconnected — continuing offline`, 'alert', 'warn', 4000);
    } else if (p) toast(`${name} left`, 'users', 'info');
    if (this.isHost) { this.state.peers = this.state.peers.filter(x => x.id !== id); this.pushLobby(); }
    this.sysChat(`${name} left`);
  }

  detach() { this.sess = null; this.close(); }

  close() {
    this.ended = true;
    clearInterval(this.pingTimer);
    for (const p of this.peers.values()) p.pc.close();
    this.peers.clear();
    try { this.ws?.close(); } catch { /* already closed */ }
  }
}
