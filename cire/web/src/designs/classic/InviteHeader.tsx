import { createEffect, createResource, Show } from "solid-js";

import { createHeroBackdrop } from "../../components/hero-backdrop";
import {
  cropAspectRatio,
  cropBackgroundStyle,
  heroCropBackgroundStyle,
} from "../../components/image-crop";
import { isHeroEmpty, isStoryEmpty } from "../../components/invite-emptiness";
import { buildSrcSet, HERO_BG_VARIANT, variantSrc } from "../../components/invite-images";
import { applyPaletteToRoot, filterThemeVars, sectionVars } from "../../components/invite-theme";
import type { HeroDisplay, InviteCustomisation } from "../types";

// The Our Story photo's default display aspect (4∶3) — the shape the box used
// before crops carried source dimensions. Used as the fallback when a crop has no
// captured dims (a legacy crop), so it renders exactly as it did before.
const STORY_DEFAULT_ASPECT = 4 / 3;

// The section background, painted from whichever derived surface the section's
// tone names. Every other colour here comes from the Tailwind utility classes,
// which now resolve through the palette applied at the document root — so hero
// and story finally follow the organiser's scheme like the rest of the page.
const SECTION_SURFACE = { "background-color": "var(--invite-section-bg)" };

// The today's-look defaults — used when the field is absent (older API /
// mid-deploy). Mirrors DEFAULT_HERO_DISPLAY in cire/api.
const DEFAULT_HERO_DISPLAY: HeroDisplay = { blur: 28, titleBackdrop: { opacity: 0, blur: 0 } };

