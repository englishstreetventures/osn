/**
 * Per-slot image control: upload, crop (desktop + optional phone rectangle),
 * remove, and a WYSIWYG cropped thumbnail. Image operations bypass the save
 * bar and hit the live invite immediately — the `InstantBadge` says so, and
 * an upload/remove failure surfaces HERE (`error` prop), next to the control
 * that caused it, not in the distant save bar.
 */

import { createSignal, lazy, Show, Suspense } from "solid-js";

import { apiUrl } from "../../lib/api";
import { haptic } from "../../lib/haptics";
import {
  CROP_ASPECT,
  cropAspectRatio,
  cropBackgroundStyle,
  type CropSlot,
  type ImageCrop,
} from "../../lib/image-crop";
import Button from "../ui/Button";
import Notice from "../ui/Notice";
import { InstantBadge } from "./fields";

const ImageCropModal = lazy(() => import("../ImageCropModal"));

export default function ImageField(props: {
  label: string;
  slot: CropSlot;
  url: string | null;
  crop: ImageCrop | null;
  /** The hero's phone rectangle (0046). Pass it (with `onSaveCropMobile`) to
   *  offer a second, phone-targeted crop of the same image. */
  cropMobile?: ImageCrop | null;
  /** The last upload/remove failure for THIS slot, shown inline. */
  error?: string | null;
  onSelect: (file: File) => void;
  onRemove: () => void;
  onSaveCrop: (crop: ImageCrop | null) => Promise<void>;
  onSaveCropMobile?: (crop: ImageCrop | null) => Promise<void>;
}) {
  // Which crop editor is open: the slot's main (desktop) rectangle, the phone
  // one, or neither. The two editors crop the SAME uploaded image — the phone
  // one just opens on a tall 9:16 frame and saves to the mobile rectangle.
  const [cropping, setCropping] = createSignal<"desktop" | "mobile" | null>(null);
  const hasMobileCrop = () => props.onSaveCropMobile !== undefined;
  // Absolute, cache-busted image URL for the thumbnail + the cropper. The crop
  // editor works against the ORIGINAL (full) image so the organiser can re-frame
  // freely, so it always loads the unmodified `src`.
  const absoluteUrl = (): string | null => (props.url ? apiUrl(props.url) : null);
  // WYSIWYG thumbnail: when a crop is saved, render the cropped region with the
  // same background-image fraction technique the guest site uses, so the preview
  // matches the invite. With no crop, fall back to the plain object-cover image.
  const cropStyle = () => {
    const url = absoluteUrl();
    return url ? cropBackgroundStyle(url, props.crop) : null;
  };
  // Phone thumbnail — the tall rectangle guests see below the desktop
  // breakpoint. Only rendered when a phone crop is actually saved.
  const cropMobileStyle = () => {
    const url = absoluteUrl();
    return url ? cropBackgroundStyle(url, props.cropMobile ?? null) : null;
  };

  return (
    <div class="flex flex-col gap-2">
      <span class="flex items-center gap-2">
        <span class="font-body text-text-muted text-[0.8rem]">{props.label}</span>
        <InstantBadge />
      </span>
      <div class="flex flex-wrap items-end gap-3">
        <Show when={absoluteUrl()}>
          {(url) => (
            <Show
              when={cropStyle()}
              fallback={
                <img
                  src={url()}
                  alt=""
                  class="border-border h-32 w-full max-w-xs rounded-sm border object-cover"
                />
              }
            >
              {(style) => (
                <div
                  role="img"
                  aria-label={`${props.label} (cropped)`}
                  // WYSIWYG with the guest render: the box adopts the crop's true
                  // pixel aspect, and the region scales uniformly inside it — what the
                  // organiser sees here is exactly what guests get (no stretch).
                  class="border-border w-full max-w-xs overflow-hidden rounded-sm border"
                  style={{
                    ...style(),
                    "aspect-ratio": String(cropAspectRatio(props.crop, CROP_ASPECT[props.slot])),
                  }}
                />
              )}
            </Show>
          )}
        </Show>
        <Show when={cropMobileStyle()}>
          {(style) => (
            <div
              role="img"
              aria-label={`${props.label} (phone crop)`}
              // Same WYSIWYG contract as the main thumbnail, at a phone-ish
              // height: the tall region guests see below the desktop breakpoint.
              class="border-border h-32 overflow-hidden rounded-sm border"
              style={{
                ...style(),
                "aspect-ratio": String(
                  cropAspectRatio(props.cropMobile ?? null, CROP_ASPECT["hero-mobile"]),
                ),
              }}
            />
          )}
        </Show>
      </div>
      <div class="flex flex-wrap items-center gap-3">
        <input
          type="file"
          accept="image/jpeg,image/png,image/webp"
          onChange={(e) => {
            const file = e.currentTarget.files?.[0];
            if (file) props.onSelect(file);
            e.currentTarget.value = "";
          }}
          class="font-body text-text file:border-border file:bg-bg file:font-body file:text-text hover:file:border-gold text-[0.82rem] file:mr-3 file:rounded-sm file:border file:px-3 file:py-1.5 file:text-[0.82rem]"
        />
        <Show when={props.url}>
          <Button variant="outline" size="sm" onClick={() => setCropping("desktop")}>
            Crop
          </Button>
          <Show when={hasMobileCrop()}>
            <Button variant="outline" size="sm" onClick={() => setCropping("mobile")}>
              Phone crop
            </Button>
          </Show>
          {/* Danger, not quiet: removing the photo takes effect on the live
              invite straight away — there is no save bar to change your mind at. */}
          <Button variant="danger" size="sm" onClick={() => props.onRemove()}>
            Remove
          </Button>
        </Show>
      </div>
      <Show when={props.error}>
        <Notice tone="error" alert>
          {props.error}
        </Notice>
      </Show>
      <Show when={hasMobileCrop()}>
        <p class="font-body text-text-muted text-[0.72rem]">
          Phones show a tall slice of this photo — use “Phone crop” to choose which part, so the
          people in it stay in view on small screens.
        </p>
      </Show>
      <Show when={cropping() === "desktop" && absoluteUrl()}>
        {(url) => (
          <Suspense>
            <ImageCropModal
              imageUrl={url()}
              slot={props.slot}
              initialCrop={props.crop}
              onSave={props.onSaveCrop}
              onReset={() => props.onSaveCrop(null)}
              onClose={() => {
                haptic("dismiss");
                setCropping(null);
              }}
            />
          </Suspense>
        )}
      </Show>
      <Show when={cropping() === "mobile" && absoluteUrl()}>
        {(url) => (
          <Suspense>
            <ImageCropModal
              imageUrl={url()}
              slot="hero-mobile"
              initialCrop={props.cropMobile ?? null}
              onSave={(c) => props.onSaveCropMobile!(c)}
              onReset={() => props.onSaveCropMobile!(null)}
              onClose={() => {
                haptic("dismiss");
                setCropping(null);
              }}
            />
          </Suspense>
        )}
      </Show>
    </div>
  );
}
