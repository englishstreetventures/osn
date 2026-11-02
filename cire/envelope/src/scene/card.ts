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
 * from cire-api's origin. So the image is fetched once more in CORS mode
 * (cire-api allows the invite's origin) and turned into a `blob:` URL, which
 * is same-origin; the clone's `<img>` and every crop layer's
 * `background-image` point at it.
 */

import { ExternalTexture, type WebGLRenderer } from "three";

const IMAGE_ACCEPT = "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8";

/** Marks the clone, so the head stylesheet holds its animations at their start, as it does the hero's. */
export const CARD_ATTR = "data-envelope-card";

/** What the scene's size is, in CSS pixels and device pixels per CSS pixel. */
export interface Viewport {
  readonly width: number;
  readonly height: number;
  readonly dpr: number;
}

export interface Card {
  /** The texture the card mesh samples; its pixels change at each upload. */
  readonly texture: ExternalTexture;
  /** Resolves at the first upload. */
  readonly firstUpload: Promise<void>;
  /** Clones the live hero again; resolves at the upload of that clone. */
  refresh(viewport: Viewport): Promise<void>;
  dispose(): void;
}

/**
 * The hero image's URL as a same-origin `blob:` URL, or `null` when the hero
 * shows no image (none set, or it failed to load, which drops it from the
 * hero too). Throws when the image is there but cannot be fetched: a card
 * without the photo would jump at the hand-over, so the opening does not play.
 */
export async function heroImageBlobUrl(hero: HTMLElement): Promise<string | null> {
  const img = hero.querySelector("img");
  const src = img?.currentSrc || img?.getAttribute("src");
  if (!src) return null;
  // The `Accept` Chrome sends for an `<img>`, so cire-api negotiates the same
  // format the page's hero got and the card's pixels are the hero's. A
  // CORS-safelisted header: no preflight.
  const response = await fetch(src, {
    mode: "cors",
    credentials: "omit",
    headers: { Accept: IMAGE_ACCEPT },
  });
  if (!response.ok) throw new Error(`envelope: hero image ${response.status}`);
  return URL.createObjectURL(await response.blob());
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
export function textureSize(viewport: Viewport, maxSize: number): [number, number] {
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
  const { canvas, renderer, hero, blobUrl } = input;
  const gl = renderer.getContext() as WebGL2RenderingContext;
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
      for (const resolve of waiting) resolve();
      waiting = [];
      texture.dispose();
      gl.deleteTexture(glTexture);
    },
  };
}
