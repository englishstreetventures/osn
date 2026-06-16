import { createResource, createSignal, Show } from "solid-js";

export interface InviteCustomisation {
  hero: { title: string | null; subtitle: string | null; imageUrl: string | null };
  story: {
    eyebrow: string | null;
    heading: string | null;
    body: string | null;
    imageUrl: string | null;
  };
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
        const res = await fetch(`${props.apiUrl}/api/invite/${props.slug}`);
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

  const heroImageUrl = () => {
    const url = hero()?.imageUrl;
    return url ? `${props.apiUrl}${url}` : null;
  };
  const storyImageUrl = () => {
    const url = story()?.imageUrl;
    return url ? `${props.apiUrl}${url}` : null;
  };

  const [heroLoaded, setHeroLoaded] = createSignal(false);

  return (
    <>
      <section class="relative h-dvh overflow-hidden">
        {/* Default gradient — always present as the base layer / fallback. */}
        <div
          class="absolute inset-0 bg-cover bg-center"
          style="background: linear-gradient(160deg, oklch(27.87% 0.0393 149.62) 0%, oklch(19.96% 0.0331 147.34) 40%, oklch(22.70% 0.0275 152.78) 100%);"
        />
        {/* Custom background image, fading in over the gradient once decoded. */}
        <Show when={heroImageUrl()}>
          {(url) => (
            <img
              src={url()}
              alt=""
              onLoad={() => setHeroLoaded(true)}
              class="absolute inset-0 h-full w-full object-cover transition-opacity duration-700"
              style={{ opacity: heroLoaded() ? "1" : "0" }}
            />
          )}
        </Show>
        <div class="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-[radial-gradient(ellipse_at_center,oklch(0%_0_0/0.15)_0%,oklch(0%_0_0/0.45)_100%)]">
          <Show
            when={hero()?.title}
            fallback={
              <div class="flex items-center gap-3 select-none">
                <span class="font-display text-gold text-[clamp(4rem,12vw,8rem)] leading-none font-light italic">
                  V
                </span>
                <span class="font-display text-gold-dim text-[clamp(2.5rem,7vw,5rem)] leading-none font-light italic">
                  &amp;
                </span>
                <span class="font-display text-gold text-[clamp(4rem,12vw,8rem)] leading-none font-light italic">
                  R
                </span>
              </div>
            }
          >
            {(title) => (
              <span class="font-display text-gold px-6 text-center text-[clamp(3rem,10vw,7rem)] leading-none font-light italic select-none">
                {title()}
              </span>
            )}
          </Show>
          <Show when={hero()?.subtitle}>
            {(subtitle) => (
              <p class="font-body text-gold-dim px-6 text-center text-[0.8rem] tracking-[0.25em] uppercase">
                {subtitle()}
              </p>
            )}
          </Show>
        </div>
      </section>

      <section class="bg-surface border-border border-y px-6 py-16 md:px-8 md:py-20">
        <div class="mx-auto max-w-[540px] text-center md:max-w-[640px]">
          <Show when={storyImageUrl()}>
            {(url) => (
              <img
                src={url()}
                alt=""
                class="border-border mx-auto mb-8 max-h-80 w-full max-w-[480px] rounded-sm border object-cover"
              />
            )}
          </Show>
          <p class="font-body text-gold mb-3 text-[0.72rem] tracking-[0.2em] uppercase">
            {story()?.eyebrow ?? "Our Story"}
          </p>
          <h2 class="font-display text-text mb-5 text-[clamp(2rem,5vw,3rem)] leading-[1.15] font-light italic">
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
