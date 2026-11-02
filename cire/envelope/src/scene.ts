/**
 * The opening: a full-screen overlay holding a WebGL scene of a sealed
 * envelope whose card is the invite's own hero, drawn live with the
 * HTML-in-Canvas API.
 *
 * The overlay is a `<div data-envelope-overlay>` appended to the host (the
 * page's `<body>`), so no transformed ancestor can trap it. Inside it, the
 * `<canvas content="drawable">` holds the hero's clone and draws the scene, and
 * one `<button>` covering the screen takes every tap, click, Enter and Space;
 * its text, "Open your invitation", is its name and is the prompt that fades in
 * when the guest has not tapped for a few seconds.
 *
 * The opening ends on a frame that is the hero exactly: a viewport-sized plane
 * at z = 0, the camera at `fitDistance`, the texture at device-pixel size, and
 * colour management off so each texel reaches the screen unchanged. The page
 * underneath is then uncovered and the overlay fades out over a picture
 * identical to it.
 *
 * This module touches none of the page's `<html>` attributes; the invite's
 * mount script owns them. It reports through promises instead: {@link
 * EnvelopeScene.ready}, then {@link EnvelopeScene.landed}.
 */

import {
  AmbientLight,
  ColorManagement,
  DirectionalLight,
  LinearSRGBColorSpace,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  WebGLRenderer,
} from "three";

import { haptic } from "./haptics";
import { cssVar, displayFont } from "./hero";
import type { BreakStyle } from "./index";
import { type Card, createCard, type Viewport } from "./scene/card";
import {
  buildEnvelope,
  type EnvelopeLayout,
  envelopeLayout,
  type EnvelopeModel,
  LAYER,
} from "./scene/envelope";
import { fitDistance, nextRate } from "./scene/math";
import { CARD_PAPER } from "./scene/paint";
import {
  BREAK_S,
  clamp01,
  easeInCubic,
  easeInOutCubic,
  FILL_S,
  FLAP_S,
  LAND_WAIT_MS,
  lerp,
  MAX_FRAME_S,
  OPENING_DEADLINE_MS,
  type Phase,
  PROMPT_DELAY_MS,
  SLIDE_S,
} from "./scene/timeline";
import { buildSeal, type Seal } from "./seal";

/** The overlay's marker attribute; the head stylesheet styles it. */
export const OVERLAY_ATTR = "data-envelope-overlay";

/** The button's name and the idle prompt's words. */
export const OPEN_LABEL = "Open your invitation";

const FOV = 35;
/** Device pixels per CSS pixel, at most: a texture past it costs memory no screen shows. */
const MAX_DPR = 3;
/** How wide the card's paper edge is while it is in the envelope, in CSS pixels. */
const CARD_EDGE = 5;

export interface EnvelopeSceneOptions {
  /** The live hero the card is drawn from, looked up again when the card is redrawn. */
  readonly hero: () => HTMLElement | null;
  /**
   * The hero image as a same-origin URL (`prepareCard` in `./hero`), or
   * `null` for a card without the photo. The caller owns it and revokes it
   * once the scene is disposed.
   */
  readonly blobUrl: string | null;
  /** Where the overlay goes: the page's `<body>`. */
  readonly host: HTMLElement;
  readonly breakStyle: BreakStyle;
}

export interface EnvelopeScene {
  readonly overlay: HTMLElement;
  /**
   * Resolves once the envelope, with the card's first upload in it, is drawn.
   * Until {@link reveal} the overlay is painted (the clone must be, to be
   * uploaded) but takes no taps and holds no focus. Rejects when the scene
   * cannot be built.
   */
  readonly ready: Promise<void>;
  /** Shows the overlay and gives its button focus. */
  reveal(): void;
  /** Lets taps open the envelope, and starts the idle prompt's timer. */
  arm(): void;
  /** Resolves on the final frame, the hero exactly. Rejects if the opening breaks. */
  readonly landed: Promise<void>;
  /** Fades the overlay out and removes it. */
  leave(): Promise<void>;
  dispose(): void;
}

