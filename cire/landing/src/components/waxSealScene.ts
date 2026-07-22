// The signature centrepiece: a real, three-dimensional wax seal that presents the
// page. It is deliberately AMBIENT — it never breaks. It rests, breathes with a
// slow tilt, catches a gold key light on its embossed monogram, and leans toward
// the pointer so it feels physical rather than printed. The "reveal" is a gentle
// settle on load (a small dolly-back + fade-up), not a shatter.
//
// This module is lazy-loaded (`import()`) by WaxSeal3D so Three.js stays off the
// critical path — the hero's headline and CTAs are server-rendered and painted
// long before this ever runs. If WebGL is unavailable, or the visitor prefers
// reduced motion, WaxSeal3D never loads this file at all and the CSS seal it
// renders underneath stands in as a static poster.
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
}

// Brand gold (matches --color-gold, oklch(74.99% 0.0854 82.08)) as the wax body.
const WAX_GOLD = 0xc9a86a;
const KEY_WARM = 0xffe6b0; // upper-left key — the light that carves the emboss
const FILL_FOREST = 0x2f5a44; // cool forest fill from below-right (brand bg family)
const RIM_GLOW = 0xf6d79a; // faint back rim so the wax edge separates from the page

/**
 * Paint the monogram + border ring the seal-press leaves in the wax, as a height
 * field for the bump map: mid-grey is the wax surface, brighter is raised. A real
 * seal press leaves the design PROUD of a knocked-back field, so the ring and the
 * "C" are drawn lighter than their surround.
 */
function makeEmbossTexture(): CanvasTexture {
  const S = 512;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = S;
  const ctx = canvas.getContext("2d")!;
  const c = S / 2;

  // Flat wax field. The macro doming + raised rim now come from the geometry, so
  // the bump map only carries the fine press detail (border ring + monogram) on
  // top of an even surface.
  ctx.fillStyle = "#808080";
  ctx.fillRect(0, 0, S, S);

  // The knocked-back inner well the stamp presses (design sits proud of this).
  ctx.beginPath();
  ctx.arc(c, c, S * 0.4, 0, Math.PI * 2);
  ctx.fillStyle = "#6b6b6b";
  ctx.fill();

  // Raised decorative border ring near the rim.
  ctx.lineWidth = S * 0.03;
  ctx.strokeStyle = "#d8d8d8";
  ctx.beginPath();
  ctx.arc(c, c, S * 0.41, 0, Math.PI * 2);
  ctx.stroke();
  // A finer companion ring inside it — the double-rule a die usually carries.
  ctx.lineWidth = S * 0.008;
  ctx.strokeStyle = "#c4c4c4";
  ctx.beginPath();
  ctx.arc(c, c, S * 0.35, 0, Math.PI * 2);
  ctx.stroke();

  // The monogram, raised and centred. Serif to echo the Cormorant display face.
  ctx.fillStyle = "#efefef";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `700 ${S * 0.5}px Georgia, "Cormorant Garamond", serif`;
  // Optical centring — a cap "C" sits a touch high on the maths midline.
  ctx.fillText("C", c, c + S * 0.03);

  const tex = new CanvasTexture(canvas);
  // A bump map is height data, not colour — leave it in the default linear space
  // (tagging it sRGB would wrongly gamma-decode the heights).
  tex.anisotropy = 4;
  return tex;
}

/**
 * Build the wax blob. A sphere squashed along the view axis into a thick lens
 * with rounded, lobed edges (not a flat coin), plus a raised rounded rim on the
 * front — the pool of wax bulging where the stamp pressed it out. The real
 * curvature is what earns the highlights and shadows a flat disc can't. The
 * embossed monogram rides the domed face via a planar UV projection.
 */
