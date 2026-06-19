import { createEffect, createResource, createSignal, onMount, Show } from "solid-js";

import { isHeroEmpty, isStoryEmpty } from "./invite-emptiness";
import { type InviteTheme, sectionThemeVars } from "./invite-theme";

/**
 * Responsive variant widths the API can transform an invite image to. Mirrors
 * the bounded `IMAGE_VARIANTS` allowlist in `cire/api` — the API resolves an
 * unknown/absent `?variant=` (and any environment without the Cloudflare Images
 * binding) to the original bytes, so the plain `src` below always works as a
 * progressive fallback even when `srcset` is ignored or transforms are off.
 *
 * `hero-bg` is the 1600px hero width rendered with a SERVER-SIDE blur (the radius
 * is a server constant — `VARIANT_BLUR` in `cire/api`, never sent from here): the
 * soft full-bleed backdrop the hero title sits over. The blur abstracts detail,
 * so one width is enough for the backdrop — no responsive `srcset` needed.
 */
const VARIANT_WIDTHS = { thumb: 320, card: 800, hero: 1600, "hero-bg": 1600 } as const;
type VariantName = keyof typeof VARIANT_WIDTHS;

/**
 * Build a `srcset` from a base image URL (which already carries the `?v=`
 * content-version cache-buster) by appending the bounded `&variant=` for each
 * width in `variants`. The browser picks the entry matching the rendered size +
 * DPR; the API negotiates WebP/AVIF per request via Accept.
 */
export function buildSrcSet(baseUrl: string, variants: readonly VariantName[]): string {
  const sep = baseUrl.includes("?") ? "&" : "?";
  return variants.map((v) => `${baseUrl}${sep}variant=${v} ${VARIANT_WIDTHS[v]}w`).join(", ");
}

/**
 * Point a base image URL at a single bounded `variant` (no width descriptor — for
 * a fixed-purpose `src`, like the blurred hero backdrop). The variant name is the
 * only thing appended; the blur radius lives server-side, keyed off the variant.
 */
export function variantSrc(baseUrl: string, variant: VariantName): string {
  const sep = baseUrl.includes("?") ? "&" : "?";
  return `${baseUrl}${sep}variant=${variant}`;
}

// Styles that consume the per-section CSS variables with a built-in-token
// fallback, so an unset variable resolves to the original gold / surface /
// display values. `--invite-*` is only ever set to a validated value (see
// sectionThemeVars). Hoisted to module scope — they're constant string literals.
const ACCENT_TEXT = { color: "var(--invite-accent, var(--color-gold))" };
// Dimmed accent (the original `text-gold-dim` is gold at 0.35 alpha). Applying
// the accent colour at 0.35 element opacity reproduces that for any accent.
const ACCENT_TEXT_DIM = { color: "var(--invite-accent, var(--color-gold))", opacity: "0.35" };
const HEADING_FONT = { "font-family": "var(--invite-heading, var(--font-display))" };
const STORY_SURFACE = {
  "background-color": "var(--invite-surface, var(--color-surface))",
  "font-family": "var(--invite-body, var(--font-body))",
};

/**
 * Hero display options the organiser picked, as they arrive from the public
 * invite endpoint. Always concrete (the API coalesces a missing row to the
 * today's-look default), but typed defensively as a closed union of strings —
 * an unknown value (stale client / future option) falls through to the current
 * look. Mirrors `HeroDisplay` in `cire/api/src/services/invite.ts`.
 *
 *  - `imageStyle`: `"blurred"` ⇒ the soft `hero-bg` backdrop (default — today's
 *    look); `"regular"` ⇒ the sharp full-bleed `hero` variant.
 *  - `titleBackdrop`: `"none"` ⇒ just the radial scrim (default); `"solid"` ⇒ a
 *    translucent panel behind the title block for legibility over a busy photo.
 */
export interface HeroDisplay {
  imageStyle: "blurred" | "regular";
  titleBackdrop: "none" | "solid";
}

export interface InviteCustomisation {
  hero: { title: string | null; subtitle: string | null; imageUrl: string | null };
  story: {
    eyebrow: string | null;
    heading: string | null;
    body: string | null;
    imageUrl: string | null;
  };
  heroDisplay: HeroDisplay;
  theme: InviteTheme;
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
  // Hero display options (organiser choice), defaulting to today's look when the
  // field is absent (older API / mid-deploy). `regular` swaps the soft `hero-bg`
  // backdrop for the sharp full-bleed `hero` variant; `solid` adds a legibility
  // panel behind the title block.
  const heroImageStyle = () => data()?.heroDisplay?.imageStyle ?? "blurred";
  const heroTitleBackdrop = () => data()?.heroDisplay?.titleBackdrop ?? "none";
  // The served variant the hero backdrop requests, per the organiser's choice.
  // Both variants exist + serve 200 in the API (IMAGE_VARIANTS); `hero-bg` is the
  // server-blurred backdrop, `hero` the sharp 1600px full-bleed image.
  const heroVariant = (): VariantName => (heroImageStyle() === "regular" ? "hero" : "hero-bg");

