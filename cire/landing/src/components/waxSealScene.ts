// The signature centrepiece: a real, three-dimensional wax seal that presents the
// page. It is deliberately AMBIENT — it never breaks. It rests in a fixed pose,
// catches a gold key light on its embossed monogram, and leans a little toward
// the pointer so it feels physical rather than printed; it never rotates on its
// own. The "reveal" is a gentle settle on load (a small dolly-back + fade-up). The seal itself
// is STAMPED, not moulded: each mount pours a fresh random puddle and presses
// the same circular die into it, so every visitor's seal is unique.
//
// This module is lazy-loaded (`import()`) by WaxSeal3D so Three.js stays off the
// critical path — the hero's headline and CTAs are server-rendered and painted
// long before this ever runs. If WebGL is unavailable WaxSeal3D never loads this
// file and its CSS poster stands in; reduced-motion visitors get the scene in
// `still` mode (one frame, no animation).
//
// Core `three` only — no examples/addons — to keep the added weight to the seal,
// not a scene-graph toolkit.
import {
  AmbientLight,
  CanvasTexture,
  DirectionalLight,
  Group,
  MathUtils,
  Mesh,
  MeshPhysicalMaterial,
  PerspectiveCamera,
  PointLight,
  Scene,
  SphereGeometry,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
} from "three";

export interface WaxSealController {
  /** Tear down the renderer, listeners and GPU resources. Idempotent. */
  destroy(): void;
}

export interface WaxSealOptions {
  /** Fired once the first frame has painted, so the caller can cross-fade in. */
  onReady?: () => void;
  /**
   * Render the seal as a still life: no settle animation, no pointer lean —
   * a single frame, re-rendered only on resize. The 3D seal is a better
   * PICTURE than the CSS poster even with all motion off, so reduced-motion
   * visitors get it too.
   */
  still?: boolean;
}

// Brand gold (matches --color-gold, oklch(74.99% 0.0854 82.08)) as the wax body.
const WAX_GOLD = 0xc9a86a;
const KEY_WARM = 0xffe6b0; // upper-left key — the light that carves the emboss
const FILL_FOREST = 0x2f5a44; // cool forest fill from below-right (brand bg family)
const RIM_GLOW = 0xf6d79a; // faint back rim so the wax edge separates from the page

interface SealMaps {
  bump: CanvasTexture;
  roughness: CanvasTexture;
}

/**
 * Paint what the die pressed into the wax. Two canvases from one drawing pass:
 *
 * - a BUMP map (height field: mid-grey surface, brighter raised) carrying the
 *   knocked-back well, the double border ring, the monogram, and hand-poured
 *   micro-texture;
 * - a ROUGHNESS map: the die burnishes what it touches, so the pressed design
 *   is left glossier (darker) than the surrounding cooled-wax field. This is
 *   what makes the monogram READ — it catches the key light as a distinct
 *   specular material, not just a faint slope change.
 *
 * The planar UV projection maps world x,y ∈ [-1,1] to uv [0,1], so a feature
 * meant for the stamped field (which ends near world radius 0.6) must be drawn
 * within ~0.3 of the canvas half-size. (A previous revision drew the border
 * ring at 0.41 — which landed it ON the rim ridge, mushing both.)
 */
