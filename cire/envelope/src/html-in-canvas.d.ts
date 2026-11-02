/**
 * The HTML-in-Canvas API (WICG `html-in-canvas`), as Chromium 156 behind
 * `CanvasDrawElement` and Chrome 157 by default expose it. TypeScript's DOM
 * library has none of it yet. Only the names this package calls are declared,
 * each optional, because a browser without the API is the common case and
 * every caller tests for the name first. A script file, not a module, so
 * these merge with the DOM library's global interfaces.
 *
 * - `<canvas content="drawable">` lays out its children; each child to draw
 *   carries the `drawable` attribute.
 * - `paint` fires after a drawable child changes, or once after
 *   `requestPaint()`. A texture upload is valid only inside it.
 * - `texElementSubImage2D` copies a drawable child's snapshot into a texture
 *   already allocated with `texImage2D`. `width` and `height` in the config
 *   are the size it is drawn at, in texels.
 */

interface HTMLCanvasElement {
  requestPaint?(): void;
  onpaint?: ((this: HTMLCanvasElement, event: Event) => void) | null;
}

interface WebGLCopyElementImageConfig {
  sx?: number;
  sy?: number;
  swidth?: number;
  sheight?: number;
  width?: number;
  height?: number;
}

interface WebGL2RenderingContext {
  texElementSubImage2D?(
    target: GLenum,
    level: GLint,
    xoffset: GLint,
    yoffset: GLint,
    element: Element,
    config?: WebGLCopyElementImageConfig,
  ): void;
}