  // Per-section CSS-variable maps. Each only contains the variables the organiser
  // actually set (and that passed validation); an absent variable falls through
  // to the built-in token via the `var(--invite-*, <default>)` fallbacks below,
  // so an un-themed (or partially-themed) invite renders exactly as before.
  const heroVars = () => sectionThemeVars(theme(), "hero");
  const storyVars = () => sectionThemeVars(theme(), "story");

  // Conditional-segment gates. A hero with no image, no title and no subtitle
  // would paint an empty full-screen section (including the built-in "V & R"
  // default), so we render NOTHING for it. The story hides when its heading,
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

  // Hero backdrop load lifecycle. The image fades in on `loaded`; on `error` (a
  // 404'd / unreachable image) we DROP it entirely so the gradient base layer
  // shows through, instead of leaving a permanently-invisible 0-opacity <img>
  // pinned over the gradient (the old single-`onLoad` gate had no failure path,
  // so any failed load left the hero blank). `pending` keeps it at 0 opacity only
  // until the first load/error event resolves.
  type HeroState = "pending" | "loaded" | "error";
  const [heroState, setHeroState] = createSignal<HeroState>("pending");

  // The full `src` the hero backdrop currently shows — variant-resolved, so a
  // change of EITHER the base URL (a freshly uploaded image) OR the variant
  // (organiser flips blurred↔regular) re-arms the lifecycle. Built once here so
  // the <img src> and the re-arm effect can never disagree.
  const heroBackdropSrc = (): string | null => {
    const url = heroImageUrl();
    return url ? variantSrc(url, heroVariant()) : null;
  };

  // SSR-hydration fix: on an SSR page the browser starts loading the server-
  // rendered <img> during HTML parse, and its `load` event commonly fires BEFORE
  // this Solid island hydrates and attaches `onLoad` — so `onLoad` would never
  // run and the image stays at opacity 0 forever. We hold a ref and, on mount,
  // check `complete && naturalWidth > 0`: if the browser already finished
  // loading, mark it loaded immediately. `onLoad`/`onError` still cover the
  // not-yet-loaded path.
  let heroImgEl: HTMLImageElement | undefined;
  const revealIfAlreadyLoaded = () => {
    const el = heroImgEl;
    if (el && el.complete && el.naturalWidth > 0) setHeroState("loaded");
  };
  onMount(revealIfAlreadyLoaded);

  // Re-arm the lifecycle ONLY when the resolved backdrop src actually changes
  // (a new upload or a variant flip). The on-mount no-store revalidation returns
  // the SAME url, so without this guard it would reset a shown image back to
  // `pending` (opacity 0) while the <img src> stays unchanged — meaning the
  // browser never re-fires `load`, leaving it stuck invisible (the live bug). On
  // a genuine src change we reset to `pending`; the new src fires a fresh `load`,
  // and the ref-check below also catches an already-cached new src.
  let prevHeroSrc: string | null | undefined;
  createEffect(() => {
    const src = heroBackdropSrc();
    if (prevHeroSrc === undefined) {
      // First run: adopt the SSR src without forcing pending (the onMount ref
      // check owns the already-loaded case).
      prevHeroSrc = src;
      return;
    }
    if (src !== prevHeroSrc) {
      prevHeroSrc = src;
      setHeroState("pending");
      // The new src may already be in the browser cache (so no `load` fires);
      // re-check the ref after the DOM updates.
      queueMicrotask(revealIfAlreadyLoaded);
    }
  });

