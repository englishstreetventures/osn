import { Show } from "solid-js";

import {
  cropAspectRatio,
  cropBackgroundImageSetDeclaration,
  cropBackgroundStyle,
  type ImageCrop,
} from "./image-crop";
import { footerState } from "./invite-emptiness";
import { buildSrcSet, variantSrc } from "./invite-images";

/**
 * The tallest a closing band may be. `dvh`, not `vh`, so a phone's collapsing
 * URL bar doesn't leave it measured against a viewport that isn't there.
 *
 * Exported for the drift guard in the tests: it appears BOTH as a literal
 * inside {@link BAND_IMG_CLASS} (Tailwind's scanner reads source text — a
 * computed class emits no CSS at all) and as this value in the cropped path's
 * width `calc`, so the two have to be asserted equal rather than trusted.
 */
export const BAND_MAX_HEIGHT = "85dvh";

/**
 * The uncropped band: the full width its column allows, the source's own
 * proportions (`h-auto`), bounded by the screen. `object-cover` bites only when
 * that bound does, and crops centred — acceptable for an image the organiser
 * never framed.
 */
export const BAND_IMG_CLASS = "block h-auto max-h-[85dvh] w-full object-cover";

/**
 * The widest a CROPPED band may be, so the screen-height bound never becomes a
 * `max-height` clip: paired with `width: 100%` this is `min(100%, cap × aspect)`
 * — the column's full width at any ordinary landscape shape, a narrower centred
 * box only when the band would otherwise outgrow the screen.
 */
export function bandMaxWidth(aspect: number): string {
  return `calc(${BAND_MAX_HEIGHT} * ${aspect})`;
}

/**
 * The width the band is allowed to occupy, as a custom property the section
 * declares and the band's own box reads. `100vw` is the base — edge to edge —
 * and {@link BAND_CAP_CLASS} narrows it at `2xl`.
 *
 * One property rather than a `max-width` utility so the band's box and the
 * section's `contain-intrinsic-size` reserve read the same number: the reserve
 * is a closed-form expression over the band's width, and a reserve computed
 * against a width the band no longer takes moves the scrollbar under the guest.
 */
const BAND_WIDTH_VAR = "--invite-band-width";

/**
 * The band's cap above `2xl` (1536px), keyed by the content-cap token the pack
 * measures its events column with — so a change to the column moves the band
 * with it rather than leaving a third copy of the number behind.
 *
 * The class strings are LITERAL because Tailwind's scanner reads source text: a
 * computed class emits no CSS at all.
 */
export const BAND_CAP_CLASS = {
  "column-xl": "2xl:[--invite-band-width:var(--container-column-xl)]",
  "column-2xl": "2xl:[--invite-band-width:var(--container-column-2xl)]",
} as const;

/** A pack's events-column cap, as {@link BAND_CAP_CLASS} keys it. */
export type BandCap = keyof typeof BAND_CAP_CLASS;

/**
 * The same caps in CSS pixels, for `sizes` — which has no access to a custom
 * property and so must restate the number. `InviteClosing.test.tsx` reads the
 * token block in `src/styles/global.css` and fails if either value drifts from
 * the token its class above points at.
 */
export const BAND_CAP_PX = {
  "column-xl": "640px",
  "column-2xl": "960px",
} as const satisfies Record<BandCap, string>;

/**
 * Where the cap takes effect, in the one form an `img` `sizes` attribute can
 * state it. Tailwind's `2xl` is `96rem` against the initial 16px font size, and
 * a media query's `rem` ignores the document's own root size — so the two agree
 * at 1536px even though this page steps its root to 17px at 1024px.
 */
const BAND_CAP_MIN_WIDTH = "1536px";

/**
 * How long the band takes to settle into or out of its cap. Only a live resize
 * across 1536px ever plays it; a guest who loads at a wide width sees the
 * capped band already in place. The global `prefers-reduced-motion` clamp in
 * `src/styles/global.css` overrides this to 0.01ms.
 */
export const BAND_WIDTH_TRANSITION_CLASS = "transition-[max-width] duration-500 ease-out";