/** Clamp a (possibly stale/garbage) number into [min, max]; fall back if NaN. */
function clampNum(value: number | undefined, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || Number.isNaN(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

interface InviteHeaderProps {
  apiUrl: string;
  slug: string;
  /**
   * Customisation resolved at build time in `index.astro` and used as the
   * initial render, so the hero paints with the real image/copy in the SSR'd
   * HTML instead of after a client fetch waterfall (IB-P-W1). The island still
   * revalidates on mount to pick up changes made since the build.
   */
  initial?: InviteCustomisation | null;
}

/**
 * Renders the invite's hero + "Our Story" sections, applying the organiser's
 * per-wedding customisation (fetched client-side from the public invite
 * endpoint) on top of the built-in defaults. Anything the organiser hasn't set
 * falls back to the original hard-coded copy, so an uncustomised wedding renders
 * exactly as before. The event/guest data is unaffected — that still loads via
 * InvitePage's /api/claim flow.
 */
export default function InviteHeader(props: InviteHeaderProps) {
  const [data] = createResource<InviteCustomisation | null>(
    async () => {
      try {
        const res = await fetch(`${props.apiUrl}/api/invite/${props.slug}`, {
          cache: "no-store",
        });
        // On a non-OK/failed revalidation keep the build-time data rather than
        // wiping the already-painted hero.
        if (!res.ok) return props.initial ?? null;
        return (await res.json()) as InviteCustomisation;
      } catch {
        return props.initial ?? null;
      }
    },
    { initialValue: props.initial ?? null },
  );

  const hero = () => data()?.hero;
  const story = () => data()?.story;
  const theme = () => data()?.theme ?? null;
  // Hero display sliders (organiser choice), defaulting to today's look when the
  // field is absent (older API / mid-deploy). `blur` drives the SERVER-SIDE hero
  // backdrop blur (applied to the `hero-bg` variant); the title backdrop
  // opacity + blur drive the legibility panel behind the title text. Clamped
  // defensively against a stale/garbage payload.
  const titleBackdropOpacity = () =>
    clampNum(
      data()?.heroDisplay?.titleBackdrop?.opacity,
      0,
      100,
      DEFAULT_HERO_DISPLAY.titleBackdrop.opacity,
    );
  const titleBackdropBlur = () =>
    clampNum(
      data()?.heroDisplay?.titleBackdrop?.blur,
      0,
      20,
      DEFAULT_HERO_DISPLAY.titleBackdrop.blur,
    );
  // Whether to paint the title legibility panel at all (opacity 0 ⇒ none).
  const showTitleBackdrop = () => titleBackdropOpacity() > 0;

  // Per-section CSS-variable maps. Each only contains the variables the organiser
  // actually set (and that passed validation); an absent variable falls through
  // to the built-in token via the `var(--invite-*, <default>)` fallbacks below,
  // so an un-themed (or partially-themed) invite renders exactly as before.
  const heroVars = () => sectionVars(theme(), "hero");
  const storyVars = () => sectionVars(theme(), "story");

  // Re-apply the derived palette to the document root whenever the revalidated
  // theme changes. The Astro shell already server-rendered it for the first
  // paint; this is what makes a colour the organiser just saved show up on the
  // no-store refetch, and it repaints the WHOLE page (footer included) rather
  // than only this island.
  createEffect(() => applyPaletteToRoot(theme()));

  // Conditional-segment gates. A hero with no image, no title and no subtitle
  // would paint an empty full-screen section (including the built-in
  // "You're Invited" fallback title), so we render NOTHING for it. The story hides when its heading,
  // body and image are all absent. Both mirror the shared emptiness predicates
  // the organiser builder uses for its Shown/Hidden badges.
  const showHero = () => {
    const h = hero();
    return !isHeroEmpty({ imageUrl: h?.imageUrl, title: h?.title, subtitle: h?.subtitle });
  };
  const showStory = () => {
    const s = story();
    return !isStoryEmpty({ heading: s?.heading, body: s?.body, imageUrl: s?.imageUrl });
  };

  const heroImageUrl = () => {
    const url = hero()?.imageUrl;
    return url ? `${props.apiUrl}${url}` : null;
  };
  const storyImageUrl = () => {
    const url = story()?.imageUrl;
    return url ? `${props.apiUrl}${url}` : null;
  };

  // The full `src` the hero backdrop currently shows — variant-resolved, so a
  // change of EITHER the base URL (a freshly uploaded image) OR the variant
  // (organiser flips blurred↔regular) re-arms the lifecycle. Built once here so
  // the <img src> and the re-arm effect can never disagree.
  const heroBackdropSrc = (): string | null => {
    const url = heroImageUrl();
    return url ? variantSrc(url, HERO_BG_VARIANT) : null;
  };

  // Hero backdrop load lifecycle (pending/loaded/error, cached-image detection,
  // src re-arm) — shared with every design pack's header. See hero-backdrop.ts.
  const heroBackdrop = createHeroBackdrop(heroBackdropSrc);

  // The organiser's crop for the hero backdrop (or null ⇒ default centre cover).
  // When present we render the cropped region as a background layer over the same
  // server-blurred `hero-bg` source — the crop pans/zooms the already-blurred
  // backdrop, so blur + crop compose without any extra Cloudflare transform. The
  // `<img>` stays mounted purely as the load/error detector for the fade.
  const heroCropStyle = (): Record<string, string> | null => {
    const src = heroBackdropSrc();
    const crop = hero()?.imageCrop ?? null;
    // The hero box is the full viewport section, not the crop's aspect, so we
    // render the crop as a COVER focal point (uniform scale, centred on the crop
    // region) — never a stretch, never a letterbox.
    return src ? heroCropBackgroundStyle(src, crop) : null;
  };

  return (
    <>
      <Show when={showHero()}>
        <section
          // min-h, not a fixed h-dvh: a long couple title at 7rem must be able
          // to grow the hero rather than be clipped by it. The gradient and
          // photo layers below are absolute inset-0, so they stretch with it.
          class="relative min-h-dvh overflow-hidden"
          style={{ ...filterThemeVars(heroVars()), ...SECTION_SURFACE }}
        >
          {/* Default gradient — always present as the base layer / fallback. */}
          <div
            class="absolute inset-0 bg-cover bg-center"
            style="background: linear-gradient(160deg, var(--invite-hero-grad-1) 0%, var(--invite-hero-grad-2) 40%, var(--invite-hero-grad-3) 100%);"
          />
          {/* Custom background image, fading in over the gradient once decoded. The
            requested variant is the organiser's choice: `hero-bg` (server-blurred
            soft backdrop, the default) or `hero` (sharp full-bleed). On a failed
            load we unmount it so the gradient base layer remains — never a blank
            hero. */}
          <Show when={heroBackdropSrc()}>
            {(src) => (
              <Show when={heroBackdrop.state() !== "error"}>
                <img
                  ref={heroBackdrop.setImgRef}
                  // A single fixed-purpose variant (blurred backdrop or sharp full
                  // image) — one 1600px width is enough, so no responsive srcset.
                  // The blur radius (for `hero-bg`) is a server constant keyed off
                  // the variant name, never sent from here. When the organiser has
                  // cropped the hero we render the cropped region in the sibling
                  // <div> below and keep this <img> purely as the load/error
                  // detector (visually hidden), so the fade lifecycle is unchanged.
                  src={src()}
                  // Hero spans the full viewport width at every breakpoint.
                  sizes="100vw"
                  alt=""
                  onLoad={heroBackdrop.onLoad}
                  onError={heroBackdrop.onError}
                  class="absolute inset-0 h-full w-full object-cover transition-opacity duration-700"
                  style={{
                    opacity: heroBackdrop.state() === "loaded" && !heroCropStyle() ? "1" : "0",
                  }}
                />
                {/* Cropped backdrop region — the organiser's pan/zoom over the same
                  server-blurred source. Rendered only when a crop is set; fades in
                  with the same lifecycle as the plain <img>. */}
                <Show when={heroCropStyle()}>
                  {(cropStyle) => (
                    <div
                      aria-hidden="true"
                      class="absolute inset-0 h-full w-full bg-cover transition-opacity duration-700"
                      style={{
                        ...cropStyle(),
                        opacity: heroBackdrop.state() === "loaded" ? "1" : "0",
                      }}
                    />
                  )}
                </Show>
              </Show>
            )}
          </Show>
          {/* Scrim over the blurred backdrop so the gold title stays readable over
            any uploaded photo (a bright blurred image would otherwise wash out the
            text). Slightly stronger at centre than the original gradient-only hero
            since a blurred photo can carry more mid-tone luminance than the dark
            default gradient — keeps WCAG contrast on the title. */}
          {/* In flow (not absolute) so the title block sets the hero's height
              once it outgrows the viewport; min-h-dvh keeps the full-screen
              feel for every normal-length title. */}
          <div class="relative flex min-h-dvh flex-col items-center justify-center bg-[radial-gradient(ellipse_at_center,var(--invite-scrim-from)_0%,var(--invite-scrim-to)_100%)] px-[max(1.5rem,env(safe-area-inset-left))] py-[max(1.5rem,env(safe-area-inset-top))]">
            {/* Title block. A title legibility panel sits behind the title +
              monogram, driven by the two backdrop sliders: its opacity (0–100 ⇒
              0–1) controls how solid the dark scrim panel is, and its blur (0–20px)
              a frosted-glass `backdrop-filter`. Opacity 0 (default) ⇒ NO panel —
              just the radial scrim (the original look) via a layout-only wrapper.
              The panel colour is the theme surface (emitted only when the organiser
              set a validated colour) else a dark scrim, applied at the chosen
              opacity. TODO(future): auto contrast-check the title colour vs the
              image and auto-tune the panel — see cire/wiki/todo/future.md. */}
            <div
              class="flex max-w-full flex-col items-center gap-4"
              classList={{
                "rounded-2xl px-[clamp(1.5rem,6vw,4rem)] py-[clamp(1.25rem,5vw,3rem)]":
                  showTitleBackdrop(),
              }}
              style={
                showTitleBackdrop()
                  ? {
                      // Theme surface colour when set, else a dark scrim, applied at
                      // the slider opacity (÷100). `color-mix` blends the surface
                      // with transparent so any validated theme colour honours the
                      // opacity too. Both `backdrop-filter` spellings for Safari.
                      "background-color": `color-mix(in oklab, var(--invite-panel) ${titleBackdropOpacity()}%, transparent)`,
                      "backdrop-filter": `blur(${titleBackdropBlur()}px)`,
                      "-webkit-backdrop-filter": `blur(${titleBackdropBlur()}px)`,
                    }
                  : undefined
              }
            >
              <Show
                when={hero()?.title}
                // Neutral fallback for a shown hero with no couple title (an
                // image/subtitle-only hero). Previously the bespoke "V & R"
                // monogram — a multi-tenant product must never default to one
                // couple's initials.
                fallback={
                  <span class="font-display text-gold max-w-full pb-1 text-center text-[clamp(2.5rem,8vw,5.5rem)] leading-[1.1] font-light break-words select-none">
                    You're Invited
                  </span>
                }
              >
                {(title) => (
                  // leading-[1.1] + pb-1, never leading-none: at 7rem a name
                  // with a descender (Jyoti, Peggy, Raj) loses its tail to the
                  // line box otherwise, on the one word the page exists for.
                  <span class="font-display text-gold max-w-full pb-1 text-center text-[clamp(3rem,10vw,7rem)] leading-[1.1] font-light break-words select-none">
                    {title()}
                  </span>
                )}
              </Show>
              <Show when={hero()?.subtitle}>
                {(subtitle) => (
                  <p class="font-body text-gold-dim max-w-full text-center text-[0.8rem] tracking-[0.25em] break-words uppercase">
                    {subtitle()}
                  </p>
                )}
              </Show>
            </div>
          </div>
        </section>
      </Show>

      <Show when={showStory()}>
        <section
          class="border-border border-y px-6 py-16 md:px-8 md:py-20"
          style={{ ...filterThemeVars(storyVars()), ...SECTION_SURFACE }}
        >
          {/*
            Two-column on laptop/desktop when a story image exists — image LEFT,
            text RIGHT, vertically centred with a comfortable gap. The image
            wrapper is `hidden md:block`, so on mobile the photo is never laid
            out and the text block falls back to the single centred column. With
            no story image the wrapper collapses (image-less grid renders one
            cell), so the text spans the full width at every breakpoint.
          */}
          <div
            class="group/story mx-auto grid max-w-[540px] items-center gap-10 text-center md:max-w-[640px] data-[has-image=true]:md:max-w-[960px] data-[has-image=true]:md:grid-cols-2 data-[has-image=true]:md:gap-14 data-[has-image=true]:md:text-left"
            data-has-image={storyImageUrl() ? "true" : "false"}
          >
            <Show when={storyImageUrl()}>
              {(url) => {
                // When the organiser cropped the story photo, render the cropped
                // region via the shared CSS fraction technique (a `card`-variant
                // background — backgrounds can't use srcset, so we pick the size
                // that comfortably covers the ~480px column at retina). With no
                // crop, keep the responsive <img srcset> + object-cover (unchanged).
                const cropStyle = () =>
                  cropBackgroundStyle(variantSrc(url(), "card"), story()?.imageCrop);
                return (
                  <Show
                    when={cropStyle()}
                    fallback={
                      <img
                        src={url()}
                        // Story photo renders at most 480px wide — thumb/card cover it.
                        srcset={buildSrcSet(url(), ["thumb", "card"])}
                        sizes="(min-width: 768px) 480px, 100vw"
                        alt=""
                        // Hidden below md — the photo is not even laid out on mobile.
                        class="border-border hidden max-h-[420px] w-full rounded-sm border object-cover md:block"
                      />
                    }
                  >
                    {(style) => (
                      <div
                        aria-hidden="true"
                        // The box adopts the crop's TRUE pixel aspect (from its
                        // captured source dims) so the uniformly-scaled region fills
                        // it with no distortion and no empty bars. A legacy crop (no
                        // dims) falls back to the story default 3∶2. Hidden below md,
                        // like the <img> path.
                        class="border-border hidden max-h-[420px] w-full overflow-hidden rounded-sm border md:block"
                        style={{
                          ...style(),
                          "aspect-ratio": String(
                            cropAspectRatio(story()?.imageCrop, STORY_DEFAULT_ASPECT),
                          ),
                        }}
                      />
                    )}
                  </Show>
                );
              }}
            </Show>
            <div>
              <p class="font-body text-gold mb-3 text-[0.72rem] tracking-[0.2em] uppercase">
                {story()?.eyebrow ?? "Our Story"}
              </p>
              <h2 class="font-display text-text mb-5 text-[clamp(2rem,5vw,3rem)] leading-[1.15] font-light">
                {story()?.heading ?? "How It All Began"}
              </h2>
              <div class="mx-auto max-w-[480px] group-data-[has-image=true]/story:md:mx-0">
                <Show
                  when={story()?.body}
                  // Neutral fallback for a shown story with no body (heading- or
                  // image-only). Previously the original couple's bespoke story
                  // — a multi-tenant product must never default to one couple's
                  // personal copy.
                  fallback={
                    <p class="font-body text-text-muted text-[0.95rem] leading-[1.75] font-light">
                      Every love story is beautiful, and we can't wait to celebrate the next chapter
                      of ours with the people we love most. Thank you for being part of our day — it
                      wouldn't be the same without you.
                    </p>
                  }
                >
                  {(body) => (
                    <p class="font-body text-text-muted text-[0.95rem] leading-[1.75] font-light whitespace-pre-line">
                      {body()}
                    </p>
                  )}
                </Show>
              </div>
            </div>
          </div>
        </section>
      </Show>
    </>
  );
}
