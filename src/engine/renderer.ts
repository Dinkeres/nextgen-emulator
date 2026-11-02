// WebGL2 presenter with built-in shaders. Runs in the worker on an OffscreenCanvas
// (or on the main thread as a fallback). Takes RGBA8 frames straight from wasm memory.

export type ShaderId = 'sharp' | 'nearest' | 'smooth' | 'scanlines' | 'crt' | 'lcd';
export type AspectMode = 'core' | '4:3' | '16:9' | 'square' | 'stretch';

export interface DisplayOptions { shader: ShaderId; aspect: AspectMode; integer: boolean; }

const VS = `#version 300 es
in vec2 p; out vec2 uv;
void main(){ uv = vec2(p.x*.5+.5, .5-p.y*.5); gl_Position = vec4(p,0.,1.); }`;

const HEAD = `#version 300 es
precision highp float;
in vec2 uv; out vec4 o;
uniform sampler2D T; uniform vec2 S; uniform vec2 O;
vec3 sharp(vec2 c){
  vec2 t = c*S, sc = max(floor(O/S), 1.);
  vec2 d = fract(t) - .5, r = .5 - .5/sc;
  vec2 f = (d - clamp(d, -r, r))*sc + .5;
  return texture(T, (floor(t)+f)/S).rgb;
}
`;

const FS: Record<ShaderId, string> = {
  sharp: `void main(){ o = vec4(sharp(uv),1.); }`,
  nearest: `void main(){ o = vec4(texelFetch(T, ivec2(uv*S), 0).rgb,1.); }`,
  smooth: `void main(){ o = vec4(texture(T, uv).rgb,1.); }`,
  scanlines: `void main(){
    vec3 c = sharp(uv); float y = fract(uv.y*S.y) - .5;
    float w = 1. - .45*smoothstep(.15,.5,abs(y))*min(O.y/S.y/3.,1.);
    o = vec4(c*w*1.08,1.); }`,
  crt: `void main(){
    vec2 q = uv*2.-1.; q *= 1. + vec2(q.y*q.y, q.x*q.x)*vec2(.035,.045);
    vec2 c = q*.5+.5;
    if (c.x<0.||c.y<0.||c.x>1.||c.y>1.) { o = vec4(0,0,0,1); return; }
    vec2 t = c*S; vec2 px = 1./S;
    vec3 col = texture(T, (floor(t)+.5+vec2(fract(t.x)-.5,0.)*.6)/S).rgb;
    col += .12*(texture(T,c+vec2(px.x,0.)).rgb + texture(T,c-vec2(px.x,0.)).rgb);
    float y = fract(t.y)-.5; col *= mix(1., exp(-y*y*14.)*1.35, clamp(O.y/S.y/2.5,0.,1.));
    float m = mod(gl_FragCoord.x, 3.);
    col *= vec3(m<1.?1.1:.92, m>=1.&&m<2.?1.1:.92, m>=2.?1.1:.92);
    float v = 1. - dot(q*.55, q*.55); col *= clamp(v*1.25,0.,1.);
    o = vec4(pow(col, vec3(.95)),1.); }`,
  lcd: `void main(){
    vec2 t = uv*S; vec3 c = texelFetch(T, ivec2(t), 0).rgb;
    vec2 f = abs(fract(t)-.5)*2.; float k = min(O.y/S.y, O.x/S.x);
    float g = 1. - .35*smoothstep(1.-3./max(k,3.), 1., max(f.x,f.y));
    o = vec4(c*g + .025,1.); }`,
};

export class Renderer {
  private gl: WebGL2RenderingContext;
  private progs = new Map<ShaderId, { p: WebGLProgram; S: WebGLUniformLocation; O: WebGLUniformLocation }>();
  private tex: WebGLTexture;
  private tw = 0; private th = 0;
  opts: DisplayOptions = { shader: 'sharp', aspect: 'core', integer: false };
  coreAspect = 4 / 3;

  constructor(private canvas: OffscreenCanvas | HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, desynchronized: true, preserveDrawingBuffer: false, powerPreference: 'high-performance' }) as WebGL2RenderingContext | null;
    if (!gl) throw new Error('WebGL2 not available');
    this.gl = gl;
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.clearColor(0, 0, 0, 1);
  }

  private prog(id: ShaderId) {
    let p = this.progs.get(id);
    if (p) return p;
    const gl = this.gl;
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!; gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || 'shader');
      return s;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, HEAD + FS[id]));
    gl.bindAttribLocation(prog, 0, 'p');
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) || 'link');
    p = { p: prog, S: gl.getUniformLocation(prog, 'S')!, O: gl.getUniformLocation(prog, 'O')! };
    this.progs.set(id, p);
    return p;
  }

  size(): [number, number] { return [this.canvas.width, this.canvas.height]; }

  resize(w: number, h: number) {
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
  }

  /** Output rectangle inside the canvas, honoring aspect + integer scaling. */
  viewport(): [number, number, number, number] {
    const cw = this.canvas.width, ch = this.canvas.height, o = this.opts;
    if (o.aspect === 'stretch' || !this.tw) return [0, 0, cw, ch];
    const ar = o.aspect === '4:3' ? 4 / 3 : o.aspect === '16:9' ? 16 / 9 : o.aspect === 'square' ? this.tw / this.th : this.coreAspect;
    let h = ch, w = h * ar;
    if (w > cw) { w = cw; h = w / ar; }
    if (o.integer) {
      const k = Math.max(1, Math.floor(h / this.th));
      h = this.th * k; w = Math.round(h * ar);
      if (w > cw) { w = cw; }
    }
    w = Math.round(w); h = Math.round(h);
    return [Math.floor((cw - w) / 2), Math.floor((ch - h) / 2), w, h];
  }

  draw(data: Uint8Array | null, width: number, height: number) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    if (data) {
      if (width !== this.tw || height !== this.th) {
        this.tw = width; this.th = height;
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
      } else {
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, data);
      }
    }
    if (!this.tw) return;
    const [x, y, w, h] = this.viewport();
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.viewport(x, this.canvas.height - y - h, w, h);
    const p = this.prog(this.opts.shader);
    gl.useProgram(p.p);
    gl.uniform2f(p.S, this.tw, this.th);
    gl.uniform2f(p.O, w, h);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  /** Redraw the last uploaded frame (after resize / shader change while paused). */
  redraw() { this.draw(null, this.tw, this.th); }
}
