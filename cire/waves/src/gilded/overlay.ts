/**
 * The Gilded wave's gold, drawn with WebGL 2 over a View Transition: the band
 * that rides the front, a fine crest of light on it, the colour left on the
 * frame's edges with a hairline, and the dust. It never reads the page: the
 * page under it is the live one, revealed by the transition's mask, so this
 * layer owns only light.
 *
 * Decoration, never the contract: without WebGL 2, or with a shader the driver
 * will not compile, `createOverlay` answers `null` and the transition runs
 * without it.
 */

import { dustAt, WAVE, type Stage, type WaveFrame } from "./wave";

/** The overlay's colours: five for the band (OKLab), and the dust's two (sRGB). */
export interface Colours {
  readonly palette: readonly number[];
  readonly gold: readonly [number, number, number];
  readonly hi: readonly [number, number, number];
  /** Luma of the ground under the bar, the view leaving and the view arriving. */
  readonly barLum: number;
  readonly lumA: number;
  readonly lumB: number;
}

export interface Overlay {
  readonly canvas: HTMLCanvasElement;
  /** Sizes the drawing buffer to the stage. */
  resize(stage: Stage): void;
  draw(stage: Stage, w: WaveFrame, colours: Colours): void;
  clear(): void;
  dispose(): void;
}

const VERT = `#version 300 es
in vec2 a; void main(){ gl_Position = vec4(a, 0., 1.); }`;

