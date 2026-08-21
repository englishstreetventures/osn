import { onCleanup, onMount } from "solid-js";
import {
  CanvasTexture,
  Color,
  PerspectiveCamera,
  Scene,
  SRGBColorSpace,
  Texture,
  WebGLRenderer,
  type Material,
  type Mesh,
} from "three";
import { CSS3DObject, CSS3DRenderer } from "three/examples/jsm/renderers/CSS3DRenderer.js";

export { CSS3DObject };

export interface FrameInfo {
  /** Seconds since the first frame. */
  elapsed: number;
  /** Seconds since the previous frame, clamped — a backgrounded tab must not
   * hand the story a half-second step that teleports everything. */
  delta: number;
  width: number;
  height: number;
}

export interface ThreeContext {
  renderer: WebGLRenderer;
  scene: Scene;
  camera: PerspectiveCamera;
  canvas: HTMLCanvasElement;
  /**
   * A DOM layer rendered in the same 3D space as the WebGL scene — real,
   * interactive HTML transformed by the same camera. Only present when the
   * story asks for `css3d`. Add `CSS3DObject`s to it.
   */
  css3dScene?: Scene;
  onFrame: (fn: (info: FrameInfo) => void) => void;
  onResize: (fn: (width: number, height: number) => void) => void;
  /** Anything the story allocates that the default teardown will not find. */
  onDispose: (fn: () => void) => void;
}

export interface ThreeCanvasProps {
  /**
   * Runs once, after the renderer exists and has been sized. Register frame
   * and resize work through the context rather than starting your own loop —
   * the lab stops the loop when the story unmounts.
   */
  setup: (ctx: ThreeContext) => void;
  class?: string;
  /** Transparent clear so the lab background shows through. Default false. */
  alpha?: boolean;
  /** Clear colour when `alpha` is false. Default `#0b0b0c`. */
  background?: string;
  /** Adds a `CSS3DRenderer` layer on top of the canvas. Default false. */
  css3d?: boolean;
  /** Device-pixel-ratio ceiling. Default 2 — a 3x phone render is rarely worth it. */
  maxDpr?: number;
}

/**
 * Frees the GPU-side memory a scene holds: geometries, materials, and the
 * textures those materials point at.
 *
 * `Material.dispose()` does not touch its own textures, and a texture is the
 * expensive upload — a remount that leaves them behind grows GPU memory every
 * cycle, which in this tool means every save. Only the standard map slots are
 * walked; a texture a story keeps somewhere else is that story's to free in
 * `onDispose`.
 */
/**
 * The texture slots a standard three.js material can carry. Not every material
 * has every one — `MeshBasicMaterial` has no `roughnessMap` — so they are all
 * optional and the read is a plain property access.
 */
interface TexturedMaterial {
  map?: Texture | null;
  alphaMap?: Texture | null;
  aoMap?: Texture | null;
  bumpMap?: Texture | null;
  displacementMap?: Texture | null;
  emissiveMap?: Texture | null;
  envMap?: Texture | null;
  lightMap?: Texture | null;
  metalnessMap?: Texture | null;
  normalMap?: Texture | null;
  roughnessMap?: Texture | null;
  specularMap?: Texture | null;
}

function disposeMaterial(material: Material) {
  const textured = material as Material & TexturedMaterial;
  const textures = [
    textured.map,
    textured.alphaMap,
    textured.aoMap,
    textured.bumpMap,
    textured.displacementMap,
    textured.emissiveMap,
    textured.envMap,
    textured.lightMap,
    textured.metalnessMap,
    textured.normalMap,
    textured.roughnessMap,
    textured.specularMap,
  ];
  // A slot can hold the same texture twice (map and emissiveMap, say).
  // `dispose()` on an already-disposed texture is a no-op in three.js, so a
  // second call costs nothing.
  for (const texture of textures) texture?.dispose();
  material.dispose();
}

function disposeScene(scene: Scene) {
  scene.traverse((object) => {
    const mesh = object as Mesh;
    mesh.geometry?.dispose?.();
    const material = mesh.material as Material | Material[] | undefined;
    if (Array.isArray(material)) material.forEach(disposeMaterial);
    else if (material) disposeMaterial(material);
  });
  scene.clear();
}