export function createEnvelopeScene(options: EnvelopeSceneOptions): EnvelopeScene {
  const doc = options.host.ownerDocument;
  const win = doc.defaultView;
  if (!win) throw new Error("envelope: no window");

  const overlay = doc.createElement("div");
  overlay.setAttribute(OVERLAY_ATTR, "");
  overlay.dataset["state"] = "loading";
  overlay.dataset["phase"] = "sealed";
  const canvas = doc.createElement("canvas");
  canvas.setAttribute("content", "drawable");
  const button = doc.createElement("button");
  button.type = "button";
  const prompt = doc.createElement("span");
  prompt.setAttribute("data-envelope-prompt", "");
  prompt.textContent = OPEN_LABEL;
  button.append(prompt);
  overlay.append(canvas, button);
  options.host.append(overlay);

  let renderer: WebGLRenderer | null = null;
  let card: Card | null = null;
  let envelope: EnvelopeModel | null = null;
  let seal: Seal | null = null;
  let layout: EnvelopeLayout | null = null;
  const scene = new Scene();
  const camera = new PerspectiveCamera(FOV, 1, 1, 10_000);
  // Every material in the scene is `transparent`, so three draws them all in
  // one list ordered by `renderOrder` (it draws opaque materials first,
  // whatever their order). At opacity 1 a transparent material writes its
  // texel unchanged, so the card's last frame is still the hero exactly.
  const cardEdge = new Mesh(
    new PlaneGeometry(1, 1),
    new MeshBasicMaterial({
      color: CARD_PAPER,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    }),
  );
  const cardFace = new Mesh(
    new PlaneGeometry(1, 1),
    new MeshBasicMaterial({
      transparent: true,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    }),
  );
  scene.add(cardEdge, cardFace);
  const ambient = new AmbientLight(0xffffff, 1.1);
  const key = new DirectionalLight(0xffffff, 2.4);
  key.position.set(-0.45, 0.7, 1);
  scene.add(ambient, key);

  let viewport: Viewport = { width: 1, height: 1, dpr: 1 };
  let phase: Phase = "sealed";
  let phaseTime = 0;
  let rate = 1;
  let armed = false;
  let released = false;
  let fresh = true;
  let landWaitFrom = -1;
  let lastFrame = -1;
  let loop = 0;
  let drawRequest = 0;
  let promptTimer = 0;
  let deadline = 0;
  let disposed = false;

  let resolveLanded: () => void = () => {};
  let rejectLanded: (error: unknown) => void = () => {};
  const landed = new Promise<void>((resolve, reject) => {
    resolveLanded = resolve;
    rejectLanded = reject;
  });
  // Observed by the mount once it has revealed the scene; a failure before
  // then is reported through `ready` instead.
  landed.catch(() => {});

  const measure = (): Viewport => {
    const rect = overlay.getBoundingClientRect();
    return {
      width: Math.max(1, rect.width),
      height: Math.max(1, rect.height),
      dpr: Math.min(MAX_DPR, win.devicePixelRatio || 1),
    };
  };

  const fitCamera = () => {
    camera.aspect = viewport.width / viewport.height;
    const distance = fitDistance(viewport.height, FOV);
    camera.position.set(0, 0, distance);
    camera.near = Math.max(1, distance / 10);
    camera.far = distance * 4;
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
  };

  /** Builds the envelope and seal for the current viewport, replacing any built before. */
  const buildPaper = () => {
    envelope?.group.removeFromParent();
    envelope?.dispose();
    seal?.dispose();
    layout = envelopeLayout(viewport.width, viewport.height);
    envelope = buildEnvelope(
      layout,
      {
        // A step lighter than the page, so the open liner reads against it.
        ground: cssVar(doc, "--color-surface-raised", cssVar(doc, "--color-bg", "#14261b")),
        ink: cssVar(doc, "--color-gold", "#c9a86a"),
      },
      Math.min(2, viewport.dpr),
    );
    seal = buildSeal({
      radius: layout.sealRadius,
      flap: envelope.flap,
      layers: { closed: LAYER.SEAL, open: LAYER.SEAL_ON_OPEN_FLAP },
      font: displayFont(doc),
    });
    seal.group.position.set(0, layout.sealY, 1);
    envelope.group.add(seal.group);
    scene.add(envelope.group);
  };

  /** Places everything for `phase` at `progress` (0-1 through it). */
  const pose = () => {
    if (!layout || !envelope || !seal) return;
    const { width: W, height: H } = viewport;
    const p = (duration: number) => clamp01(phaseTime / duration);
    const afterFlap = phase === "slide" || phase === "fill" || phase === "done";
    const flapAngle =
      phase === "flap" ? Math.PI * easeInOutCubic(p(FLAP_S)) : afterFlap ? Math.PI : 0;
    envelope.setFlap(flapAngle);

    const lift =
      phase === "slide" ? easeInOutCubic(p(SLIDE_S)) : phase === "fill" || phase === "done" ? 1 : 0;
    const fill = phase === "fill" ? easeInOutCubic(p(FILL_S)) : phase === "done" ? 1 : 0;

    // The envelope drops away and fades as the card comes forward.
    envelope.group.position.set(0, layout.centreY - H * 0.55 * easeInCubic(fill), 0);
    const paper = 1 - clamp01(fill / 0.6);
    envelope.setOpacity(paper);
    seal.setOpacity(paper);

    // The card: a window onto the hero, full width, its height growing with
    // the card until the plane is the viewport and the window the whole hero.
    const restY = layout.centreY + lerp(layout.cardRestY, layout.cardLiftY, lift);
    const cw = lerp(layout.cardWidth, W, fill);
    const ch = lerp(layout.cardHeight, H, fill);
    const windowHeight = Math.min(1, (ch * W) / cw / H);
    const tex = cardFace.material.map;
    if (tex) {
      tex.repeat.set(1, windowHeight);
      tex.offset.set(0, (1 - windowHeight) / 2);
    }
    const bump = Math.sin(Math.PI * fill);
    const x = 0;
    const y = lerp(restY, 0, fill);
    const z = phase === "done" ? 0 : lerp(-1, 0, fill) + 30 * bump;
    const tilt = phase === "done" ? 0 : -0.2 * bump;
    cardFace.position.set(x, y, z);
    cardFace.rotation.set(tilt, 0, 0);
    cardFace.scale.set(cw, ch, 1);
    const edge = phase === "done" ? 0 : CARD_EDGE * (1 - fill);
    cardEdge.position.set(x, y, z);
    cardEdge.rotation.set(tilt, 0, 0);
    cardEdge.scale.set(cw + 2 * edge, ch + 2 * edge, 1);
    cardEdge.visible = edge > 0.01;
    const lifted = fill > 0;
    cardEdge.renderOrder = lifted ? LAYER.CARD_LIFTED_EDGE : LAYER.CARD_EDGE;
    cardFace.renderOrder = lifted ? LAYER.CARD_LIFTED : LAYER.CARD;
  };

  const draw = () => {
    if (!renderer || disposed) return;
    pose();
    renderer.render(scene, camera);
  };

  const requestDraw = () => {
    if (loop || drawRequest || disposed) return;
    drawRequest = win.requestAnimationFrame(() => {
      drawRequest = 0;
      draw();
    });
  };

  const enter = (next: Phase) => {
    phase = next;
    overlay.dataset["phase"] = next;
    if (next === "slide" && card) {
      // The hero may have changed since the first clone (a returning
      // household's title, say); the card lands on the hero as it is now.
      fresh = false;
      const refreshing = card.refresh(viewport);
      void (async () => {
        await refreshing;
        fresh = true;
      })();
    }
  };

  const advance = (dt: number, now: number) => {
    seal?.update(dt);
    phaseTime += dt;
    if (phase === "breaking" && phaseTime >= BREAK_S && released) {
      phaseTime -= BREAK_S;
      enter("flap");
    }
    if (phase === "flap" && phaseTime >= FLAP_S) {
      phaseTime -= FLAP_S;
      enter("slide");
    }
    if (phase === "slide" && phaseTime >= SLIDE_S) {
      phaseTime -= SLIDE_S;
      enter("fill");
    }
    if (phase === "fill" && phaseTime >= FILL_S) {
      if (landWaitFrom < 0) landWaitFrom = now;
      if (fresh || now - landWaitFrom >= LAND_WAIT_MS) {
        phaseTime = 0;
        enter("done");
      }
    }
  };

  const frame = (now: number) => {
    loop = 0;
    if (disposed) return;
    try {
      const dt = lastFrame < 0 ? 0 : Math.min(MAX_FRAME_S, (now - lastFrame) / 1000);
      lastFrame = now;
      advance(dt * rate, now);
      draw();
      if (phase === "done") {
        win.clearTimeout(deadline);
        resolveLanded();
        return;
      }
      loop = win.requestAnimationFrame(frame);
    } catch (error) {
      rejectLanded(error);
    }
  };

  const start = () => {
    // Bounded: a seal that never lets go, or frames that never come, end in
    // the page as it is rather than in a guest stuck behind the overlay.
    deadline = win.setTimeout(() => {
      if (phase !== "done") rejectLanded(new Error("envelope: the opening did not land"));
    }, OPENING_DEADLINE_MS);
    phaseTime = 0;
    enter("breaking");
    delete overlay.dataset["prompt"];
    win.clearTimeout(promptTimer);
    const breaking = seal?.break(options.breakStyle);
    void (async () => {
      await breaking;
      released = true;
    })();
    if (drawRequest) win.cancelAnimationFrame(drawRequest);
    drawRequest = 0;
    loop = win.requestAnimationFrame(frame);
  };

  button.addEventListener("click", () => {
    if (!armed || disposed || overlay.dataset["state"] !== "shown") return;
    if (phase === "sealed") {
      // Inside the tap's own handler: Chrome allows a vibration only here.
      haptic("open");
      start();
    } else if (phase !== "done") {
      rate = nextRate(rate);
    }
  });

  // A lost context (Android drops them for backgrounded tabs) draws nothing
  // again; the page underneath is shown instead.
  canvas.addEventListener("webglcontextlost", () => {
    rejectLanded(new Error("envelope: WebGL context lost"));
  });

  const onFocusIn = (event: FocusEvent) => {
    if (phase !== "sealed" || overlay.dataset["state"] !== "shown") return;
    const target = event.target;
    if (!(target instanceof Node) || overlay.contains(target)) return;
    // The consent prompt and its preferences are modal dialogs in the top
    // layer; focus inside them is theirs.
    if (target instanceof Element && target.closest("dialog[open]")) return;
    button.focus({ preventScroll: true });
  };
  doc.addEventListener("focusin", onFocusIn);

  const onResize = () => {
    if (disposed || !renderer || phase === "done") return;
    const next = measure();
    if (
      next.width === viewport.width &&
      next.height === viewport.height &&
      next.dpr === viewport.dpr
    ) {
      return;
    }
    viewport = next;
    renderer.setPixelRatio(viewport.dpr);
    renderer.setSize(viewport.width, viewport.height, false);
    fitCamera();
    if (phase === "sealed") buildPaper();
    void card?.refresh(viewport);
    requestDraw();
  };
  win.addEventListener("resize", onResize);

  const ready = (async () => {
    if (!options.hero()) throw new Error("envelope: no hero");
    // Already loaded by `prepareCard`; the seal's letter is drawn in it.
    await doc.fonts?.load(`600 100px ${displayFont(doc)}`).catch(() => []);
    if (disposed) throw new Error("envelope: disposed");

    viewport = measure();
    ColorManagement.enabled = false;
    // Multisampling only where a pixel is big enough for its edges to show:
    // at 2x and above they are already sub-pixel, and the buffers it adds
    // are several times the drawing buffer's size.
    renderer = new WebGLRenderer({ canvas, alpha: true, antialias: viewport.dpr < 2 });
    renderer.outputColorSpace = LinearSRGBColorSpace;
    renderer.setClearColor(0x000000, 0);
    renderer.setPixelRatio(viewport.dpr);
    renderer.setSize(viewport.width, viewport.height, false);
    fitCamera();
    buildPaper();
    card = createCard({
      canvas,
      renderer,
      hero: options.hero,
      blobUrl: options.blobUrl,
      viewport,
      onUpload: draw,
    });
    cardFace.material.map = card.texture;
    cardFace.material.needsUpdate = true;
    await card.firstUpload;
    if (disposed) throw new Error("envelope: disposed");
    draw();
  })();

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    if (loop) win.cancelAnimationFrame(loop);
    if (drawRequest) win.cancelAnimationFrame(drawRequest);
    win.clearTimeout(promptTimer);
    win.clearTimeout(deadline);
    doc.removeEventListener("focusin", onFocusIn);
    win.removeEventListener("resize", onResize);
    card?.dispose();
    seal?.dispose();
    envelope?.dispose();
    cardEdge.geometry.dispose();
    cardEdge.material.dispose();
    cardFace.geometry.dispose();
    cardFace.material.dispose();
    // `dispose` frees three's programs and textures, not the context and its
    // drawing buffer; those would wait for the detached canvas to be collected.
    const lost = renderer?.getContext().isContextLost() ?? true;
    renderer?.dispose();
    if (!lost) renderer?.forceContextLoss();
    overlay.remove();
    rejectLanded(new Error("envelope: disposed"));
  };

  return {
    overlay,
    ready,
    landed,
    reveal() {
      overlay.dataset["state"] = "shown";
      button.focus({ preventScroll: true });
    },
    arm() {
      if (armed || disposed) return;
      armed = true;
      overlay.dataset["armed"] = "";
      button.focus({ preventScroll: true });
      if (phase === "sealed") {
        promptTimer = win.setTimeout(() => {
          if (phase === "sealed") overlay.dataset["prompt"] = "";
        }, PROMPT_DELAY_MS);
      }
    },
    leave() {
      return new Promise<void>((resolve) => {
        let finished = false;
        const finish = () => {
          if (finished) return;
          finished = true;
          dispose();
          resolve();
        };
        overlay.addEventListener("transitionend", finish, { once: true });
        win.setTimeout(finish, 400);
        overlay.dataset["state"] = "leaving";
      });
    },
    dispose,
  };
}
