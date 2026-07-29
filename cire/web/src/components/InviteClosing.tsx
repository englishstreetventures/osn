import { Show } from "solid-js";

import { cropAspectRatio, cropBackgroundStyle, type ImageCrop } from "./image-crop";
import { isFooterEmpty } from "./invite-emptiness";
import { buildSrcSet, type VariantName, variantSrc } from "./invite-images";

/**
 * The invite's CLOSING SECTION — the couple's own sign-off: an optional image
 * (monogram, motif, signature) over an optional closing note ("Looking forward
 * to celebrating with you", "No boxed gifts please").
 *
 * This is a SECTION OF THE INVITE, not part of the site footer:
 *   - `SiteFooter.astro` is site-wide chrome — the couple's title plus the legal
 *     links + privacy control. It renders on EVERY document (invite, /privacy,
 *     /terms, 404) and must always be there (compliance blocker C-H4).
 *   - This is invite content, rendered by `InvitePage` as the last thing above
 *     that footer, and — like the events list — only AFTER the guest has
 *     claimed their code, because it is addressed to the invited household.
 *
 * That gate is enforced at the API, not here (S-H1): `GET /api/invite/:slug` is
 * unauthenticated, so it REDACTS the closing section, and the content is
 * delivered in the claim response instead (`ClaimResult.closing`). The motif's
 * bytes are likewise session-gated and served `Cache-Control: private`. This
 * component therefore receives nothing at all until a code is entered — the
 * render gate and the data gate are the same gate.
 *
 * Like the hero and Our Story it is a conditional segment: with neither a note
 * nor an image it renders NOTHING — no empty surface, no stray band above the
 * footer.
 *
 * SURFACE — it deliberately has NO tone setting of its own. It paints whatever
 * the organiser chose for the "Code Entry & Welcome" section (`themeVars`,
 * supplied by the caller as `sectionVars(theme, "welcome")`): the welcome
 * greeting and this closing note are the couple's two direct addresses to their
 * guests, so they read as a matched pair, and the builder gains no extra knob.
 *
 * NAMING — storage and the wire say `footer_*` / `footer` (the invite's footer
 * section, and the image slot's R2 namespace + public URL segment), while the
 * organiser-facing label is "Closing Section". Deliberate, not drift: showing an
 * organiser "footer" next to a page that also has a legal footer would be
 * ambiguous about which one they are editing.
 */

/**
 * The closing image's display shape when no crop was saved (or a legacy crop
 * carries no source dims). Square: the slot is sized for a monogram, motif or
 * signature rather than a scene, and a square reads as deliberate at the small
 * width this section gives it.
 */
const CLOSING_IMAGE_ASPECT = 1;

export interface InviteClosingProps {
  /** The couple's closing note. Blank/whitespace-only ⇒ no note. */
  message?: string | null;
  /**
   * The closing image's URL *path* as the API reports it, or null for none. The
   * component prepends `apiUrl` — callers pass the payload value unchanged.
   */
  imageUrl?: string | null;
  /** Crop rectangle the organiser framed the closing image with, if any. */
  imageCrop?: ImageCrop | null;
  /** cire-api origin the image path is resolved against. */
  apiUrl: string;
  /**
   * Validated CSS-variable map for this section's surface — the WELCOME
   * section's vars (`sectionVars(theme, "welcome")`), since this section
   * deliberately shares that tone rather than carrying one of its own.
   */
  themeVars?: Record<string, string>;
}