function makeSealMesh(emboss: CanvasTexture): Mesh {
  const R = 1;
  const geo = new SphereGeometry(R, 160, 120);
  const pos = geo.attributes.position;
  const uv = geo.attributes.uv;
  const v = new Vector3();

  for (let i = 0; i < pos.count; i += 1) {
    v.fromBufferAttribute(pos, i);
    const ang = Math.atan2(v.y, v.x);
    // Gentle low-frequency lobing so the silhouette is hand-poured, not a circle.
    const wob = 1 + Math.sin(ang * 5) * 0.028 + Math.sin(ang * 9 + 1.3) * 0.018;
    v.x *= wob;
    v.y *= wob;
    // Squash the sphere along the view axis into a thick blob (rounded rim).
    v.z *= 0.42;
    // Raised rounded rim on the front face — a gaussian ridge near the edge.
    if (v.z > 0) {
      const rr = Math.min(1, Math.hypot(v.x, v.y) / R);
      v.z += Math.exp(-(((rr - 0.8) / 0.16) ** 2)) * 0.12;
    }
    pos.setXYZ(i, v.x, v.y, v.z);
    // Planar UV down the view axis so the monogram lands centred on the dome
    // (a sphere's own UVs would pinch it into the pole).
    uv.setXY(i, v.x / (2 * R) + 0.5, v.y / (2 * R) + 0.5);
  }
  pos.needsUpdate = true;
  uv.needsUpdate = true;
  geo.computeVertexNormals();

  const material = new MeshPhysicalMaterial({
    color: WAX_GOLD,
    metalness: 0.15,
    roughness: 0.44,
    clearcoat: 0.7,
    clearcoatRoughness: 0.3,
    reflectivity: 0.42,
    bumpMap: emboss,
    bumpScale: 0.5,
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
  const key = new DirectionalLight(KEY_WARM, 2.5);
  key.position.set(-3, 3.4, 4);
  const fill = new DirectionalLight(FILL_FOREST, 0.7);
  fill.position.set(3, -2, 2);
  const rim = new PointLight(RIM_GLOW, 12, 20, 2);
  rim.position.set(0, 0.6, -3);
  const ambient = new AmbientLight(0x3a3320, 0.5);
  scene.add(key, fill, rim, ambient);

  const emboss = makeEmbossTexture();
  const seal = makeSealMesh(emboss);
  const group = new Group();
  group.add(seal);
  scene.add(group);

  // Pointer parallax target (-1..1 within the viewport). Stored here, applied
  // (lerped) in the loop so pointermove never triggers a render itself.
  let pointerX = 0;
  let pointerY = 0;
  let hasPointer = false;
  const onPointerMove = (e: PointerEvent) => {
    if (e.pointerType === "touch") return; // touch has no hover; leave it to idle
    hasPointer = true;
    pointerX = (e.clientX / window.innerWidth) * 2 - 1;
    pointerY = (e.clientY / window.innerHeight) * 2 - 1;
  };
  window.addEventListener("pointermove", onPointerMove, { passive: true });

  const onResize = () => {
    const { w, h } = size();
    renderer.setSize(w, h, false);
    setCamera();
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

  const t0 = performance.now();
  let raf = 0;
  let ready = false;

  const frame = () => {
    if (!onScreen || document.hidden) {
      raf = 0;
      return;
    }
    const t = (performance.now() - t0) / 1000;

    // Idle breath — a slow tilt that always keeps the face to camera.
    const idleYaw = Math.sin(t * 0.45) * 0.26;
    const idlePitch = Math.sin(t * 0.32) * 0.06;
    // Pointer lean, damped toward the stored target.
    const targetYaw = idleYaw + (hasPointer ? pointerX * 0.35 : 0);
    const targetPitch = idlePitch + (hasPointer ? pointerY * 0.22 : 0);
    group.rotation.y += (targetYaw - group.rotation.y) * 0.06;
    group.rotation.x += (targetPitch - group.rotation.x) * 0.06;

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
    raf = requestAnimationFrame(frame);
  };

  const start = () => {
    if (raf === 0) raf = requestAnimationFrame(frame);
  };
  const onVisibility = () => {
    if (!document.hidden) start();
  };
  document.addEventListener("visibilitychange", onVisibility);
  start();

  return {
    destroy() {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      window.removeEventListener("pointermove", onPointerMove);
      document.removeEventListener("visibilitychange", onVisibility);
      ro.disconnect();
      io.disconnect();
      seal.geometry.dispose();
      (seal.material as MeshPhysicalMaterial).dispose();
      emboss.dispose();
      renderer.dispose();
    },
  };
}