function makeSealMaps(): SealMaps {
  const S = 512;
  const bumpCanvas = document.createElement("canvas");
  bumpCanvas.width = bumpCanvas.height = S;
  const b = bumpCanvas.getContext("2d")!;
  const roughCanvas = document.createElement("canvas");
  roughCanvas.width = roughCanvas.height = S;
  const g = roughCanvas.getContext("2d")!;
  const c = S / 2;

  // Base: even wax surface; medium roughness with a hair more in the well,
  // where the die's face pressed matte-cooled wax.
  b.fillStyle = "#808080";
  b.fillRect(0, 0, S, S);
  g.fillStyle = "#969696";
  g.fillRect(0, 0, S, S);

  // The knocked-back well the die pressed (design sits proud of this).
  b.beginPath();
  b.arc(c, c, S * 0.3, 0, Math.PI * 2);
  b.fillStyle = "#626262";
  b.fill();
  g.beginPath();
  g.arc(c, c, S * 0.3, 0, Math.PI * 2);
  g.fillStyle = "#a4a4a4";
  g.fill();

  // Hand-poured micro-texture: fine speckle so the body reads as cooled wax,
  // plus faint circular striations in the well — die drag marks. Fresh each
  // pour.
  for (let i = 0; i < 1400; i += 1) {
    const a = Math.random() * Math.PI * 2;
    const r = Math.sqrt(Math.random()) * S * 0.5;
    const v = 116 + Math.floor(Math.random() * 24) - 12;
    b.fillStyle = `rgb(${v} ${v} ${v})`;
    b.globalAlpha = 0.14;
    b.fillRect(c + Math.cos(a) * r, c + Math.sin(a) * r, 1.5, 1.5);
  }
  b.globalAlpha = 1;
  for (let i = 0; i < 5; i += 1) {
    const rr = S * (0.08 + Math.random() * 0.18);
    const start = Math.random() * Math.PI * 2;
    b.beginPath();
    b.arc(c, c, rr, start, start + 0.9 + Math.random() * 1.4);
    b.lineWidth = 1 + Math.random();
    b.strokeStyle = Math.random() < 0.5 ? "#606060" : "#727272";
    b.globalAlpha = 0.3;
    b.stroke();
  }
  b.globalAlpha = 1;

  // The die's design, raised from the field: a border ring, a laurel wreath
  // of leaves and berries circling the monogram (echoing the botanical dies
  // in the reference seals), and an italic serif "C" to match the brand face.
  // Every shape is drawn twice — bright on the bump map (raised), dark on the
  // roughness map (burnished glossy by the die).
  const drawDesign = (ctx: CanvasRenderingContext2D, style: string) => {
    ctx.fillStyle = style;
    ctx.strokeStyle = style;

    // Border ring just inside the stamped field.
    ctx.lineWidth = S * 0.016;
    ctx.beginPath();
    ctx.arc(c, c, S * 0.272, 0, Math.PI * 2);
    ctx.stroke();

    // Laurel wreath: a visible vine circle carrying opposed PAIRS of bold
    // leaves at each node (one leaning out, one leaning in), a berry dot at
    // every other node. Big enough to read as foliage at hero size — the
    // previous pass looked like scattered grains.
    const vineR = S * 0.206;
    ctx.lineWidth = S * 0.005;
    ctx.beginPath();
    ctx.arc(c, c, vineR, 0, Math.PI * 2);
    ctx.stroke();
    const leaf = (px: number, py: number, rot: number, len: number, wid: number) => {
      ctx.save();
      ctx.translate(px, py);
      ctx.rotate(rot);
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.quadraticCurveTo(len * 0.45, -wid, len, 0);
      ctx.quadraticCurveTo(len * 0.45, wid, 0, 0);
      ctx.fill();
      ctx.restore();
    };
    const nodes = 13;
    for (let i = 0; i < nodes; i += 1) {
      const a = (i / nodes) * Math.PI * 2;
      const px = c + Math.cos(a) * vineR;
      const py = c + Math.sin(a) * vineR;
      const march = a + Math.PI / 2; // tangential, all marching one way
      leaf(px, py, march - 0.75, S * 0.062, S * 0.017);
      leaf(px, py, march + 0.75, S * 0.062, S * 0.017);
      if (i % 2 === 0) {
        const bx = c + Math.cos(a + Math.PI / nodes) * vineR;
        const by = c + Math.sin(a + Math.PI / nodes) * vineR;
        ctx.beginPath();
        ctx.arc(bx, by, S * 0.0085, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // The monogram — italic, as on the CSS poster, so the two seals match.
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = `italic 700 ${S * 0.21}px Georgia, "Cormorant Garamond", serif`;
    // Optical centring — a cap "C" sits a touch high on the maths midline.
    ctx.fillText("C", c, c + S * 0.014);
  };
  drawDesign(b, "#f2f2f2");
  drawDesign(g, "#525252");

  const asTexture = (canvas: HTMLCanvasElement) => {
    // Height/roughness data, not colour — leave in the default linear space.
    const tex = new CanvasTexture(canvas);
    tex.anisotropy = 4;
    return tex;
  };
  return { bump: asTexture(bumpCanvas), roughness: asTexture(roughCanvas) };
}

/**
 * One pour of wax. Each mount rolls a fresh puddle — the shape the molten wax
 * spread into, and where it squeezed out from under the die. The die itself is
 * the same perfect circle every time; uniqueness comes from the wax, exactly
 * as it does on a real letter. So every visitor's seal is their own.
 */
interface WaxPour {
  /** Silhouette radius multiplier around the puddle boundary (~0.85–1.3). */
  spread(ang: number): number;
  /** Squeeze-out ridge amplitude factor around the die edge (~0.5–1.8). */
  squeeze(ang: number): number;
}

/** Shortest signed angular distance, so tongue falloffs wrap around ±π. */
function angDist(a: number, b: number): number {
  return Math.atan2(Math.sin(a - b), Math.cos(a - b));
}

function pourWax(): WaxPour {
  // Low-frequency harmonics — a hand-poured puddle is never a circle, but it
  // is CLOSE to one. Restraint here is what separates a seal from a cookie.
  const harmonics = Array.from({ length: 3 }, (_, i) => ({
    k: 2 + i * 2 + (Math.random() < 0.5 ? 1 : 0),
    amp: (0.028 / (i + 1)) * (0.6 + Math.random() * 0.8),
    phase: Math.random() * Math.PI * 2,
  }));
  // One or two tongues where wax escaped the press and ran a little further.
  const tongues = Array.from({ length: 1 + Math.floor(Math.random() * 2) }, () => ({
    at: Math.random() * Math.PI * 2,
    width: 0.35 + Math.random() * 0.3, // radians
    run: 0.045 + Math.random() * 0.055,
  }));
  // The gentlest ripple on the squeeze-out ridge. High frequency + high
  // amplitude reads as a crimped pie crust — keep it barely-there.
  const ripple = {
    k: 9 + Math.floor(Math.random() * 4),
    amp: 0.045,
    phase: Math.random() * Math.PI * 2,
  };

  const tongueAt = (ang: number) =>
    tongues.reduce((sum, t) => sum + t.run * Math.exp(-((angDist(ang, t.at) / t.width) ** 2)), 0);

  return {
    spread(ang) {
      let s = 1 + tongueAt(ang);
      for (const h of harmonics) s += h.amp * Math.sin(h.k * ang + h.phase);
      return s;
    },
    squeeze(ang) {
      // More wax escapes where the puddle ran further — the ridge swells and
      // the silhouette tongues line up, as conservation of wax demands.
      return 0.92 + tongueAt(ang) * 1.6 + ripple.amp * Math.sin(ripple.k * ang + ripple.phase);
    },
  };
}

/**
 * Build the seal the way a real one is made: pour an irregular puddle of wax,
 * then press a perfectly circular die into it. The stamped field stays round
 * because the die held it; everything outside — the squeeze-out ridge, the
 * flared silhouette, the thin run-out tongues — is the wax reacting to the
 * press, freshly randomised per pour. That contrast (round die, irregular wax)
 * is what makes it read as STAMPED rather than a moulded button. The embossed
 * monogram rides the pressed face via a planar UV projection.
 */
function makeSealMesh(maps: SealMaps): Mesh {
  const R = 1;
  const pour = pourWax();
  // 96×72 segments (~7k vertices) fully captures the low-frequency pour
  // deformation at the seal's on-screen size (≤ ~640 backing px); the fine
  // detail lives in the bump/roughness maps, not the mesh.
  const geo = new SphereGeometry(R, 96, 72);
  const pos = geo.attributes.position;
  const uv = geo.attributes.uv;
  const v = new Vector3();

  // The pressed profile, inside → out: a flat stamped FIELD (to ~0.55), a
  // shallow GROOVE where the die's shoulder cut (≈0.62), one smooth proud RIM
  // (crest ≈0.74), then the rounded run-off to the puddle edge.
  const FIELD_Z = 0.315; // field height — below the rim crest
  const RIM_R = 0.74;
  const RIM_W = 0.11;
  const RIM_H = 0.13;

  for (let i = 0; i < pos.count; i += 1) {
    v.fromBufferAttribute(pos, i);
    const ang = Math.atan2(v.y, v.x);
    // Radial position in DIE space — measured before any spreading, because
    // the die's press is a perfect circle regardless of where the wax went.
    const rr = Math.min(1, Math.hypot(v.x, v.y) / R);

    // Stamp, part 1 — the puddle: blend the poured silhouette in beyond the
    // rim, so the stamped field and rim stay circular while the outer wax
    // flares into its own one-off shape.
    const sp = pour.spread(ang);
    const flare = MathUtils.smoothstep(rr, 0.8, 1);
    const spread = 1 + flare * (sp - 1);
    v.x *= spread;
    v.y *= spread;

    // Squash the sphere along the view axis into a thick wax slab.
    v.z *= 0.42;

    if (v.z > 0) {
      // Stamp, part 2 — the press. Flatten the dome into the stamped field
      // (blending back to the rounded slab toward the edge)...
      const dome = v.z;
      const flat = 1 - MathUtils.smoothstep(rr, 0.6, 0.97);
      v.z = MathUtils.lerp(dome, FIELD_Z, flat);
      // ...cut the groove where the die's shoulder sat...
      v.z -= Math.exp(-(((rr - 0.62) / 0.07) ** 2)) * 0.04;
      // ...and pile the displaced wax into one smooth proud rim, swelling
      // gently where the silhouette grew tongues.
      v.z += Math.exp(-(((rr - RIM_R) / RIM_W) ** 2)) * RIM_H * pour.squeeze(ang);
      // Stamp, part 3 — wax that ran further ran thinner.
      const thin = Math.min(0.45, Math.max(0, (sp - 1) * 1.6));
      v.z *= 1 - MathUtils.smoothstep(rr, 0.85, 1) * thin;
    }

    pos.setXYZ(i, v.x, v.y, v.z);
    // Planar UV down the view axis so the monogram lands centred on the face
    // (a sphere's own UVs would pinch it into the pole).
    uv.setXY(i, v.x / (2 * R) + 0.5, v.y / (2 * R) + 0.5);
  }
  pos.needsUpdate = true;
  uv.needsUpdate = true;
  geo.computeVertexNormals();

  // Sealing-wax finish. Base roughness comes from the ROUGHNESS map — the die
  // burnished the design glossier than the cooled field — under a soft
  // clearcoat, so the monogram and rings catch the key light as distinct
  // specular shapes while the body stays waxy.
  const material = new MeshPhysicalMaterial({
    color: WAX_GOLD,
    metalness: 0.15,
    roughness: 1,
    roughnessMap: maps.roughness,
    clearcoat: 0.6,
    clearcoatRoughness: 0.3,
    reflectivity: 0.45,
    bumpMap: maps.bump,
    bumpScale: 1.6,
  });

  return new Mesh(geo, material);
}

export function mountWaxSeal(
  canvas: HTMLCanvasElement,
  options: WaxSealOptions = {},
): WaxSealController {
  const parent = canvas.parentElement ?? canvas;
  const size = () => ({
    w: parent.clientWidth || 320,
    h: parent.clientHeight || 320,
  });

  const renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = SRGBColorSpace;
  {
    const { w, h } = size();
    renderer.setSize(w, h, false);
  }

  const scene = new Scene();
  const camera = new PerspectiveCamera(34, 1, 0.1, 100);
  const setCamera = () => {
    const { w, h } = size();
    camera.aspect = w / Math.max(1, h);
    camera.updateProjectionMatrix();
  };
  camera.position.set(0, 0, 6);
  setCamera();

  // Lighting: a warm gold key carves the emboss from the upper-left; a cool
  // forest fill keeps the shadow side in brand; a faint back rim frees the edge.
  const key = new DirectionalLight(KEY_WARM, 2.75);
  key.position.set(-3, 3.4, 4);
  const fill = new DirectionalLight(FILL_FOREST, 0.9);
  fill.position.set(3, -2, 2);
  const rim = new PointLight(RIM_GLOW, 12, 20, 2);
  rim.position.set(0, 0.6, -3);
  const ambient = new AmbientLight(0x3a3320, 0.5);
  scene.add(key, fill, rim, ambient);

  const maps = makeSealMaps();
  const seal = makeSealMesh(maps);
  const group = new Group();
  group.add(seal);
  scene.add(group);

  // Resting pose: a small fixed tilt so the key light rakes the rim and the
  // emboss instead of hitting the face dead-on. The seal does NOT rotate on
  // its own — it sits, like a seal.
  const POSE_YAW = -0.14;
  const POSE_PITCH = 0.1;
  group.rotation.set(POSE_PITCH, POSE_YAW, 0);

  // Pointer parallax target (-1..1 within the viewport). Stored here, applied
  // (lerped) in the loop so pointermove itself stays cheap — it only nudges
  // the loop awake (see below: the loop sleeps once the lean has converged).
  let pointerX = 0;
  let pointerY = 0;
  let hasPointer = false;
  const onPointerMove = (e: PointerEvent) => {
    if (e.pointerType === "touch") return; // touch has no hover; nothing to lean at
    hasPointer = true;
    pointerX = (e.clientX / window.innerWidth) * 2 - 1;
    pointerY = (e.clientY / window.innerHeight) * 2 - 1;
    start(); // wake the loop if it went to sleep at steady state
  };
  // A still seal never leans — don't attach a window-lifetime listener whose
  // writes nothing would ever read.
  if (!options.still) window.addEventListener("pointermove", onPointerMove, { passive: true });

  const onResize = () => {
    const { w, h } = size();
    renderer.setSize(w, h, false); // re-allocates (and blanks) the buffer...
    setCamera();
    start(); // ...so always follow with a repaint, even in still mode / asleep
  };
  const ro = new ResizeObserver(onResize);
  ro.observe(parent);

  // Only run the loop while the seal is on screen and the tab is visible.
  let onScreen = true;
  const io = new IntersectionObserver(
    ([entry]) => {
      onScreen = entry.isIntersecting;
      if (onScreen) start();
    },
    { threshold: 0.01 },
  );
  io.observe(canvas);

  let t0 = 0; // stamped on the first animated frame, so compile time isn't "settle" time
  let lastT = 0;
  let raf = 0;
  let ready = false;

  const frame = () => {
    if (!onScreen || document.hidden) {
      raf = 0;
      return;
    }
    const now = performance.now();
    if (t0 === 0) t0 = now;
    const t = (now - t0) / 1000;
    const dt = Math.min(0.05, lastT === 0 ? 1 / 60 : t - lastT);
    lastT = t;

    // Pointer lean only, damped toward the stored target — the seal never
    // rotates on its own, it just tips a little toward the visitor's hand.
    // Time-based damping so the feel (and the sleep threshold below) is the
    // same at 60Hz and 120Hz.
    const targetYaw = POSE_YAW + (hasPointer ? pointerX * 0.24 : 0);
    const targetPitch = POSE_PITCH + (hasPointer ? pointerY * 0.16 : 0);
    const damp = 1 - Math.exp(-4 * dt);
    group.rotation.y += (targetYaw - group.rotation.y) * damp;
    group.rotation.x += (targetPitch - group.rotation.x) * damp;

    // Gentle load-in settle: a small dolly-back + scale ease over ~1.3s.
    const rin = MathUtils.clamp(t / 1.3, 0, 1);
    const eased = 1 - Math.pow(1 - rin, 3);
    camera.position.z = MathUtils.lerp(5.35, 6, eased);
    const s = MathUtils.lerp(1.08, 1, eased);
    group.scale.setScalar(s);

    renderer.render(scene, camera);

    if (!ready) {
      ready = true;
      options.onReady?.();
    }

    // Steady state: settle done and the lean has converged. The scene is now
    // pixel-static, so STOP — burning GPU on identical frames is pure battery
    // drain (on touch devices this sleeps ~1.3s after load and never wakes).
    // pointermove / resize / visibility / intersection all call start() to
    // wake the loop when something can actually change.
    const settled =
      rin >= 1 &&
      Math.abs(targetYaw - group.rotation.y) < 0.0004 &&
      Math.abs(targetPitch - group.rotation.x) < 0.0004;
    if (settled) {
      raf = 0;
      lastT = 0;
      return;
    }
    raf = requestAnimationFrame(frame);
  };

  // Still life: one frame in the resting pose, re-rendered only on demand
  // (resize, visibility). No settle, no lean, no animation loop.
  const renderStill = () => {
    camera.position.z = 6;
    renderer.render(scene, camera);
    if (!ready) {
      ready = true;
      options.onReady?.();
    }
  };

  // Nothing renders until the shaders are compiled (booted) — the first
  // renderer.render would otherwise compile MeshPhysicalMaterial's program
  // synchronously on the main thread (routinely 50-200ms on low-end
  // hardware). compileAsync uses KHR_parallel_shader_compile where available;
  // the poster simply stays up a beat longer.
  let booted = false;
  const start = () => {
    if (!booted) return;
    if (options.still) {
      renderStill();
      return;
    }
    if (raf === 0) raf = requestAnimationFrame(frame);
  };
  const onVisibility = () => {
    if (!document.hidden) start();
  };
  document.addEventListener("visibilitychange", onVisibility);
  let disposed = false;
  const boot = () => {
    if (disposed) return;
    booted = true;
    start();
  };
  renderer.compileAsync(scene, camera).then(boot, boot);

  return {
    destroy() {
      disposed = true;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      window.removeEventListener("pointermove", onPointerMove);
      document.removeEventListener("visibilitychange", onVisibility);
      ro.disconnect();
      io.disconnect();
      seal.geometry.dispose();
      (seal.material as MeshPhysicalMaterial).dispose();
      maps.bump.dispose();
      maps.roughness.dispose();
      renderer.dispose();
    },
  };
}
