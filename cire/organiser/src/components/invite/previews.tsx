/**
 * Live preview rendering for the invite builder, split in two layers:
 *
 * - `HeroSample` / `SectionSample` — the raw section content, styled with the
 *   SAME derived tokens the guest invite consumes (`derivePalette` +
 *   `typographyVars` in `@cire/theme`, resolved once in the builder's
 *   `previewTokens` memo). One markup source, two consumers.
 * - `HeroPreview` / `SectionPreview` — the labelled inline preview cards shown
 *   under each section's controls on narrow layouts; hidden at the builder's
 *   wide breakpoint, where the composed `PreviewPane` takes over.
 *
 * The hero preview is CROP-AWARE (it renders the saved rectangle with the same
 * background-fraction technique as the guest site, so the framing never lies)
 * and offers a desktop/phone toggle — the phone view is the whole reason the
 * hero's second crop rectangle exists (0046).
 */

import { headingSizeCss, typographyVar } from "@cire/theme";
import { createSignal, Show } from "solid-js";

import { apiUrl } from "../../lib/api";
import { cropBackgroundStyle, type ImageCrop } from "../../lib/image-crop";
import { DEFAULTS } from "./model";

// The guest hero's base gradient and title panel, expressed in the SAME derived
// tokens the guest site uses — so the preview cannot drift from the real hero
// the way the old hand-copied colour literals could.
export const PREVIEW_HERO_GRADIENT =
  "linear-gradient(160deg, var(--invite-hero-grad-1) 0%, var(--invite-hero-grad-2) 40%, var(--invite-hero-grad-3) 100%)";
export const PREVIEW_HERO_SCRIM =
  "radial-gradient(ellipse at center, var(--invite-scrim-from) 0%, var(--invite-scrim-to) 100%)";

export type PreviewDevice = "desktop" | "phone";

/** Desktop/phone frame switch for the hero preview + preview pane. */
export function DeviceToggle(props: {
  value: PreviewDevice;
  onChange: (v: PreviewDevice) => void;
}) {
  const option = (device: PreviewDevice, label: string) => (
    <button
      type="button"
      aria-pressed={props.value === device}
      onClick={() => props.onChange(device)}
      class="border-border hover:border-gold aria-pressed:border-gold aria-pressed:text-gold font-body text-text-muted rounded-sm border px-2 py-1 text-[0.68rem] tracking-[0.08em] uppercase transition"
    >
      {label}
    </button>
  );
  return (
    <span class="flex gap-1.5" role="group" aria-label="Preview device">
      {option("desktop", "Desktop")}
      {option("phone", "Phone")}
    </span>
  );
}

/** A non-blurred image variant URL so the client-side CSS blur is the only
 *  blur in the preview (`card`, never the server-blurred `hero-bg`). The
 *  imageUrl already carries the ?v= cache-buster. */
function previewVariantSrc(imageUrl: string | null): string | null {
  if (!imageUrl) return null;
  const sep = imageUrl.includes("?") ? "&" : "?";
  return apiUrl(`${imageUrl}${sep}variant=card`);
}

/**
 * The hero section's raw content: photo backdrop (crop-aware) + live CSS blur
 * (free — no Cloudflare Images calls), the radial scrim, the title legibility
 * panel from the two backdrop sliders, and the title in the scheme's accent +
 * chosen typography. With no image it falls back to the same derived gradient
 * the real hero uses, so the sample is never empty. The caller owns the frame
 * (size + border) and the token scope.
 */
