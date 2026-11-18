/**
 * The HTML-in-Canvas API (WICG `html-in-canvas`), as Chromium 156 behind
 * `CanvasDrawElement`, and Chrome under an origin trial, expose it. TypeScript's DOM
 * library has none of it yet. Only the names this package calls are declared,
 * each optional, because a browser without the API is the common case and
 * every caller tests for the name first. Types a caller casts to, not global
 * augmentations, so every program that loads this package's source (the
 * guest site's included) sees them through the import.
 *
 * - `<canvas content="drawable">` lays out its children; each child to draw
 *   carries the `drawable` attribute.
 * - `paint` fires after a drawable child changes, or once after
 *   `requestPaint()`. A texture upload is valid only inside it.
 * - `texElementSubImage2D` copies a drawable child's snapshot into a texture
 *   already allocated with `texImage2D`. `width` and `height` in the config
 *   are the size it is drawn at, in texels.
 */

/** A canvas whose drawable children can be drawn into its context. */
export interface DrawableCanvas extends HTMLCanvasElement {
  requestPaint?(): void;
  onpaint: ((this: HTMLCanvasElement, event: Event) => void) | null;
}

/** The source rectangle and drawn size of one element upload. */
export interface CopyElementImageConfig {
  sx?: number;
  sy?: number;
  swidth?: number;
  sheight?: number;
  width?: number;
  height?: number;
}

/** A WebGL2 context that can upload a drawable element into a texture. */
export interface ElementTextureContext extends WebGL2RenderingContext {
  texElementSubImage2D?(
    target: GLenum,
    level: GLint,
    xoffset: GLint,
    yoffset: GLint,
    element: Element,
    config?: CopyElementImageConfig,
  ): void;
}
