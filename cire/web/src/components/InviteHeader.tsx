import { createEffect, createResource, createSignal, Show } from "solid-js";

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

export interface InviteCustomisation {
  hero: { title: string | null; subtitle: string | null; imageUrl: string | null };
  story: {
    eyebrow: string | null;
    heading: string | null;
    body: string | null;
    imageUrl: string | null;
  };
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

  // Per-section CSS-variable maps. Each only contains the variables the organiser
  // actually set (and that passed validation); an absent variable falls through
  // to the built-in token via the `var(--invite-*, <default>)` fallbacks below,
  // so an un-themed (or partially-themed) invite renders exactly as before.
  const heroVars = () => sectionThemeVars(theme(), "hero");
  const storyVars = () => sectionThemeVars(theme(), "story");

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

  // Re-arm the lifecycle whenever the backdrop URL changes (e.g. the on-mount
  // revalidation swaps in a freshly uploaded image), so a new image isn't stuck
  // at the previous load's terminal state.
  createEffect(() => {
    heroImageUrl();
    setHeroState("pending");
  });

  return (
    <>
      <section class="relative h-dvh overflow-hidden" style={heroVars()}>
        {/* Default gradient — always present as the base layer / fallback. */}
        <div
          class="absolute inset-0 bg-cover bg-center"
          style="background: linear-gradient(160deg, oklch(27.87% 0.0393 149.62) 0%, oklch(19.96% 0.0331 147.34) 40%, oklch(22.70% 0.0275 152.78) 100%);"
        />
        {/* Custom background image as a BLURRED backdrop (the server-side `hero-bg`
            variant), fading in over the gradient once decoded. On a failed load we
            unmount it so the gradient base layer remains — never a blank hero. */}
        <Show when={heroImageUrl()}>
          {(url) => (
            <Show when={heroState() !== "error"}>
              <img
                // Single blurred backdrop variant — blur abstracts detail, so one
                // 1600px width is enough; no responsive srcset needed. The blur
                // radius is a server constant keyed off this variant name.
                src={variantSrc(url(), "hero-bg")}
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
        <div class="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-[radial-gradient(ellipse_at_center,oklch(0%_0_0/0.3)_0%,oklch(0%_0_0/0.55)_100%)] px-[max(1.5rem,env(safe-area-inset-left))] py-[max(1.5rem,env(safe-area-inset-top))]">
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
      </section>

      <section
        class="bg-surface border-border border-y px-6 py-16 md:px-8 md:py-20"
        style={{ ...storyVars(), ...STORY_SURFACE }}
      >
        <div class="mx-auto max-w-[540px] text-center md:max-w-[640px]">
          <Show when={storyImageUrl()}>
            {(url) => (
              <img
                src={url()}
                // Story photo renders at most 480px wide — thumb/card cover it.
                srcset={buildSrcSet(url(), ["thumb", "card"])}
                sizes="(min-width: 480px) 480px, 100vw"
                alt=""
                class="border-border mx-auto mb-8 max-h-80 w-full max-w-[480px] rounded-sm border object-cover"
              />
            )}
          </Show>
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
          <div class="mx-auto max-w-[480px]">
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
      </section>
    </>
  );
}