export function HeroSample(props: {
  imageUrl: string | null;
  /** Saved crop for the active device — rendered with the guest's
   *  background-fraction technique so the preview framing matches the invite. */
  crop?: ImageCrop | null;
  title: string;
  heroBlur: number;
  backdropOpacity: number;
  backdropBlur: number;
  /** The surface the hero's tone paints, behind the gradient. */
  surface: string;
  class?: string;
}) {
  const src = () => previewVariantSrc(props.imageUrl);
  const cropStyle = () => {
    const url = src();
    return url ? cropBackgroundStyle(url, props.crop) : null;
  };
  const titleText = () => (props.title.trim().length > 0 ? props.title : DEFAULTS.heroTitle);
  return (
    <div
      class={`relative flex items-center justify-center overflow-hidden ${props.class ?? "h-44"}`}
      style={{
        "background-color": props.surface,
        "background-image": PREVIEW_HERO_GRADIENT,
      }}
    >
      {/* Background photo with a live CSS blur. A saved crop renders its exact
          rectangle (scaled slightly up so the blur never bleeds the frame edge);
          without one, the plain object-cover image. */}
      <Show
        when={cropStyle()}
        fallback={
          <Show when={src()}>
            {(url) => (
              <img
                src={url()}
                alt=""
                class="absolute inset-0 h-full w-full object-cover"
                style={{ filter: `blur(${props.heroBlur}px)`, transform: "scale(1.1)" }}
              />
            )}
          </Show>
        }
      >
        {(style) => (
          <div
            aria-hidden
            class="absolute inset-0"
            style={{
              ...style(),
              filter: `blur(${props.heroBlur}px)`,
              transform: "scale(1.1)",
            }}
          />
        )}
      </Show>
      {/* Radial scrim, mirroring the guest hero, so the title always reads. */}
      <div class="absolute inset-0" style={{ background: PREVIEW_HERO_SCRIM }} />
      {/* Title legibility panel — opacity + frosted blur from the two sliders,
          tinted by the scheme's derived panel colour. Painted only when opacity
          > 0 (mirrors the guest behaviour). */}
      <div
        class="relative flex items-center justify-center rounded-xl px-6 py-4"
        style={
          props.backdropOpacity > 0
            ? {
                "background-color": `color-mix(in oklab, var(--invite-panel) ${props.backdropOpacity}%, transparent)`,
                "backdrop-filter": `blur(${props.backdropBlur}px)`,
                "-webkit-backdrop-filter": `blur(${props.backdropBlur}px)`,
              }
            : undefined
        }
      >
        {/* Follows the typography variables — including the pack's base look
            as each fallback, taken from `@cire/theme` rather than retyped, so
            a pack that changes its base can't leave this sample behind. */}
        <span
          class="max-w-full text-center leading-none break-words"
          style={{
            color: "var(--color-gold)",
            "font-family": "var(--font-display)",
            "font-size": headingSizeCss("clamp(1.25rem,6vw,2rem)"),
            "font-weight": typographyVar("headingWeight"),
            "font-style": typographyVar("headingStyle"),
          }}
        >
          {titleText()}
        </span>
      </div>
    </div>
  );
}

/**
 * The inline WYSIWYG hero preview: labelled frame + device toggle around
 * `HeroSample`. The phone frame is a tall 9∶16 slice using the hero's phone
 * rectangle (falling back to the desktop crop, exactly as the guest site does).
 * Hidden at the builder's wide breakpoint — the sticky `PreviewPane` shows the
 * hero there instead.
 */
export function HeroPreview(props: {
  imageUrl: string | null;
  crop?: ImageCrop | null;
  cropMobile?: ImageCrop | null;
  title: string;
  heroBlur: number;
  backdropOpacity: number;
  backdropBlur: number;
  tokens: Record<string, string>;
  /** The surface the hero's tone paints, behind the gradient. */
  surface: string;
}) {
  const [device, setDevice] = createSignal<PreviewDevice>("desktop");
  const activeCrop = () =>
    device() === "phone" ? (props.cropMobile ?? props.crop ?? null) : (props.crop ?? null);
  return (
    <div class="flex flex-col gap-2 @4xl/builder:hidden">
      <span class="flex items-center justify-between gap-2">
        <span class="font-body text-text-muted text-[0.8rem]">Live preview</span>
        <Show when={props.imageUrl}>
          <DeviceToggle value={device()} onChange={setDevice} />
        </Show>
      </span>
      <div
        aria-label="Hero preview"
        class="border-border overflow-hidden rounded-sm border"
        style={{ ...props.tokens, "border-color": "var(--color-border)" }}
      >
        <HeroSample
          imageUrl={props.imageUrl}
          crop={activeCrop()}
          title={props.title}
          heroBlur={props.heroBlur}
          backdropOpacity={props.backdropOpacity}
          backdropBlur={props.backdropBlur}
          surface={props.surface}
          class={device() === "phone" ? "mx-auto h-64 w-40" : "h-44"}
        />
      </div>
    </div>
  );
}

/**
 * One section's raw preview content: eyebrow / heading / optional motif image /
 * body, on the section's tone surface, in the scheme's derived tokens. The
 * caller owns the token scope and the frame.
 */
