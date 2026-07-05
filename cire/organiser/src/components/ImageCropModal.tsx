import Cropper from "cropperjs";
import type { CropperImage, CropperSelection } from "cropperjs";
import { createSignal, For, onCleanup, onMount, Show } from "solid-js";

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
 * Once the image is ready we seed the saved crop's box (and its preset), or —
 * with no saved crop — fit the box over the displayed image, because v2's
 * `initial-coverage` covers the canvas, not the image. Save derives the crop
 * rectangle from the live geometry — the displayed `<cropper-image>` bounding box
 * vs the `<cropper-selection>` bounding box give the same 0..1 source fractions
 * v1's `getData(true)` produced (selection-over-image fractions are
 * resolution-independent), and `naturalWidth/Height` give `natW`/`natH`. Reset
 * clears back to the full-frame default (`crop: null`). Both delegate the network
 * call to the parent. On cleanup we `destroy()` the cropper (removes the canvas,
 * restores the `<img>`).
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
   * The displayed image's rect in `<cropper-canvas>` pixel space — the
   * coordinate space all selection geometry lives in. Undefined before the
   * cropper is live or the image has laid out.
   */
  function imageBounds(): Box | undefined {
    const img = cropperImage();
    const canvas = cropper?.getCropperCanvas();
    if (!img || !canvas) return undefined;
    const imgRect = img.getBoundingClientRect();
    const canvasRect = canvas.getBoundingClientRect();
    if (imgRect.width <= 0 || imgRect.height <= 0) return undefined;
    return {
      x: imgRect.left - canvasRect.left,
      y: imgRect.top - canvasRect.top,
      w: imgRect.width,
      h: imgRect.height,
    };
  }

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
    const bounds = imageBounds();
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
    const bounds = imageBounds();
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
    const bounds = imageBounds();
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
      template: `<cropper-canvas background style="width:100%;height:100%">
        <cropper-image rotatable scalable translatable></cropper-image>
        <cropper-shade hidden></cropper-shade>
        <cropper-handle action="select" plain></cropper-handle>
        <cropper-selection movable resizable outlined>
          <cropper-grid role="grid" covered></cropper-grid>
          <cropper-crosshair centered></cropper-crosshair>
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
    }
    // Position the box once the image has loaded — its layout + transform are
    // applied before `$ready` callbacks run, so geometry reads are safe here.
    // A saved crop re-opens on its stored rect; otherwise open over the whole
    // image (aspect-fitted), replacing `initial-coverage`'s canvas-wide default.
    img?.$ready(() => {
      if (props.initialCrop) {
        seedInitialCrop();
      } else {
        fitSelectionToImage(presetAspectRatio(preset(), props.slot));
      }
    });
  });

  /**
   * Map the saved `{x,y,w,h}` source fractions onto the live selection. v2's
   * selection geometry is in `<cropper-canvas>` pixel space, so we project the
   * fractions through the displayed `<cropper-image>` bounding box (which already
   * reflects the image's scale + position inside the canvas).
   */
  function seedInitialCrop() {
    const c = props.initialCrop;
    const sel = selection();
    const img = cropperImage();
    const canvas = cropper?.getCropperCanvas();
    if (!c || !sel || !img || !canvas) return;
    const imgRect = img.getBoundingClientRect();
    const canvasRect = canvas.getBoundingClientRect();
    if (imgRect.width <= 0 || imgRect.height <= 0) return;
    // Canvas-local coordinates of the saved crop region.
    const x = imgRect.left - canvasRect.left + c.x * imgRect.width;
    const y = imgRect.top - canvasRect.top + c.y * imgRect.height;
    const width = c.w * imgRect.width;
    const height = c.h * imgRect.height;
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
      props.onClose();
    } catch {
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
      props.onClose();
    } catch {
      setError("Could not reset the crop. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Crop image"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy()) props.onClose();
      }}
    >
      <div class="border-border bg-bg flex max-h-[90vh] w-full max-w-2xl flex-col gap-4 overflow-auto rounded-sm border p-5">
        <header class="flex flex-col gap-1">
          <p class="font-body text-gold text-[0.72rem] tracking-[0.2em] uppercase">Crop</p>
          <h3 class="font-display text-text text-[1.3rem] font-light italic">
            Choose what guests see
          </h3>
          <p class="font-body text-text-muted text-[0.82rem]">
            Drag to pan, drag a corner to zoom. Pick a shape below — guests see exactly this frame,
            never stretched.
          </p>
        </header>

        <Show when={error()}>
          <p class="border-error/20 bg-error/5 text-error rounded-sm border p-3 text-[0.82rem]">
            {error()}
          </p>
        </Show>

        {/* Aspect-ratio presets — a segmented control. The active shape is filled
            gold; the rest are quiet outlines. Selecting one re-locks the crop box. */}
        <div class="flex flex-col gap-1.5">
          <span class="font-body text-text-muted text-[0.72rem] tracking-[0.1em] uppercase">
            Shape
          </span>
          <div role="group" aria-label="Crop aspect ratio" class="flex flex-wrap gap-1.5">
            <For each={ASPECT_PRESETS}>
              {(p) => (
                <button
                  type="button"
                  aria-pressed={preset() === p.id}
                  disabled={busy()}
                  onClick={() => choosePreset(p.id)}
                  class="font-body rounded-sm border px-3 py-1.5 text-[0.72rem] tracking-[0.1em] uppercase transition disabled:opacity-40"
                  classList={{
                    "border-gold bg-gold text-bg": preset() === p.id,
                    "border-border text-text-muted hover:border-gold hover:text-gold bg-transparent":
                      preset() !== p.id,
                  }}
                >
                  {p.label}
                </button>
              )}
            </For>
          </div>
        </div>

        {/* Bounded height so the cropper canvas fits the modal; Cropper.js v2 hides
            this `<img>` and injects a `<cropper-canvas>` sibling that fills the box.

            MUST NOT set `crossOrigin` here. The dashboard thumbnail loads this exact
            URL as a plain (no-cors) <img> first, and the API serves it with
            `Cache-Control: immutable` and no `Vary: Origin` — so the browser caches
            the response WITHOUT CORS headers. A crossorigin load of the same URL is
            then answered from that cache entry and hard-fails the CORS check: the
            cropper's image never becomes ready and the editor opens dead (verified
            in Chromium against cropperjs 2.1.1). The editor only reads geometry and
            `naturalWidth`/`naturalHeight` — never canvas pixels — so a non-CORS
            image is fully sufficient. */}
        <div class="bg-surface h-[55vh] overflow-hidden rounded-sm">
          <img
            ref={imgEl}
            src={props.imageUrl}
            alt="Region selected for the invite"
            class="block max-w-full"
          />
        </div>

        <div class="flex flex-wrap items-center justify-between gap-3">
          <button
            type="button"
            onClick={() => void handleReset()}
            disabled={busy()}
            class="font-body text-text-muted hover:text-gold text-[0.82rem] underline-offset-4 hover:underline disabled:opacity-40"
          >
            Reset to full image
          </button>
          <div class="flex items-center gap-3">
            <button
              type="button"
              onClick={() => props.onClose()}
              disabled={busy()}
              class="border-border font-body text-text-muted rounded-sm border bg-transparent px-4 py-2 text-[0.82rem] tracking-[0.1em] uppercase transition disabled:opacity-40"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void handleSave()}
              disabled={busy()}
              class="border-gold bg-gold font-body text-bg hover:bg-gold-dim rounded-sm border px-4 py-2 text-[0.82rem] tracking-[0.1em] uppercase transition disabled:opacity-40"
            >
              {busy() ? "Saving…" : "Save crop"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