const MAIN = `#version 300 es
precision highp float; out vec4 o;
uniform vec2 res, src; uniform float dpr, vTop, tilt, radius, swell, time, clearR, hairR, rimOn, band, reach, barLum, lumA, lumB;
uniform vec3 pal[5]; uniform vec3 deep, shine;
float hash(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vnoise(vec2 p){ vec2 i = floor(p), f = fract(p); vec2 w = f * f * (3. - 2. * f);
  return mix(mix(hash(i), hash(i + vec2(1,0)), w.x), mix(hash(i + vec2(0,1)), hash(i + vec2(1,1)), w.x), w.y); }
float fbm(vec2 p){ float a = .5, s = 0.; for (int i = 0; i < 5; i++){ s += a * vnoise(p); p *= 2.03; a *= .5; } return s; }
const float PI = 3.14159265;
vec3 toSrgb(vec3 c){ c = max(c, 0.); return mix(c * 12.92, 1.055 * pow(c, vec3(1. / 2.4)) - .055, step(.0031308, c)); }
vec3 fromOklab(vec3 L){ vec3 lms = mat3(1., 1., 1., .3963377774, -.1055613458, -.0894841775, .2158037573, -.0638541728, -1.2914855480) * L;
  lms = lms * lms * lms; return toSrgb(mat3(4.0767416621, -1.2684380046, -.0041960863, -3.3077115913, 2.6097574011, -.7034186147, .2309699292, -.3413193965, 1.7076147010) * lms); }
vec3 paletteAt(float f){ f = fract(f) * 5.; int i = int(floor(f)); float k = fract(f); k = k * k * (3. - 2. * k); return fromOklab(mix(pal[i], pal[(i + 1) % 5], k)); }
float bandProfile(float d, float lead, float tail){
  if (d > 0.) { float k = clamp(1. - d / lead, 0., 1.); return k * k * k * (k * (k * 6. - 15.) + 10.); }
  return pow(1. - clamp(-d / tail, 0., 1.), 2.3);
}
void main(){
  vec2 P = vec2(gl_FragCoord.x, res.y - gl_FragCoord.y);
  float R = reach;
  vec2 raw = P - src; float r = max(length(raw), 1.); vec2 n = raw / r;
  float cs = cos(tilt), sn = sin(tilt); vec2 q = vec2(cs * raw.x + sn * raw.y, -sn * raw.x + cs * raw.y);
  float ang = atan(q.y, q.x);
  float bend = .62 * sin(2. * ang + time * 1.1) + .38 * sin(3. * ang - time * 1.5 + 1.7);
  // a circle, the shape the transition's mask follows
  float l = length(raw);
  float d = (l - radius) + swell * bend;
  vec3 C = vec3(0.); float Al = 0.;
  bool onPage = P.y >= vTop;
  // the hand-over's edge, roughened like ink taking to paper: which ground the rim sits on
  float m = smoothstep(.05 * R, -.035 * R, d + (fbm(P / (.1 * R) + vec2(time * .25, 0.)) - .5) * .06 * R);

  // the gold band rides the front, lit as metal from its own slope
  float lead = .14 * R, tail = .28 * R;
  float bandA = min(bandProfile(d, lead, tail) * band * 1.05, .96);
  float slope = (bandProfile(d + dpr, lead, tail) - bandProfile(d - dpr, lead, tail)) / (2. * dpr) * band;
  vec3 L = normalize(vec3(-.45, -.65, .62));
  vec3 nn = normalize(vec3(-n * slope * .06 * R, 1.));
  float lit = dot(nn, L);
  vec3 bc = paletteAt(.62 + ang / (2. * PI) + time * .13 + d / R * 1.4);
  bc = bc * (.78 + .38 * lit) + shine * pow(max(lit, 0.), 22.) * .55;
  C = bc * bandA + C * (1. - bandA); Al = bandA + Al * (1. - bandA);
  // a fine crest of light exactly on the front
  float crest = exp(-pow(d / (3. * dpr), 2.)) * .5 * band;
  C = shine * crest + C * (1. - crest); Al = crest + Al * (1. - crest);

  // the colour stays on the frame's edges, unevenly, until a later front clears it
  vec2 hs = res * .5, pc = P - hs; float rr = 17. * dpr; vec2 qd = abs(pc) - (hs - rr);
  float inset = -(length(max(qd, 0.)) + min(max(qd.x, qd.y), 0.) - rr);
  float per = atan(pc.y, pc.x);
  float thick = .014 * R * (.45 + 1.1 * fbm(vec2(cos(per), sin(per)) * 1.3 + vec2(time * .22, 3.7)));
  float reached = 1. - smoothstep(-lead * .7, lead * .5, d);
  float soft = .24 * R;
  float shimmer = .5 + .5 * sin(time * 3.4 - per * 4.);
  float rimA = (1. - smoothstep(0., thick, inset)) * reached * smoothstep(-soft, soft, l - clearR) * rimOn * (.7 + .3 * shimmer) * .85;
  // on a light ground the rim turns to antique gold, or it vanishes into the paper
  float lum = onPage ? mix(lumA, lumB, m) : barLum;
  float onLight = smoothstep(.55, .8, lum);
  vec3 rc = mix(paletteAt(per / (2. * PI) + time * .13 + .3), deep, onLight * .75);
  C = rc * rimA + C * (1. - rimA); Al = rimA + Al * (1. - rimA);
  float hair = (1. - smoothstep(.75 * dpr, 1.5 * dpr, abs(inset - dpr))) * reached * smoothstep(-soft, soft, l - hairR) * rimOn * .9;
  vec3 hc = mix(mix(rc, vec3(1.), .55), deep, onLight * .8);
  C = hc * hair + C * (1. - hair); Al = hair + Al * (1. - hair);
  C += (hash(gl_FragCoord.xy) - .5) / 255. * Al;
  o = vec4(C, Al);
}`;

const DOT_VERT = `#version 300 es
in vec4 a; uniform vec2 res; out float vA; out float vT;
void main(){ gl_Position = vec4(a.x / res.x * 2. - 1., 1. - a.y / res.y * 2., 0., 1.); gl_PointSize = a.w; vA = a.z; vT = fract(float(gl_VertexID) * .618034); }`;

const DOT_FRAG = `#version 300 es
precision highp float; in float vA; in float vT; out vec4 o; uniform vec3 hi, gold;
void main(){ vec2 c = gl_PointCoord * 2. - 1.; float m = smoothstep(1., .2, dot(c, c)); vec3 col = mix(gold, hi, vT * .6 + .4);
  float a = m * vA; o = vec4(col * a, a); }`;

/** Antique gold for the rim on a light ground, and the light on the band. */
const DEEP = [0.5, 0.36, 0.15] as const;
const SHINE = [1, 0.96, 0.84] as const;

interface Program {
  readonly p: WebGLProgram;
  u(name: string): WebGLUniformLocation | null;
}