/**
 * A three.js canvas that sizes itself to its parent, runs a frame loop and
 * tears everything down on unmount. Hot reload replaces the whole component,
 * so a story never accumulates renderers.
 */
export function ThreeCanvas(props: ThreeCanvasProps) {
  let host!: HTMLDivElement;

  onMount(() => {
    const renderer = new WebGLRenderer({ antialias: true, alpha: props.alpha ?? false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, props.maxDpr ?? 2));
    renderer.outputColorSpace = SRGBColorSpace;
    if (!props.alpha) renderer.setClearColor(new Color(props.background ?? "#0b0b0c"), 1);
    renderer.domElement.style.display = "block";
    host.append(renderer.domElement);

    const scene = new Scene();
    const camera = new PerspectiveCamera(50, 1, 0.1, 1000);
    camera.position.set(0, 0, 5);

    let css3dRenderer: CSS3DRenderer | undefined;
    let css3dScene: Scene | undefined;
    if (props.css3d) {
      css3dScene = new Scene();
      css3dRenderer = new CSS3DRenderer();
      const layer = css3dRenderer.domElement;
      layer.style.position = "absolute";
      layer.style.inset = "0";
      // The WebGL canvas underneath still needs to receive pointer events;
      // individual CSS3D elements re-enable them for themselves.
      layer.style.pointerEvents = "none";
      host.append(layer);
    }

    const frameFns: ((info: FrameInfo) => void)[] = [];
    const resizeFns: ((width: number, height: number) => void)[] = [];
    const disposeFns: (() => void)[] = [];

    let width = 0;
    let height = 0;

    const resize = () => {
      const rect = host.getBoundingClientRect();
      width = Math.max(1, Math.round(rect.width));
      height = Math.max(1, Math.round(rect.height));
      renderer.setSize(width, height, false);
      renderer.domElement.style.width = "100%";
      renderer.domElement.style.height = "100%";
      css3dRenderer?.setSize(width, height);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      for (const fn of resizeFns) fn(width, height);
    };

    const observer = new ResizeObserver(resize);
    observer.observe(host);
    resize();

    props.setup({
      renderer,
      scene,
      camera,
      canvas: renderer.domElement,
      css3dScene,
      onFrame: (fn) => frameFns.push(fn),
      onResize: (fn) => {
        resizeFns.push(fn);
        fn(width, height);
      },
      onDispose: (fn) => disposeFns.push(fn),
    });

    let last = performance.now();
    let elapsed = 0;
    renderer.setAnimationLoop((now) => {
      // 100ms ceiling: a tab that was hidden for a minute resumes as a normal
      // frame instead of one enormous integration step.
      const delta = Math.min((now - last) / 1000, 0.1);
      last = now;
      elapsed += delta;
      for (const fn of frameFns) fn({ elapsed, delta, width, height });
      renderer.render(scene, camera);
      if (css3dRenderer && css3dScene) css3dRenderer.render(css3dScene, camera);
    });

    onCleanup(() => {
      renderer.setAnimationLoop(null);
      observer.disconnect();
      for (const fn of disposeFns) fn();
      disposeScene(scene);
      if (css3dScene) disposeScene(css3dScene);
      renderer.dispose();
      // `dispose()` frees programs and buffers but keeps the GL context, which
      // then lives until the detached canvas is collected. A browser allows
      // only about sixteen at once and drops the oldest to make room — and the
      // oldest may be the story on screen. Remount and hot reload both land
      // here, so this path runs far more often than in an app.
      renderer.forceContextLoss();
      renderer.domElement.remove();
      css3dRenderer?.domElement.remove();
    });
  });

  return <div ref={host} class={props.class ?? "relative size-full"} />;
}

export interface Canvas2DContext {
  ctx: CanvasRenderingContext2D;
  canvas: HTMLCanvasElement;
  onFrame: (fn: (info: FrameInfo) => void) => void;
  onResize: (fn: (width: number, height: number) => void) => void;
  onDispose: (fn: () => void) => void;
}