/**
 * The band's shape when a crop carries no captured source dims (a legacy
 * rectangle saved before the editor recorded them). 16∶9 — the wide frame the
 * closing slot's crop editor now opens on (`CROP_ASPECT.footer`), so the
 * fallback matches what an organiser would have been shown.
 */
const LEGACY_CROP_ASPECT = 16 / 9;

export interface InviteClosingProps {
  /**
   * The closing section's visibility switch, from the claim response. Off ⇒
   * render nothing even with content. Absent (an API older than the switch)
   * reads as on.
   */
  visible?: boolean | null;
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
   * The pack's events-column width, which the band is capped to above 1536px.
   * Omitted ⇒ the band runs edge to edge at every width.
   */
  bandCap?: BandCap;
  /**
   * Validated CSS-variable map for this section's surface — the WELCOME
   * section's vars (`sectionVars(theme, "welcome")`), since this section
   * deliberately shares that tone rather than carrying one of its own.
   */
  themeVars?: Record<string, string>;
}

/**
 * The invite's CLOSING SECTION — the couple's own sign-off: an optional
 * EDGE-TO-EDGE image over an optional closing note ("Looking forward to
 * celebrating with you", "No boxed gifts please").
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
 * Like the hero and Our Story it is a conditional segment: switched off, or
 * with neither a note nor an image, it renders NOTHING — no empty surface, no
 * stray band above the footer.
 *
 * IMAGE SHAPE — the image is a band spanning the viewport edge to edge, with the
 * note (when there is one) reading below it on the section surface. The section
 * carries no horizontal padding of its own; the note's block does, because the
 * band has to reach past it.
 *
 * Above 1536px the band stops growing and centres on its pack's events column
 * ({@link InviteClosingProps.bandCap}): edge to edge on a 2560px display makes
 * the sign-off several times larger than the event cards it closes, which reads
 * as a banner rather than as the couple's last word. Below that width it is
 * still edge to edge, and a live resize across the boundary eases between the
 * two ({@link BAND_WIDTH_TRANSITION_CLASS}).
 *
 * THE CROP DECIDES THE SHAPE. Full width, and then the HEIGHT follows what the
 * organiser framed: the box takes the crop's true pixel aspect and renders the
 * cropped region exactly (`cropBackgroundStyle`, the story photo's technique),
 * so an organiser who crops a 3∶1 panorama gets a 3∶1 panorama and one who crops
 * a 4∶3 scene gets a 4∶3 scene. What you frame is what publishes, and the
 * builder's preview shows it.
 *
 * With no crop saved, the image keeps its NATURAL aspect (`h-auto`) — nothing
 * is chosen, so nothing is cut.
 *
 * THE HEIGHT BOUND, and why it bounds the WIDTH. A band may not grow taller
 * than {@link BAND_MAX_HEIGHT}. On the cropped path that bound is applied to
 * the box's WIDTH (`min(100%, max-height × aspect)`, centred) and NEVER as a
 * `max-height` clip, which would render only a top-anchored crop's TOP strip.
 * So an extreme portrait crop stops being edge-to-edge — it becomes a centred
 * column at the widest size that fits a screen — but is still shown WHOLE and
 * exact. The plain `<img>` path keeps a `max-h` + `object-cover`, which
 * genuinely does crop centred, and applies only to an image nobody framed.
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
 *
 * @see wiki/decisions/closing-band-width-bound-over-height-clip.md — why the
 * crop decides the shape here but not in the hero, and why the height bound is
 * applied to the width.
 */
