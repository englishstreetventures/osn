/**
 * The card's face: a copy of the live hero, drawn into a WebGL texture with
 * the HTML-in-Canvas API.
 *
 * The copy is a clone of the hero's DOM put inside the scene's
 * `<canvas content="drawable">`. It is `inert` and `aria-hidden`, loses every
 * `id` and `data-*` hook (so nothing that queries the page finds it first),
 * and is sized to the viewport, clipped, so the texture is exactly what the
 * guest sees of the hero at scroll 0.
 *
 * Cross-origin pixels never paint into a canvas, and the hero's image comes
 * from cire-api's origin. So the clone's images, and any `background-image`
 * in it, point at the same-origin `blob:` copy `../hero` made of it.
 */

import { ExternalTexture, type WebGLRenderer } from "three";

import type { DrawableCanvas, ElementTextureContext } from "../html-in-canvas";

/** Marks the clone, so the head stylesheet holds its animations at their start, as it does the hero's. */
const CARD_ATTR = "data-envelope-card";

/** What the scene's size is, in CSS pixels and device pixels per CSS pixel. */
export interface Viewport {
  readonly width: number;
  readonly height: number;
  readonly dpr: number;
}

export interface Card {
  /** The texture the card mesh samples; its pixels change at each upload. */
  readonly texture: ExternalTexture;
  /** Resolves at the first upload, or when the card is disposed before it. */
  readonly firstUpload: Promise<void>;
  /** Clones the live hero again; resolves at the upload of that clone. */
  refresh(viewport: Viewport): Promise<void>;
  dispose(): void;
}

function cloneHero(hero: HTMLElement, blobUrl: string | null, viewport: Viewport): HTMLElement {
  const clone = hero.cloneNode(true) as HTMLElement;
  for (const el of [clone, ...clone.querySelectorAll<HTMLElement>("*")]) {
    el.removeAttribute("id");
    for (const name of el.getAttributeNames()) {
      if (name.startsWith("data-")) el.removeAttribute(name);
    }
  }
  clone.setAttribute("drawable", "");
  clone.setAttribute("inert", "");
  clone.setAttribute("aria-hidden", "true");
  clone.setAttribute(CARD_ATTR, "");
  Object.assign(clone.style, {
    width: `${viewport.width}px`,
    height: `${viewport.height}px`,
    minHeight: "0",
    overflow: "hidden",
  });
  if (blobUrl) {
    for (const img of clone.querySelectorAll("img")) {
      img.removeAttribute("srcset");
      img.src = blobUrl;
    }
    for (const el of clone.querySelectorAll<HTMLElement>("[style]")) {
      if (el.style.backgroundImage.includes("url(")) {
        el.style.backgroundImage = `url("${blobUrl}")`;
      }
    }
  }
  return clone;
}

/**
 * The texture's size in texels for `viewport`, within the GPU's limit: the
 * size of the canvas's drawing buffer, which three rounds down, so the last
 * frame samples one texel per pixel.
 */
function textureSize(viewport: Viewport, maxSize: number): [number, number] {
  return [
    Math.min(maxSize, Math.floor(viewport.width * viewport.dpr)),
    Math.min(maxSize, Math.floor(viewport.height * viewport.dpr)),
  ];
}

export function createCard(input: {
  readonly canvas: HTMLCanvasElement;
  readonly renderer: WebGLRenderer;
  /** The live hero, looked up at each clone. */
  readonly hero: () => HTMLElement | null;
  readonly blobUrl: string | null;
  readonly viewport: Viewport;
  /** Called after each upload, to draw a frame with it. */
  readonly onUpload: () => void;
}): Card {
  const { renderer, hero, blobUrl } = input;
  const canvas = input.canvas as DrawableCanvas;
  const gl = renderer.getContext() as ElementTextureContext;
  const maxSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
  const glTexture = gl.createTexture();
  if (!glTexture) throw new Error("envelope: no texture");
  const texture = new ExternalTexture(glTexture);

  let clone: HTMLElement | null = null;
  let allocated: [number, number] = [0, 0];
  let size: [number, number] = textureSize(input.viewport, maxSize);
  let waiting: Array<() => void> = [];
  let firstResolve: () => void = () => {};
  const firstUpload = new Promise<void>((resolve) => {
    firstResolve = resolve;
  });

  const upload = () => {
    if (!clone || !gl.texElementSubImage2D) return;
    gl.bindTexture(gl.TEXTURE_2D, glTexture);
    if (allocated[0] !== size[0] || allocated[1] !== size[1]) {
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA8,
        size[0],
        size[1],
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        null,
      );
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      allocated = size;
    }
    // Rows bottom-up, as three's plane UVs expect.
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texElementSubImage2D(gl.TEXTURE_2D, 0, 0, 0, clone, { width: size[0], height: size[1] });
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    // three caches GL state; it must not assume its own texture is still bound.
    renderer.resetState();
    firstResolve();
    const done = waiting;
    waiting = [];
    for (const resolve of done) resolve();
    input.onUpload();
  };

  canvas.onpaint = upload;

  const place = (viewport: Viewport) => {
    const source = hero();
    if (!source) return Promise.resolve();
    size = textureSize(viewport, maxSize);
    const next = cloneHero(source, blobUrl, viewport);
    if (clone) clone.replaceWith(next);
    else canvas.append(next);
    clone = next;
    const uploaded = new Promise<void>((resolve) => waiting.push(resolve));
    canvas.requestPaint?.();
    return uploaded;
  };

  void place(input.viewport);

  return {
    texture,
    firstUpload,
    refresh: place,
    dispose() {
      canvas.onpaint = null;
      clone?.remove();
      clone = null;
      // Nothing waits for a paint that will not come: the scene's `ready`
      // then finds itself disposed and rejects.
      firstResolve();
      for (const resolve of waiting) resolve();
      waiting = [];
      texture.dispose();
      gl.deleteTexture(glTexture);
    },
  };
}
