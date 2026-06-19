import Cropper from "cropperjs";
import { createSignal, For, onCleanup, onMount, Show } from "solid-js";

import "cropperjs/dist/cropper.css";
import {
  ASPECT_PRESETS,
  type AspectPresetId,
  type CropSlot,
  type ImageCrop,
  presetAspectRatio,
  presetForCrop,
} from "../lib/image-crop";

/**
 * Drag/resize/zoom crop editor over an uploaded invite image, wrapping the
 * battle-tested vanilla Cropper.js (per the repo's "prefer existing libraries"
 * rule — we never hand-roll the crop interaction).
 *
 * The organiser picks an aspect ratio from a small set of presets (Original /
 * 16:9 / 3:2 / 4:3 / 1:1 / 4:5 / Free); selecting one re-locks the Cropper box to
 * that ratio. On save we capture the image's NATURAL pixel dimensions alongside
 * the normalised `{x,y,w,h}` rectangle, so the guest site can render the crop at
 * its true pixel aspect — UNIFORMLY scaled, never stretched (the distortion fix).
 *
 * Lifecycle: on mount we attach Cropper to the `<img>` ref, opening on the saved
 * crop's preset (or the slot default); when ready we seed the saved box.
 * Save reads `getData(true)` (the crop in source pixels) + `naturalWidth/Height`
 * and normalises to 0..1 fractions + `natW`/`natH`; Reset clears back to the
 * full-frame default (`crop: null`). Both delegate the network call to the parent.
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

/** Clamp a fraction into [0,1] — Cropper can report a hair outside on edge drags. */
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

  onMount(() => {
    const el = imgEl;
    if (!el) return;
    cropper = new Cropper(el, {
      aspectRatio: presetAspectRatio(preset(), props.slot),
      viewMode: 1, // crop box stays within the image bounds
      autoCropArea: 1, // default selection covers the whole image
      dragMode: "move", // drag the image to pan; the box resizes for zoom
      background: false,
      responsive: true,
      checkOrientation: false,
      ready() {
        const c = props.initialCrop;
        if (!c || !cropper) return;
        // Seed the saved box. Cropper works in source-image coordinates, so map
        // the stored fractions back to pixels against the natural dimensions.
        const data = cropper.getImageData();
        const naturalW = data.naturalWidth || 0;
        const naturalH = data.naturalHeight || 0;
        if (naturalW > 0 && naturalH > 0) {
          cropper.setData({
            x: c.x * naturalW,
            y: c.y * naturalH,
            width: c.w * naturalW,
            height: c.h * naturalH,
          });
        }
      },
    });
  });

  onCleanup(() => {
    cropper?.destroy();
    cropper = undefined;
  });

  /** Switch the locked aspect ratio of the crop box (Free ⇒ NaN ⇒ unlocked). */
  function choosePreset(id: AspectPresetId) {
    setPreset(id);
    cropper?.setAspectRatio(presetAspectRatio(id, props.slot));
  }

  async function handleSave() {
    if (!cropper) return;
    setError(null);
    const img = cropper.getImageData();
    const naturalW = img.naturalWidth || 0;
    const naturalH = img.naturalHeight || 0;
    if (naturalW <= 0 || naturalH <= 0) {
      setError("Could not read the image size — try re-uploading.");
      return;
    }
    // `getData(true)` rounds to whole source pixels; normalise to fractions and
    // capture the natural dims so the guest render honours the chosen aspect.
    const d = cropper.getData(true);
    const crop: ImageCrop = {
      x: clamp01(d.x / naturalW),
      y: clamp01(d.y / naturalH),
      w: clamp01(d.width / naturalW),
      h: clamp01(d.height / naturalH),
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

        {/* Bounded height so the cropper canvas fits the modal; Cropper.js sizes
            the image to this box. */}
        <div class="bg-surface max-h-[55vh] overflow-hidden rounded-sm">
          <img
            ref={imgEl}
            src={props.imageUrl}
            alt="Region selected for the invite"
            crossOrigin="anonymous"
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
