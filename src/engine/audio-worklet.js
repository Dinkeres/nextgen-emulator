// AudioWorklet: plays stereo float frames from a ring buffer.
// Shared mode: ring lives in a SharedArrayBuffer written directly by the emulator worker.
// Port mode (no cross-origin isolation): chunks arrive over a MessagePort from the worker.
// Layout of shared control Int32Array: [0]=write index, [1]=read index, [2]=underruns (frames).
class RingPlayer extends AudioWorkletProcessor {
  constructor(opts) {
    super();
    const o = opts.processorOptions;
    if (o.sab) {
      this.data = new Float32Array(o.sab.data);
      this.ctl = new Int32Array(o.sab.ctl);
    } else {
      this.data = new Float32Array(o.capacity * 2);
      this.ctl = new Int32Array(3);
    }
    this.cap = this.data.length / 2;
    this.n = 0;
    this.port.onmessage = e => {
      const m = e.data;
      if (m.port) { this.wport = m.port; this.wport.onmessage = ev => this.push(ev.data); }
      else if (m.clear) { Atomics.store(this.ctl, 1, Atomics.load(this.ctl, 0)); }
    };
  }
  push(f) { // port mode only
    let w = this.ctl[0];
    const frames = f.length >> 1;
    const free = this.cap - 1 - ((w - this.ctl[1] + this.cap) % this.cap);
    const n = Math.min(frames, free);
    for (let i = 0; i < n; i++) { this.data[w * 2] = f[i * 2]; this.data[w * 2 + 1] = f[i * 2 + 1]; w = (w + 1) % this.cap; }
    this.ctl[0] = w;
  }
  process(_in, outputs) {
    const L = outputs[0][0], R = outputs[0][1] || outputs[0][0];
    const w = Atomics.load(this.ctl, 0);
    let r = Atomics.load(this.ctl, 1);
    const avail = (w - r + this.cap) % this.cap;
    const n = Math.min(avail, L.length);
    for (let i = 0; i < n; i++) { L[i] = this.data[r * 2]; R[i] = this.data[r * 2 + 1]; r = (r + 1) % this.cap; }
    if (n < L.length) {
      // underrun: fade the tail instead of clicking
      const last = n ? L[n - 1] : 0, lastR = n ? R[n - 1] : 0;
      for (let i = n; i < L.length; i++) { const k = 1 - (i - n) / (L.length - n); L[i] = last * k; R[i] = lastR * k; }
      if (avail === 0) Atomics.add(this.ctl, 2, L.length - n);
    }
    Atomics.store(this.ctl, 1, r);
    if (this.wport && (++this.n & 7) === 0) this.wport.postMessage({ fill: (w - r + this.cap) % this.cap, underruns: this.ctl[2] });
    return true;
  }
}
registerProcessor('ring-player', RingPlayer);
