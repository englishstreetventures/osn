import { createSignal, For, onMount } from "solid-js";

interface PulseHeroProps {
  /** Primary CTA target — the Pulse app. */
  appUrl: string;
  /** Secondary CTA target — an in-page anchor (e.g. "#how-it-works"). */
  howHref: string;
}

/** Coarse, IP-derived location from the `/api/geo` Pages Function. */
interface Geo {
  city: string | null;
  region: string | null;
  country: string | null;
  count: number | null;
}

// A few playful "live" event-card chips that float around the headline. Pure
// decoration — bounded, fun, on-brand. Each maps to a category colour token.
const CHIPS = [
  { tag: "MUSIC", title: "Rooftop DJ set", meta: "Tonight · 9pm", color: "var(--cat-1)" },
  { tag: "FOOD", title: "Night market", meta: "0.4 mi away", color: "var(--cat-5)" },
  { tag: "ARTS", title: "Late gallery", meta: "Fri · 7pm", color: "var(--cat-4)" },
  { tag: "SPORT", title: "Sunrise run", meta: "Sat · 6am", color: "var(--cat-6)" },
] as const;

/**
 * The hero — editorial and lively. An Instrument Serif headline with an italic
 * accent word (the DESIGN.md hero pattern), a Geist subhead, and two CTAs. The
 * pulsing-dot energy comes from the page-wide {@link PulseField} behind it.
 *
 * All content is server-rendered visible (the entrance is a pure-CSS animation,
 * `.pulse-rise`), so the hero never depends on JS to appear. Hydration only
 * *enhances* it: a one-shot fetch to the `/api/geo` Pages Function turns the
 * generic line + CTA into a location-aware "{n} events around {region}" hook
 * that sends the visitor to their nearest city. No geo (no JS, fetch fails, or
 * the function is absent) → the generic "near you" copy simply stays.
 */
export function PulseHero(props: PulseHeroProps) {
  const [geo, setGeo] = createSignal<Geo | null>(null);

  onMount(() => {
    if (typeof fetch !== "function") return;
    try {
      void fetch("/api/geo")
        .then((r) => (r.ok ? r.json() : null))
        .then((d: Geo | null) => {
          if (d && (d.city || d.region)) setGeo(d);
          return null;
        })
        .catch(() => {
          /* keep the generic fallback */
        });
    } catch {
      /* keep the generic fallback */
    }
  });

  // The place we headline the count with (region preferred), and the city we
  // point the CTA at. Both degrade gracefully.
  const place = () => geo()?.region ?? geo()?.city ?? null;
  const city = () => geo()?.city ?? geo()?.region ?? null;
  const count = () => geo()?.count ?? null;

  const countLabel = () => {
    const p = place();
    const n = count();
    if (p && n) return `${n} events around ${p} right now`;
    if (p) return `Events happening around ${p} right now`;
    return "Live events happening near you right now";
  };

  const ctaLabel = () => (city() ? `What’s on in ${city()}` : "Find events");
  const ctaHref = () => {
    const c = city();
    return c ? `${props.appUrl}?near=${encodeURIComponent(c)}` : props.appUrl;
  };

  return (
    <section
      class="relative flex min-h-[100svh] flex-col items-center justify-center overflow-hidden px-6 py-24 text-center"
      aria-label="Pulse — find your scene"
    >
      {/* Soft coral bloom behind the headline. */}
      <div
        aria-hidden="true"
        class="pointer-events-none absolute top-1/2 left-1/2 -z-10 h-[40rem] w-[40rem] -translate-x-1/2 -translate-y-1/2"
        style={{
          background: "radial-gradient(circle, var(--pulse-accent-soft), transparent 62%)",
          opacity: "0.7",
        }}
      />

      {/* Floating event chips — hidden on small screens, decorative on large. */}
      <div aria-hidden="true" class="pointer-events-none absolute inset-0 hidden lg:block">
        <For each={CHIPS}>
          {(chip, i) => (
            <div
              class="pulse-rise absolute rounded-xl border bg-[var(--color-surface-raised)] px-3.5 py-2.5 text-left shadow-sm"
              style={{
                "border-color": "var(--color-border)",
                top: ["14%", "22%", "64%", "70%"][i()],
                left: ["10%", "78%", "8%", "80%"][i()],
                "animation-delay": `${300 + i() * 140}ms`,
              }}
            >
              <p
                class="font-mono text-[0.6rem] tracking-[0.18em] uppercase"
                style={{ color: chip.color }}
              >
                {chip.tag}
              </p>
              <p class="font-body text-[0.9rem] font-semibold text-[var(--color-text)]">
                {chip.title}
              </p>
              <p class="font-mono text-[0.65rem] text-[var(--color-text-muted)]">{chip.meta}</p>
            </div>
          )}
        </For>
      </div>

      <div class="pulse-rise relative mx-auto w-full max-w-[46rem]">
        <p class="mb-5 inline-flex items-center gap-2 font-mono text-[0.72rem] tracking-[0.28em] text-[var(--pulse-accent-strong)] uppercase">
          <span class="dot-mark" aria-hidden="true" />
          What&rsquo;s happening near you
        </p>
        <h1 class="font-display text-[clamp(2.2rem,8vw,5rem)] leading-[1.05] font-normal text-balance text-[var(--color-text)]">
          Find what&rsquo;s <span class="text-[var(--pulse-accent)] italic">happening</span>{" "}
          tonight.
        </h1>
        <p class="font-body mx-auto mt-6 max-w-[34rem] text-[1.05rem] leading-[1.7] text-[var(--color-text-muted)]">
          Discover events by location, category, friends and interests. RSVP in a tap, keep everyone
          in the loop, and let your calendar do the remembering.
        </p>

        {/* Location-aware "what's on near you" line (IP geo, not account data). */}
        <p
          class="mx-auto mt-8 inline-flex items-center gap-2 font-mono text-[0.7rem] tracking-[0.14em] text-[var(--color-text-muted)] uppercase"
          aria-live="polite"
        >
          <span class="dot-mark" aria-hidden="true" />
          {countLabel()}
        </p>

        <div class="mt-7 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <a
            href={ctaHref()}
            class="font-body w-full rounded-full bg-[var(--pulse-accent)] px-7 py-3.5 text-[0.9rem] font-semibold text-[var(--color-bg)] transition-transform duration-200 hover:scale-[1.03] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--pulse-accent-strong)] sm:w-auto"
          >
            {ctaLabel()}
          </a>
          <a
            href={props.howHref}
            class="font-body w-full rounded-full border border-[var(--color-border)] bg-transparent px-7 py-3.5 text-[0.9rem] font-semibold text-[var(--color-text)] transition-colors duration-200 hover:border-[var(--pulse-accent)] hover:text-[var(--pulse-accent)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--pulse-accent-strong)] sm:w-auto"
          >
            How it works
          </a>
        </div>
      </div>
    </section>
  );
}