export interface Canvas2DProps {
  setup: (ctx: Canvas2DContext) => void;
  class?: string;
  maxDpr?: number;
}

/**
 * The same deal for a plain 2D context: CSS-pixel coordinates (the transform
 * is pre-scaled by the device ratio), auto-resize, one frame loop, clean
 * teardown.
 */
export function Canvas2D(props: Canvas2DProps) {
  let host!: HTMLDivElement;

  onMount(() => {
    const canvas = document.createElement("canvas");
    canvas.style.display = "block";
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    host.append(canvas);

    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2D canvas context unavailable");

    const frameFns: ((info: FrameInfo) => void)[] = [];
    const resizeFns: ((width: number, height: number) => void)[] = [];
    const disposeFns: (() => void)[] = [];

    let width = 0;
    let height = 0;

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio, props.maxDpr ?? 2);
      const rect = host.getBoundingClientRect();
      width = Math.max(1, Math.round(rect.width));
      height = Math.max(1, Math.round(rect.height));
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      // setTransform, not scale — resize runs repeatedly and scale compounds.
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      for (const fn of resizeFns) fn(width, height);
    };

    const observer = new ResizeObserver(resize);
    observer.observe(host);
    resize();

    props.setup({
      ctx,
      canvas,
      onFrame: (fn) => frameFns.push(fn),
      onResize: (fn) => {
        resizeFns.push(fn);
        fn(width, height);
      },
      onDispose: (fn) => disposeFns.push(fn),
    });

    let raf = 0;
    let last = performance.now();
    let elapsed = 0;
    const tick = (now: number) => {
      const delta = Math.min((now - last) / 1000, 0.1);
      last = now;
      elapsed += delta;
      for (const fn of frameFns) fn({ elapsed, delta, width, height });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    onCleanup(() => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      for (const fn of disposeFns) fn();
      canvas.remove();
    });
  });

  return <div ref={host} class={props.class ?? "relative size-full"} />;
}

export interface HtmlRasterOptions {
  width: number;
  height: number;
  /** CSS applied inside the SVG. Web fonts do not load here — see the note below. */
  css?: string;
  /** Multiplier on the raster size. 2 keeps text crisp on a texture. */
  scale?: number;
}

/**
 * Rasterises an HTML string by wrapping it in an SVG `foreignObject` and
 * decoding that as an image.
 *
 * Two limits are inherent to the technique, not to this helper:
 *   - Nothing external loads. No web fonts, no `<img src="https://…">`, no
 *     stylesheet from the page. Inline what you need, or embed it as a
 *     `data:` URI, or the browser silently drops it.
 *   - The markup must be well-formed XHTML — every tag closed, every
 *     attribute quoted. An unclosed `<br>` fails the whole parse.
 */
export function htmlToImage(html: string, options: HtmlRasterOptions): Promise<HTMLImageElement> {
  const scale = options.scale ?? 2;
  const width = Math.round(options.width * scale);
  const height = Math.round(options.height * scale);
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${options.width} ${options.height}">`,
    options.css ? `<style>${options.css}</style>` : "",
    `<foreignObject width="100%" height="100%">`,
    `<div xmlns="http://www.w3.org/1999/xhtml">${html}</div>`,
    `</foreignObject></svg>`,
  ].join("");

  const image = new Image();
  // encodeURIComponent, not btoa — btoa throws on any non-Latin-1 character,
  // which includes every emoji and curly quote a real design uses.
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  return image.decode().then(() => image);
}

/** `htmlToImage`, drawn onto a canvas you can read pixels from. */
export async function htmlToCanvas(
  html: string,
  options: HtmlRasterOptions,
): Promise<HTMLCanvasElement> {
  const image = await htmlToImage(html, options);
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas context unavailable");
  ctx.drawImage(image, 0, 0);
  return canvas;
}

/** `htmlToCanvas`, wrapped as a three.js texture ready to hand to a material. */
export async function htmlToTexture(
  html: string,
  options: HtmlRasterOptions,
): Promise<CanvasTexture> {
  const texture = new CanvasTexture(await htmlToCanvas(html, options));
  texture.colorSpace = SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}