  return (
    <>
      <Show when={showHero()}>
        <section class="relative h-dvh overflow-hidden" style={heroVars()}>
          {/* Default gradient — always present as the base layer / fallback. */}
          <div
            class="absolute inset-0 bg-cover bg-center"
            style="background: linear-gradient(160deg, oklch(27.87% 0.0393 149.62) 0%, oklch(19.96% 0.0331 147.34) 40%, oklch(22.70% 0.0275 152.78) 100%);"
          />
          {/* Custom background image, fading in over the gradient once decoded. The
            requested variant is the organiser's choice: `hero-bg` (server-blurred
            soft backdrop, the default) or `hero` (sharp full-bleed). On a failed
            load we unmount it so the gradient base layer remains — never a blank
            hero. */}
          <Show when={heroBackdropSrc()}>
            {(src) => (
              <Show when={heroState() !== "error"}>
                <img
                  ref={heroImgEl}
                  // A single fixed-purpose variant (blurred backdrop or sharp full
                  // image) — one 1600px width is enough, so no responsive srcset.
                  // The blur radius (for `hero-bg`) is a server constant keyed off
                  // the variant name, never sent from here.
                  src={src()}
                  // Hero spans the full viewport width at every breakpoint.
                  sizes="100vw"
                  alt=""
                  onLoad={() => setHeroState("loaded")}
                  onError={() => setHeroState("error")}
                  class="absolute inset-0 h-full w-full object-cover transition-opacity duration-700"
                  style={{ opacity: heroState() === "loaded" ? "1" : "0" }}
                />
              </Show>
            )}
          </Show>
          {/* Scrim over the blurred backdrop so the gold title stays readable over
            any uploaded photo (a bright blurred image would otherwise wash out the
            text). Slightly stronger at centre than the original gradient-only hero
            since a blurred photo can carry more mid-tone luminance than the dark
            default gradient — keeps WCAG contrast on the title. */}
          <div class="absolute inset-0 flex flex-col items-center justify-center bg-[radial-gradient(ellipse_at_center,oklch(0%_0_0/0.3)_0%,oklch(0%_0_0/0.55)_100%)] px-[max(1.5rem,env(safe-area-inset-left))] py-[max(1.5rem,env(safe-area-inset-top))]">
            {/* Title block. When the organiser picks the `solid` title backdrop we
              wrap it in a translucent rounded panel (theme surface colour, falling
              back to a dark scrim panel) so the title + monogram stay legible over
              a busy/sharp photo. `none` (default) keeps just the radial scrim — the
              original look — via a layout-only wrapper that adds no background.
              TODO(future): auto contrast-check the title colour vs the image and
              auto-enable the panel — see cire/wiki/todo/future.md. */}
            <div
              class="flex max-w-full flex-col items-center gap-4"
              classList={{
                "rounded-2xl px-[clamp(1.5rem,6vw,4rem)] py-[clamp(1.25rem,5vw,3rem)] backdrop-blur-sm":
                  heroTitleBackdrop() === "solid",
              }}
              style={
                heroTitleBackdrop() === "solid"
                  ? {
                      // Theme surface colour when set, else a translucent dark panel
                      // that reads on any photo. The surface var is only emitted when
                      // the organiser set a validated colour (see sectionThemeVars).
                      "background-color": "var(--invite-surface, oklch(0% 0 0 / 0.45))",
                    }
                  : undefined
              }
            >
              <Show
                when={hero()?.title}
                fallback={
                  <div class="flex max-w-full items-center gap-3 select-none">
                    <span
                      class="font-display text-gold text-[clamp(4rem,12vw,8rem)] leading-none font-light italic"
                      style={{ ...ACCENT_TEXT, ...HEADING_FONT }}
                    >
                      V
                    </span>
                    <span
                      class="font-display text-gold-dim text-[clamp(2.5rem,7vw,5rem)] leading-none font-light italic"
                      style={{ ...ACCENT_TEXT_DIM, ...HEADING_FONT }}
                    >
                      &amp;
                    </span>
                    <span
                      class="font-display text-gold text-[clamp(4rem,12vw,8rem)] leading-none font-light italic"
                      style={{ ...ACCENT_TEXT, ...HEADING_FONT }}
                    >
                      R
                    </span>
                  </div>
                }
              >
                {(title) => (
                  <span
                    class="font-display text-gold max-w-full text-center text-[clamp(3rem,10vw,7rem)] leading-none font-light break-words italic select-none"
                    style={{ ...ACCENT_TEXT, ...HEADING_FONT }}
                  >
                    {title()}
                  </span>
                )}
              </Show>
              <Show when={hero()?.subtitle}>
                {(subtitle) => (
                  <p
                    class="font-body text-gold-dim max-w-full text-center text-[0.8rem] tracking-[0.25em] break-words uppercase"
                    style={ACCENT_TEXT_DIM}
                  >
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
          class="bg-surface border-border border-y px-6 py-16 md:px-8 md:py-20"
          style={{ ...storyVars(), ...STORY_SURFACE }}
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
              {(url) => (
                <img
                  src={url()}
                  // Story photo renders at most 480px wide — thumb/card cover it.
                  srcset={buildSrcSet(url(), ["thumb", "card"])}
                  sizes="(min-width: 768px) 480px, 100vw"
                  alt=""
                  // Hidden below md — the photo is not even laid out on mobile.
                  class="border-border hidden max-h-[420px] w-full rounded-sm border object-cover md:block"
                />
              )}
            </Show>
            <div>
              <p
                class="font-body text-gold mb-3 text-[0.72rem] tracking-[0.2em] uppercase"
                style={ACCENT_TEXT}
              >
                {story()?.eyebrow ?? "Our Story"}
              </p>
              <h2
                class="font-display text-text mb-5 text-[clamp(2rem,5vw,3rem)] leading-[1.15] font-light italic"
                style={HEADING_FONT}
              >
                {story()?.heading ?? "How It All Began"}
              </h2>
              <div class="mx-auto max-w-[480px] group-data-[has-image=true]/story:md:mx-0">
                <Show
                  when={story()?.body}
                  fallback={
                    <p class="font-body text-text-muted text-[0.95rem] leading-[1.75] font-light">
                      Your love story goes here — how you met, the proposal, and everything in between. This section will be personalised with your own words and photos.
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