export function InviteClosing(props: InviteClosingProps) {
  // The whole section is a conditional segment: switched off, or nothing set ⇒
  // render nothing. `footerState` is the function the organiser builder mirrors
  // for its badge, so the two cannot disagree.
  const show = () =>
    footerState(props.visible, { message: props.message, imageUrl: props.imageUrl }) === "shown";

  // Trimmed so a note of "  text  " doesn't render its padding. The API already
  // normalises on save; this also covers a legacy row.
  const note = () => props.message?.trim() ?? "";

  const imageSrc = () => (props.imageUrl ? `${props.apiUrl}${props.imageUrl}` : null);

  // A saved crop paints a background layer instead of the `<img>`, rendering the
  // framed region EXACTLY: uniform scale, and the box below takes the crop's own
  // aspect, so the region fills it with no distortion and no bars. A background
  // layer can't carry a `srcset`, and `image-set()` only sees device-pixel-ratio
  // — not viewport width — so the two axes split across two elements below
  // `md:`. Above `md:` the band renders at 1200–1600px, where even DPR 1 needs
  // the full `hero` (1600w): dropping to `card` there would be visibly soft
  // across the viewport, so the wide layer keeps exactly today's behaviour.
  // Below `md:` the band is ~400 CSS px wide, so `card` (800w) covers DPR 1 and
  // `hero` only serves DPR 2 — `image-set()` picks between the two.
  const wideCropStyle = () => {
    const url = imageSrc();
    return url ? cropBackgroundStyle(variantSrc(url, "hero"), props.imageCrop) : null;
  };

  // Folds the box's `aspect-ratio` / `max-width` into the same string as the
  // background declarations — a style OBJECT can't carry `background-image`
  // twice (the plain `url()` fallback + `image-set()`), so this layer's whole
  // `style` is a CSS text string instead of the usual object.
  const narrowCropStyle = () => {
    const url = imageSrc();
    if (!url) return null;
    const bg = cropBackgroundImageSetDeclaration(
      variantSrc(url, "card"),
      variantSrc(url, "hero"),
      props.imageCrop,
    );
    if (!bg) return null;
    const aspect = bandAspect();
    return `${bg}aspect-ratio:${aspect};max-width:${bandMaxWidth(aspect)};`;
  };

  // The band's height, expressed as the crop's true pixel aspect (from its
  // captured source dims). This is the whole "what you crop is what publishes"
  // contract in one line.
  const bandAspect = () => cropAspectRatio(props.imageCrop, LEGACY_CROP_ASPECT);

  // While the section is skipped by `content-visibility`, this is the height the
  // browser reserves for it. The band is exactly as wide as the band-width
  // property at the crop's aspect, so its height is a closed-form expression
  // rather than a guess; the `+ 24rem` covers the note block's padding. Reading
  // the same property the band's own box reads is what keeps the reserve right
  // on both sides of the cap — a flat placeholder under-reserved an edge-to-edge
  // band by 2–3×, which moves the scrollbar under the guest at the moment they
  // scroll into it. `auto` means only the first pass pays even this.
  const intrinsicSize = () =>
    imageSrc() ? `auto calc(var(${BAND_WIDTH_VAR}) / ${bandAspect()} + 24rem)` : "auto 24rem";

  // The cap, as the two places that can express it: a literal Tailwind class
  // narrowing the band-width property at `2xl`, and the same width restated for
  // `sizes`, which has no access to a custom property.
  const capClass = () => (props.bandCap ? BAND_CAP_CLASS[props.bandCap] : "");
  const bandSizes = () =>
    props.bandCap
      ? `(min-width: ${BAND_CAP_MIN_WIDTH}) ${BAND_CAP_PX[props.bandCap]}, 100vw`
      : "100vw";

  return (
    <Show when={show()}>
      <section
        data-invite-closing
        // No horizontal padding of its own — the band reaches the viewport edge,
        // and the note below carries its own. `content-visibility: auto` defers
        // layout/paint (and the crop path's background fetch) until this
        // off-screen section approaches the viewport; the intrinsic size above
        // is what the browser reserves while it does, and at a band this size a
        // wrong reserve is a scroll jump rather than a rounding.
        class={`text-center [--invite-band-width:100vw] [content-visibility:auto] ${capClass()}`.trim()}
        // Paints the welcome section's surface; the text tokens below resolve
        // from the root palette, which already carries the organiser's scheme.
        style={{
          ...props.themeVars,
          "background-color": "var(--invite-section-bg)",
          "contain-intrinsic-size": intrinsicSize(),
        }}
      >
        <Show when={imageSrc()}>
          {(url) => (
            // The band's own box. Both paths below fill it, so the cap applies
            // to the framed image and the unframed one alike, and `mx-auto`
            // centres it in either pack — gala's events column runs flush left
            // inside a centred container, and a band inheriting that would read
            // as a mistake rather than as a choice.
            <div
              class={`mx-auto w-full ${BAND_WIDTH_TRANSITION_CLASS}`}
              style={{ "max-width": `var(${BAND_WIDTH_VAR})` }}
            >
              <Show
                when={wideCropStyle()}
                fallback={
                  /* Two candidates so `sizes` has a real choice to make: `card`
                   (800w) covers the band on a phone, `hero` (1600w) from a
                   laptop up (and on a retina phone). `sizes` states the cap
                   above 1536px as well, because the band stops tracking the
                   viewport there and a bare `100vw` would ask a 2560px screen
                   for a render three times the box it fills. The bare `src` names
                   `card` explicitly — an absent `variant` resolves to `card`
                   server-side anyway, and naming it keeps the browser from
                   minting a second transform-cache entry for a URL it never
                   fetches under a `w`-descriptor srcset. `loading="lazy"`
                   because this section is below every event card and is
                   guaranteed off-screen at mount: without it the fetch races
                   the in-viewport cards that ARE deferred, and bills a
                   per-call Images transform for guests who never scroll here. */
                  <img
                    src={variantSrc(url(), "card")}
                    srcset={buildSrcSet(url(), ["card", "hero"])}
                    sizes={bandSizes()}
                    alt=""
                    loading="lazy"
                    decoding="async"
                    class={BAND_IMG_CLASS}
                    // `aspect-ratio: auto <ratio>` — the FALLBACK form: the
                    // browser reserves a 16∶9 box until the bytes arrive, then
                    // the image's own ratio wins, so "nothing was cropped ⇒
                    // nothing is cut" survives the fix. Without it this box is
                    // 0px tall until a lazy, content-visibility-deferred image
                    // decodes, and the note plus the whole site footer jump down
                    // by up to a screen height — CLS on the one page that sells.
                    style={{ "aspect-ratio": `auto ${LEGACY_CROP_ASPECT}` }}
                  />
                }
              >
                {(style) => (
                  <>
                    {/* Below md: — image-set() 1x=card/2x=hero, so a DPR-1 phone
                      doesn't fetch the same 1600w desktop needs. */}
                    <div
                      aria-hidden="true"
                      class="mx-auto block w-full md:hidden"
                      style={narrowCropStyle() ?? undefined}
                    />
                    {/* md: and up — exactly today's behaviour: plain `hero` url,
                      the box owns its size (an empty div has no intrinsic
                      dimensions): the CROP's aspect, at the full width the
                      screen-height bound allows. Never a `max-height` clip —
                      that would cut the framing this whole path exists to
                      honour. */}
                    <div
                      aria-hidden="true"
                      class="mx-auto hidden w-full md:block"
                      style={{
                        ...style(),
                        "aspect-ratio": String(bandAspect()),
                        "max-width": bandMaxWidth(bandAspect()),
                      }}
                    />
                  </>
                )}
              </Show>
            </div>
          )}
        </Show>
        <Show when={note()}>
          {/* The note's own block owns the section padding — the band above it
              carries none. */}
          <div class="px-6 py-16 md:px-8 md:py-20">
            <p
              // `whitespace-pre-line` honours the line breaks an organiser typed;
              // `break-words` stops a long unbroken line overflowing on a phone.
              // Not the muted grey — this is the couple speaking.
              class="font-body text-text max-w-ui-md mx-auto text-[clamp(1rem,2vw,1.125rem)] leading-relaxed break-words whitespace-pre-line italic"
              // Not a styling hook (the block above owns the spacing) — it
              // records that the couple's words follow their image, which the
              // tests pin so the two can't silently swap order.
              data-has-image={imageSrc() ? "true" : "false"}
            >
              {note()}
            </p>
          </div>
        </Show>
      </section>
    </Show>
  );
}