export function SectionSample(props: {
  /** The surface this section's tone paints, as a `var(--color-…)` reference. */
  surface: string;
  eyebrow?: string;
  heading?: string;
  /** Optional small centred image (the closing section's motif). */
  imageUrl?: string | null;
  body: string;
  /** Optional mini event card (the events section's preview). */
  card?: { name: string; meta: string };
  class?: string;
}) {
  return (
    // The body weight + style ride the section wrapper alongside the body face
    // and cascade to every line inside it — eyebrow, body copy and the event
    // card — mirroring `global.css`'s `body` rule on the guest invite. Pinning
    // them on the body line alone left the rest of the sample on the pack's
    // default, so a "Body weight: Bold" pick only moved one span.
    //
    // They are Tailwind arbitrary properties rather than inline style, which is
    // the idiom the guest packs' heading elements already use
    // (`[font-weight:var(--invite-heading-weight,300)]`). It also keeps them out
    // of a style object that carries a dynamic value: Solid applies that one
    // through `setProperty`, and happy-dom discards a `var()` value there, so
    // the contract would be invisible to the tests.
    <div
      style={{ "background-color": props.surface, "font-family": "var(--font-body)" }}
      class={`flex flex-col items-center justify-center gap-1.5 p-4 text-center [font-weight:var(--invite-body-weight,400)] [font-style:var(--invite-body-style,normal)] ${props.class ?? ""}`}
    >
      <Show when={props.eyebrow}>
        <span
          style={{ color: "var(--color-gold)" }}
          class="text-[0.6rem] tracking-[0.18em] uppercase opacity-80"
        >
          {props.eyebrow}
        </span>
      </Show>
      {/* The heading sample follows the typography variables, fallbacks from
          `@cire/theme` — it used to be decoratively italic, which would now
          lie about an explicit "Normal" pick. */}
      <Show when={props.heading}>
        <span
          style={{
            color: "var(--color-text)",
            "font-family": "var(--font-display)",
            "font-size": headingSizeCss("1.5rem"),
            "font-weight": typographyVar("headingWeight"),
            "font-style": typographyVar("headingStyle"),
          }}
          class="leading-none"
        >
          {props.heading}
        </span>
      </Show>
      <Show when={props.imageUrl}>
        {(url) => (
          <img
            src={previewVariantSrc(url())!}
            alt=""
            class="border-border h-10 w-10 rounded-sm border object-cover"
          />
        )}
      </Show>
      {/* Body sample in the body font on the section surface, so the font and
          the text-on-surface contrast are both visible. Weight + style are
          inherited from the wrapper above. */}
      <span
        style={{ color: "var(--color-text-muted)" }}
        class="max-w-full text-[0.62rem] break-words"
      >
        {props.body}
      </span>
      <Show when={props.card}>
        {(card) => (
          <div
            class="mt-1 flex w-full max-w-[14rem] flex-col gap-1 rounded-sm border p-2 text-left"
            style={{
              "background-color": "var(--color-surface)",
              "border-color": "var(--color-border)",
            }}
          >
            <span class="text-[0.68rem]" style={{ color: "var(--color-text)" }}>
              {card().name}
            </span>
            <span class="text-[0.6rem]" style={{ color: "var(--color-text-muted)" }}>
              {card().meta}
            </span>
            <span
              class="w-fit rounded-sm px-1.5 py-0.5 text-[0.58rem]"
              style={{ "background-color": "var(--color-gold)", color: "var(--color-bg)" }}
            >
              Respond
            </span>
          </div>
        )}
      </Show>
    </div>
  );
}

/**
 * The labelled inline preview card for one section — `SectionSample` in a
 * bordered figure, driven by the live scheme + copy buffers so every
 * colour/font/copy change is visible instantly, before saving. Hidden at the
 * builder's wide breakpoint in favour of the composed `PreviewPane`.
 */
export function SectionPreview(props: {
  label: string;
  tokens: Record<string, string>;
  surface: string;
  eyebrow?: string;
  heading?: string;
  imageUrl?: string | null;
  body: string;
  card?: { name: string; meta: string };
}) {
  return (
    <div class="flex flex-col gap-1.5 @4xl/builder:hidden">
      <span class="font-body text-text-muted text-[0.8rem]">Live preview</span>
      <figure
        aria-label={`${props.label} preview`}
        style={{ ...props.tokens, "border-color": "var(--color-border)" }}
        class="overflow-hidden rounded-sm border"
      >
        <SectionSample
          surface={props.surface}
          eyebrow={props.eyebrow}
          heading={props.heading}
          imageUrl={props.imageUrl}
          body={props.body}
          card={props.card}
          class="min-h-28"
        />
        <figcaption
          style={{ color: "var(--color-text-muted)", "background-color": props.surface }}
          class="font-body px-4 pb-2 text-center text-[0.62rem] tracking-[0.08em] uppercase"
        >
          {props.label}
        </figcaption>
      </figure>
    </div>
  );
}