export function InviteClosing(props: InviteClosingProps) {
  // The whole section is a conditional segment: nothing set ⇒ render nothing.
  // `isFooterEmpty` is the shared predicate the organiser builder mirrors for
  // its "Shown / Hidden — empty" badge, so the two cannot disagree.
  const show = () => !isFooterEmpty({ message: props.message, imageUrl: props.imageUrl });

  // Trimmed so a note of "  text  " doesn't render its padding. The API already
  // normalises on save; this also covers a legacy row.
  const note = () => props.message?.trim() ?? "";

  const imageSrc = () => (props.imageUrl ? `${props.apiUrl}${props.imageUrl}` : null);

  // When a crop was saved, render the cropped region with the same CSS-fraction
  // technique the story photo uses (a background layer — backgrounds can't take
  // a srcset, so we pick one bounded variant).
  //
  // The crop layer scales the source by 100/w, so a TIGHT crop needs more source
  // pixels than the 200px box suggests: at w = 0.4 the visible region is 40% of
  // an already-downscaled image. Below half-width we ask for `card` (800w);
  // otherwise `thumb` (320w) is ample and saves ~6× the bytes. Both are in the
  // existing allowlist, so the transform cardinality guarantee is unaffected.
  const cropVariant = (): VariantName => ((props.imageCrop?.w ?? 1) < 0.5 ? "card" : "thumb");
  const cropStyle = () => {
    const url = imageSrc();
    return url ? cropBackgroundStyle(variantSrc(url, cropVariant()), props.imageCrop) : null;
  };

  // The box adopts the crop's TRUE pixel aspect (from its captured source dims)
  // so the uniformly-scaled region fills it with no distortion and no empty
  // bars; a legacy crop with no dims falls back to the square default.
  const imageAspect = () => String(cropAspectRatio(props.imageCrop, CLOSING_IMAGE_ASPECT));

  return (
    <Show when={show()}>
      <section
        data-invite-closing
        // `content-visibility: auto` defers layout/paint (and the crop path's
        // background fetch) until this off-screen section approaches the viewport.
        class="px-6 py-16 text-center [content-visibility:auto] md:px-8 md:py-20"
        // Paints the welcome section's surface; the text tokens below resolve
        // from the root palette, which already carries the organiser's scheme.
        style={{ ...props.themeVars, "background-color": "var(--invite-section-bg)" }}
      >
        <Show when={imageSrc()}>
          {(url) => (
            <Show
              when={cropStyle()}
              fallback={
                /* Two candidates so `sizes` has a real choice to make: `thumb`
                   (320w) covers the 200px box at 1×, `card` (800w) at 3× on a
                   phone. The bare `src` names `thumb` explicitly — an absent
                   `variant` resolves to `card` server-side, which would mint a
                   second transform-cache entry for a URL the browser never
                   fetches under a `w`-descriptor srcset. `loading="lazy"`
                   because this section is below every event card and is
                   guaranteed off-screen at mount: without it the fetch races
                   the in-viewport cards that ARE deferred, and bills a
                   per-call Images transform for guests who never scroll here. */
                <img
                  src={variantSrc(url(), "thumb")}
                  srcset={buildSrcSet(url(), ["thumb", "card"])}
                  sizes="200px"
                  alt=""
                  loading="lazy"
                  decoding="async"
                  class="mx-auto block h-auto w-[min(200px,45vw)] rounded-sm object-cover"
                  style={{ "aspect-ratio": imageAspect() }}
                />
              }
            >
              {(style) => (
                <div
                  aria-hidden="true"
                  // The cropped variant paints a background layer, so the box
                  // clips it and takes its size from the width + aspect-ratio
                  // (an empty div has no intrinsic dimensions).
                  class="mx-auto w-[min(200px,45vw)] overflow-hidden rounded-sm bg-no-repeat"
                  style={{ ...style(), "aspect-ratio": imageAspect() }}
                />
              )}
            </Show>
          )}
        </Show>
        <Show when={note()}>
          <p
            // `whitespace-pre-line` honours the line breaks an organiser typed;
            // `break-words` stops a long unbroken line overflowing on a phone.
            // Not the muted grey — this is the couple speaking.
            class="font-body text-text mx-auto max-w-[34rem] text-[clamp(1rem,2vw,1.125rem)] leading-relaxed break-words whitespace-pre-line italic data-[has-image=true]:mt-7"
            data-has-image={imageSrc() ? "true" : "false"}
          >
            {note()}
          </p>
        </Show>
      </section>
    </Show>
  );
}