function build(gl: WebGL2RenderingContext, vs: string, fs: string): Program {
  const shader = (type: number, src: string) => {
    const s = gl.createShader(type);
    if (!s) throw new Error("no shader");
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error("shader did not compile");
    return s;
  };
  const p = gl.createProgram();
  if (!p) throw new Error("no program");
  gl.attachShader(p, shader(gl.VERTEX_SHADER, vs));
  gl.attachShader(p, shader(gl.FRAGMENT_SHADER, fs));
  gl.bindAttribLocation(p, 0, "a");
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error("program did not link");
  const cache = new Map<string, WebGLUniformLocation | null>();
  return {
    p,
    u: (name) => {
      if (!cache.has(name)) cache.set(name, gl.getUniformLocation(p, name));
      return cache.get(name) ?? null;
    },
  };
}

/**
 * The overlay on `canvas`, or `null` where the browser gives no WebGL 2
 * context or the shaders do not build. A `null` leaves the context released.
 */
export function createOverlay(canvas: HTMLCanvasElement): Overlay | null {
  const gl = canvas.getContext("webgl2", {
    alpha: true,
    premultipliedAlpha: true,
    antialias: true,
    depth: false,
    stencil: false,
  });
  if (!gl) return null;
  const release = () => gl.getExtension("WEBGL_lose_context")?.loseContext();
  let main: Program;
  let dots: Program;
  try {
    main = build(gl, VERT, MAIN);
    dots = build(gl, DOT_VERT, DOT_FRAG);
  } catch {
    release();
    return null;
  }

  const quad = gl.createVertexArray();
  gl.bindVertexArray(quad);
  const quadBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  const dust = gl.createVertexArray();
  gl.bindVertexArray(dust);
  const dustBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, dustBuf);
  gl.bufferData(gl.ARRAY_BUFFER, WAVE.dust * 16, gl.DYNAMIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);
  const dustData = new Float32Array(WAVE.dust * 4);

  const clear = () => {
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
  };

  return {
    canvas,
    resize(stage) {
      if (canvas.width !== stage.W || canvas.height !== stage.H) {
        canvas.width = stage.W;
        canvas.height = stage.H;
      }
      gl.viewport(0, 0, stage.W, stage.H);
    },
    draw(stage, w, colours) {
      if (gl.isContextLost()) return;
      clear();
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.useProgram(main.p);
      gl.uniform2f(main.u("res"), stage.W, stage.H);
      gl.uniform2f(main.u("src"), stage.src[0], stage.src[1]);
      gl.uniform1f(main.u("dpr"), stage.dpr);
      gl.uniform1f(main.u("vTop"), stage.vTop);
      gl.uniform1f(main.u("tilt"), stage.tilt);
      gl.uniform1f(main.u("radius"), w.radius);
      gl.uniform1f(main.u("swell"), w.swell);
      gl.uniform1f(main.u("clearR"), w.clearR);
      gl.uniform1f(main.u("hairR"), w.hairR);
      gl.uniform1f(main.u("rimOn"), w.rimOn);
      gl.uniform1f(main.u("band"), w.band);
      gl.uniform1f(main.u("time"), w.t);
      gl.uniform1f(main.u("reach"), w.reach);
      gl.uniform1f(main.u("barLum"), colours.barLum);
      gl.uniform1f(main.u("lumA"), colours.lumA);
      gl.uniform1f(main.u("lumB"), colours.lumB);
      gl.uniform3fv(main.u("deep"), DEEP);
      gl.uniform3fv(main.u("shine"), SHINE);
      gl.uniform3fv(main.u("pal"), colours.palette);
      gl.bindVertexArray(quad);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      gl.useProgram(dots.p);
      gl.uniform2f(dots.u("res"), stage.W, stage.H);
      gl.uniform3fv(dots.u("hi"), colours.hi);
      gl.uniform3fv(dots.u("gold"), colours.gold);
      // Dust adds light, so on ivory it glints instead of reading as specks.
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.bindVertexArray(dust);
      gl.bindBuffer(gl.ARRAY_BUFFER, dustBuf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, dustAt(stage, w, dustData));
      gl.drawArrays(gl.POINTS, 0, WAVE.dust);
      gl.bindVertexArray(null);
      gl.disable(gl.BLEND);
    },
    clear() {
      if (!gl.isContextLost()) clear();
    },
    dispose() {
      gl.deleteBuffer(quadBuf);
      gl.deleteBuffer(dustBuf);
      gl.deleteVertexArray(quad);
      gl.deleteVertexArray(dust);
      gl.deleteProgram(main.p);
      gl.deleteProgram(dots.p);
      release();
    },
  };
}
