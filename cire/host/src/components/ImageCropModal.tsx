import Button from "@cire/ui/button";
import Eyebrow from "@cire/ui/eyebrow";
import { Modal } from "@shared/ui/ui/modal";
import { Notice } from "@shared/ui/ui/notice";
import Cropper from "cropperjs";
import type { CropperImage, CropperSelection } from "cropperjs";
import { createSignal, For, onCleanup, onMount, Show } from "solid-js";

import { haptic } from "../lib/haptics";
import {
  ASPECT_PRESETS,
  type AspectPresetId,
  type Box,
  boxWithinBounds,
  type CropSlot,
  fitAspectBox,
  type ImageCrop,
  presetAspectRatio,
  presetForCrop,
} from "../lib/image-crop";
/**
 * Drag/resize/zoom crop editor over an uploaded invite image, wrapping the
 * battle-tested vanilla Cropper.js (per the repo's "prefer existing libraries"
 * rule — we never hand-roll the crop interaction).
 *
 * Cropper.js v2 is a ground-up rewrite: instead of v1's single `new Cropper(img)`
 * imperative class it ships native Web Components (`<cropper-canvas>`,
 * `<cropper-image>`, `<cropper-selection>`, `<cropper-handle>`…). The default
 * `Cropper` wrapper class still takes the `<img>` element, but it now hides that
 * `<img>` and injects a `<cropper-canvas>` template beside it; we read the live
 * elements back via `getCropperImage()` / `getCropperSelection()`. There is no
 * separate `cropper.css` in v2 — every component styles itself inside its own
 * Shadow DOM — so the old `import "cropperjs/dist/cropper.css"` is gone.
 *
 * The organiser picks an aspect ratio from a small set of presets (Original /
 * 16:9 / 3:2 / 4:3 / 1:1 / 4:5 / Free); selecting one re-locks the crop selection
 * to that ratio. On save we capture the image's NATURAL pixel dimensions
 * alongside the normalised `{x,y,w,h}` rectangle, so the guest site can render the
 * crop at its true pixel aspect — UNIFORMLY scaled, never stretched (the
 * distortion fix).
 *
 * Lifecycle: on mount we attach Cropper to the `<img>` ref and hook the
 * selection's cancellable `change` event to keep the box INSIDE the displayed
 * image (v2 dropped v1's built-in containment — unconstrained, the box roams
 * the letterbox background and the out-of-image area clamps away on save).
 * That check runs on every pointer move of a drag, so it reads image bounds the
 * editor already holds and never measures the layout: they are worked out from
 * the image's natural size and transform matrix, and recomputed whenever the
 * image pans or zooms (its `transform` event) and when the window resizes.
 * Once cropperjs has sized and centred the image we seed the saved crop's box
 * (and its preset), or — with no saved crop — fit the box over the displayed
 * image, because v2's `initial-coverage` covers the canvas, not the image.
 * Save derives the crop rectangle from the live geometry — the displayed
 * `<cropper-image>` bounding box vs the `<cropper-selection>` bounding box give
 * the same 0..1 source fractions v1's `getData(true)` produced
 * (selection-over-image fractions are resolution-independent), and
 * `naturalWidth/Height` give `natW`/`natH`. Reset
 * clears back to the full-frame default (`crop: null`). Both delegate the network
 * call to the parent. On cleanup we remove every listener we added and
 * `destroy()` the cropper (removes the canvas, restores the `<img>`).
 */
export interface ImageCropModalProps {
  /** Absolute image URL to crop (already API-origin-prefixed). */
  imageUrl: string;
  slot: CropSlot;
  /** The currently-saved crop, shown as the initial box. Null ⇒ start full-frame. */
  initialCrop: ImageCrop | null;
  /** Persist a crop rectangle. Resolves to keep the modal open on failure. */
  onSave: (crop: ImageCrop) => Promise<void>;
  /** Reset to the full image (clears the stored crop). */
  onReset: () => Promise<void>;
  onClose: () => void;
}

/** Clamp a fraction into [0,1] — geometry can report a hair outside on edge drags. */
function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

export default function ImageCropModal(props: ImageCropModalProps) {
  let imgEl: HTMLImageElement | undefined;
  let cropper: Cropper | undefined;
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  // The active aspect preset. Re-opening restores the preset the saved crop was
  // made with (best-effort, from its captured dims); a fresh crop opens on the
  // slot's default preset ("Original").
  const [preset, setPreset] = createSignal<AspectPresetId>(
    presetForCrop(props.initialCrop, props.slot),
  );

  /** The live `<cropper-selection>`, or undefined before the cropper is built. */
  function selection(): CropperSelection | undefined {
    return cropper?.getCropperSelection() ?? undefined;
  }

  /** The live `<cropper-image>`, or undefined before the cropper is built. */
  function cropperImage(): CropperImage | undefined {
    return cropper?.getCropperImage() ?? undefined;
  }

  /**
   * The displayed image's box in `<cropper-canvas>` pixel space — the
   * coordinate space all selection geometry lives in — for `picture` under
   * `matrix`.
   *
   * Arithmetic only, no layout read. cropperjs lays `<cropper-image>` out at the
   * canvas origin at the picture's natural size and moves it only through its
   * transform matrix, applied about the image's centre. The template allows
   * scale and translate and nothing else, and every scale a wheel or a pinch
   * makes is positive, so the matrix is `[a, 0, 0, d, e, f]` with `a, d > 0`.
   * Undefined until the picture's natural size is known.
   */
  function imageBoxFor(picture: HTMLImageElement, matrix: readonly number[]): Box | undefined {
    const width = picture.naturalWidth;
    const height = picture.naturalHeight;
    if (width <= 0 || height <= 0) return undefined;
    const [a, , , d, e, f] = matrix;
    return {
      x: width / 2 + e - (a * width) / 2,
      y: height / 2 + f - (d * height) / 2,
      w: a * width,
      h: d * height,
    };
  }

  /**
   * The displayed image's box, as {@link imageBoxFor} last worked it out. The
   * containment veto runs on every pointer move of a drag and reads only this.
   * Recomputed once cropperjs has laid the image out, on every image
   * `transform` — the only way the image moves in canvas space — and on window
   * `resize`, which moves nothing in canvas space and costs a few
   * multiplications. An update that cannot work a box out keeps the last one.
   */
  let imageBounds: Box | undefined;

  // Rounding slack for the containment veto below — see `boxWithinBounds`.
  const EDGE_EPS = 1;

  /**
   * Veto any selection change that leaves the displayed image (Cropper v2's
   * `change` event is cancellable exactly for this). v1 constrained the crop box
   * to the image for us; v2's selection roams the whole canvas by default, which
   * let organisers drag/resize the box onto the letterbox background — regions
   * that don't exist in the source image and got silently clamped away on save.
   */
  function onSelectionChange(e: Event) {
    const detail = (e as CustomEvent<{ x: number; y: number; width: number; height: number }>)
      .detail;
    const bounds = imageBounds;
    if (!detail || !bounds) return;
    const box: Box = { x: detail.x, y: detail.y, w: detail.width, h: detail.height };
    if (!boxWithinBounds(box, bounds, EDGE_EPS)) {
      e.preventDefault();
    }
  }

  /**
   * Lock the selection to the given aspect ratio (NaN ⇒ unlocked / free) and
   * re-fit the box INSIDE the displayed image: the largest ratio-correct box
   * centred on the current selection, clamped to the image bounds. Fitting to
   * the image (not just re-snapping the top-left corner) matters twice over —
   * a corner-anchored resize can push the box past the image edge, where the
   * containment veto would reject it and the preset button would appear dead.
   */
  function applyAspectRatio(ratio: number) {
    const sel = selection();
    if (!sel) return;
    sel.aspectRatio = ratio;
    const bounds = imageBounds;
    if (Number.isFinite(ratio) && bounds) {
      const centreX = sel.width > 0 ? sel.x + sel.width / 2 : undefined;
      const centreY = sel.height > 0 ? sel.y + sel.height / 2 : undefined;
      const box = fitAspectBox(bounds, ratio, centreX, centreY);
      sel.$change(box.x, box.y, box.w, box.h, ratio, true);
    }
    sel.$render();
  }

  /**
   * Open the selection over the whole displayed image, honouring the active
   * aspect lock. This replaces `initial-coverage`'s canvas-covering default: a
   * letterboxed image (aspect ≠ canvas aspect) would otherwise start with the
   * box overflowing onto the background, and saving that clamps to the
   * degenerate full-frame rect — the "crop does nothing" bug.
   */
  function fitSelectionToImage(ratio: number) {
    const sel = selection();
    const bounds = imageBounds;
    if (!sel || !bounds) return;
    const box = Number.isFinite(ratio) ? fitAspectBox(bounds, ratio) : bounds;
    sel.$change(box.x, box.y, box.w, box.h, Number.NaN, true);
    sel.$render();
  }

  onMount(() => {
    const el = imgEl;
    if (!el) return;
    cropper = new Cropper(el, {
      // A custom template mirroring the v1 editor: the image pans/zooms inside the
      // canvas, a shaded overlay dims the un-selected area, and the selection box
      // is movable + resizable with corner/edge handles. No `initial-coverage` —
      // it would cover the CANVAS, not the image; `fitSelectionToImage` opens the
      // box over the displayed image once it's ready (v1's `autoCropArea: 1`).
      // No `rotatable`: a saved crop carries no rotation, and with it a pinch
      // tilts the image as it zooms, so the frame saved would not be the one
      // shown. Without it cropperjs turns a pinch into a plain zoom. The shade,
      // grid and crosshair only draw, so assistive technology is told nothing
      // about them; the grid carries no `role`, having no rows or cells.
      template: `<cropper-canvas background style="width:100%;height:100%">
        <cropper-image scalable translatable></cropper-image>
        <cropper-shade hidden aria-hidden="true"></cropper-shade>
        <cropper-handle action="select" plain></cropper-handle>
        <cropper-selection movable resizable outlined>
          <cropper-grid covered aria-hidden="true"></cropper-grid>
          <cropper-crosshair centered aria-hidden="true"></cropper-crosshair>
          <cropper-handle action="move" theme-color="rgba(255,255,255,0.35)"></cropper-handle>
          <cropper-handle action="n-resize"></cropper-handle>
          <cropper-handle action="e-resize"></cropper-handle>
          <cropper-handle action="s-resize"></cropper-handle>
          <cropper-handle action="w-resize"></cropper-handle>
          <cropper-handle action="ne-resize"></cropper-handle>
          <cropper-handle action="nw-resize"></cropper-handle>
          <cropper-handle action="se-resize"></cropper-handle>
          <cropper-handle action="sw-resize"></cropper-handle>
        </cropper-selection>
      </cropper-canvas>`,
    });

    const sel = selection();
    const img = cropperImage();
    if (sel) {
      sel.aspectRatio = presetAspectRatio(preset(), props.slot);
      sel.addEventListener("change", onSelectionChange);
      onCleanup(() => sel.removeEventListener("change", onSelectionChange));
    }
    if (!img) return;

    /** Recompute {@link imageBounds} from the matrix the image carries now. */
    const refreshImageBounds = () => {
      imageBounds = imageBoxFor(img.$image, img.$getTransform()) ?? imageBounds;
    };

    // cropperjs fires `transform` with the matrix it applies the moment the
    // event returns, and nothing in this editor cancels it, so the box is
    // current before the next selection change is checked against it.
    const onImageTransform = (e: Event) => {
      const { matrix } = (e as CustomEvent<{ matrix: number[] }>).detail;
      imageBounds = imageBoxFor(img.$image, matrix) ?? imageBounds;
    };

    // Position the box once cropperjs has sized and centred the image. Its own
    // `load` handler does that, and cropperjs added it when `<cropper-image>`
    // connected inside `new Cropper` above, so this one runs after it. Not
    // `$ready`: for a picture the browser already holds — the dashboard shows
    // this one first — it resolves before that handler has run, and the box
    // would open over a layout about to change. A saved crop re-opens on its
    // stored rect; otherwise open over the whole image (aspect-fitted),
    // replacing `initial-coverage`'s canvas-wide default.
    const openSelection = () => {
      refreshImageBounds();
      if (props.initialCrop) {
        seedInitialCrop();
      } else {
        fitSelectionToImage(presetAspectRatio(preset(), props.slot));
      }
    };
    img.$image.addEventListener("load", openSelection, { once: true });
    img.addEventListener("transform", onImageTransform);
    window.addEventListener("resize", refreshImageBounds);
    onCleanup(() => {
      window.removeEventListener("resize", refreshImageBounds);
      img.removeEventListener("transform", onImageTransform);
      img.$image.removeEventListener("load", openSelection);
    });
  });

  /**
   * Map the saved `{x,y,w,h}` source fractions onto the live selection. v2's
   * selection geometry is in `<cropper-canvas>` pixel space, so we project the
   * fractions through the displayed image's box ({@link imageBounds}, which
   * reflects the image's scale + position inside the canvas).
   */
  function seedInitialCrop() {
    const c = props.initialCrop;
    const sel = selection();
    const bounds = imageBounds;
    if (!c || !sel || !bounds) return;
    // Canvas-local coordinates of the saved crop region.
    const x = bounds.x + c.x * bounds.w;
    const y = bounds.y + c.y * bounds.h;
    const width = c.w * bounds.w;
    const height = c.h * bounds.h;
    // NaN ratio for this one change: restore EXACTLY the saved rect. Passing the
    // preset lock here would "cover"-adjust the box whenever the stored crop's
    // aspect differs even fractionally from the matched preset, silently growing
    // it past what was saved. The lock (sel.aspectRatio) still governs the
    // organiser's subsequent resizes.
    sel.$change(x, y, width, height, Number.NaN, true);
    sel.$render();
  }

  onCleanup(() => {
    cropper?.destroy();
    cropper = undefined;
  });

  /** Switch the locked aspect ratio of the crop box (Free ⇒ NaN ⇒ unlocked). */
  function choosePreset(id: AspectPresetId) {
    setPreset(id);
    // A shape change re-locks the crop box under the finger — a step, not a commit.
    haptic("step");
    applyAspectRatio(presetAspectRatio(id, props.slot));
  }

  async function handleSave() {
    const sel = selection();
    const img = cropperImage();
    const canvas = cropper?.getCropperCanvas();
    if (!sel || !img || !canvas) return;
    setError(null);
    const naturalW = img.$image.naturalWidth || 0;
    const naturalH = img.$image.naturalHeight || 0;
    if (naturalW <= 0 || naturalH <= 0) {
      setError("Could not read the image size — try re-uploading.");
      return;
    }
    // Derive 0..1 source fractions from the live geometry: the selection box over
    // the displayed image box. These fractions are resolution-independent, so they
    // equal the same fractions v1's `getData(true)` produced in source pixels.
    const imgRect = img.getBoundingClientRect();
    const selRect = sel.getBoundingClientRect();
    if (imgRect.width <= 0 || imgRect.height <= 0) {
      setError("Could not read the image size — try re-uploading.");
      return;
    }
    const crop: ImageCrop = {
      x: clamp01((selRect.left - imgRect.left) / imgRect.width),
      y: clamp01((selRect.top - imgRect.top) / imgRect.height),
      w: clamp01(selRect.width / imgRect.width),
      h: clamp01(selRect.height / imgRect.height),
      natW: naturalW,
      natH: naturalH,
    };
    // Guard the box against the bottom/right edge so x+w / y+h never exceed 1
    // (the server rejects that). Rounding can push it a hair over.
    if (crop.x + crop.w > 1) crop.w = 1 - crop.x;
    if (crop.y + crop.h > 1) crop.h = 1 - crop.y;
    setBusy(true);
    try {
      await props.onSave(crop);
      haptic("commit");
      props.onClose();
    } catch {
      haptic("reject");
      setError("Could not save the crop. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function handleReset() {
    setError(null);
    setBusy(true);
    try {
      await props.onReset();
      haptic("commit");
      props.onClose();
    } catch {
      haptic("reject");
      setError("Could not reset the crop. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    // Was a `fixed inset-0 z-50` scrim in a `<Portal>`, portalled because the
    // dashboard shell sets `container-type` on its layout boxes, which brings
    // `contain: layout` and makes them the containing block for `position:
    // fixed` descendants. A top-layer dialog is outside every stacking context,
    // so neither is needed — and it brings a focus trap and Escape, neither of
    // which this had.
    //
    // `open` is a literal, not a prop: all three call sites `lazy()` this
    // component behind a `<Show>`, because it drags `cropperjs` in with it.
    // Mounting it to keep an exit animation would defeat that, so this is the
    // one shape where unmounting the dialog is right and the exit is forgone.
    //
    // `dismissable` is reactive: a backdrop click must not throw away a crop
    // that is mid-save.
    <Modal
      open
      onClose={props.onClose}
      dismissable={!busy()}
      label="Crop image"
      class="flex max-h-[90vh] w-full max-w-2xl flex-col gap-4 overflow-auto"
    >
      <header class="flex flex-col gap-1">
        <Eyebrow>Crop</Eyebrow>
        <h3 class="font-display text-text text-ui-lg font-light">Choose what guests see</h3>
        <p class="font-body text-text-muted text-ui-sm">
          Drag to pan, drag a corner to zoom. Pick a shape below — guests see exactly this frame,
          never stretched.
        </p>
      </header>

      <Show when={error()}>
        <Notice tone="danger" alert>
          {error()}
        </Notice>
      </Show>

      {/* Aspect-ratio presets — one choice among several, so `choice` buttons:
            the active shape carries the accent border and ring. Selecting one
            re-locks the crop box. */}
      <div class="flex flex-col gap-1.5">
        <span class="font-body text-text-muted text-ui-xs tracking-ui-wider uppercase">Shape</span>
        <div role="group" aria-label="Crop aspect ratio" class="flex flex-wrap gap-1.5">
          <For each={ASPECT_PRESETS}>
            {(p) => (
              <Button
                variant="choice"
                size="sm"
                type="button"
                aria-pressed={preset() === p.id}
                disabled={busy()}
                onClick={() => choosePreset(p.id)}
              >
                {p.label}
              </Button>
            )}
          </For>
        </div>
      </div>

      {/* Bounded height so the cropper canvas fits the modal; Cropper.js v2 hides
            this `<img>` and injects a `<cropper-canvas>` sibling that fills the box.

            No `crossOrigin` here. The editor only reads geometry and
            `naturalWidth`/`naturalHeight` — never canvas pixels — so a no-cors
            image is all it needs, and Cropper.js copies `crossorigin` onto its
            own image only when this <img> carries it. A CORS-mode load would cost
            something: the dashboard thumbnail loads this exact URL as a plain
            (no-cors) <img> first, and the API sends `Vary: Accept, Origin`, so the
            browser cannot answer a CORS-mode request from that cached copy and
            fetches the image again on every switch of mode. An anonymous CORS
            load also sends no cookie, and the closing image is linked at the
            organiser image route, which answers 401 without the organiser
            session. */}
      <div class="bg-surface rounded-ui-field h-[55vh] overflow-hidden">
        <img
          ref={imgEl}
          src={props.imageUrl}
          alt="Region selected for the invite"
          class="block max-w-full"
        />
      </div>

      <div class="flex flex-wrap items-center justify-between gap-3">
        <Button variant="subtle" type="button" onClick={() => void handleReset()} disabled={busy()}>
          Reset to full image
        </Button>
        <div class="flex items-center gap-3">
          <Button
            variant="quiet"
            onClick={() => {
              haptic("dismiss");
              props.onClose();
            }}
            disabled={busy()}
          >
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void handleSave()} disabled={busy()}>
            {busy() ? "Saving…" : "Save crop"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
