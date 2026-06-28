import { createSignal, onCleanup, onMount, Show } from "solid-js";

import { unsplash } from "../lib/site";
import type { WaxSealRefs } from "./WaxSeal.motion";

interface WaxSealHeroProps {
  /** Background image — passed in so the markup stays config-driven. */
  heroImageId: string;
  heroImageAlt: string;
  /** Primary CTA target (organiser portal). */
  organiserUrl: string;
  /** Secondary CTA target — an external live invite, or an in-page anchor. */
  demoHref: string;
  /** True when `demoHref` is an external invitation rather than a page anchor. */
  demoIsExternal: boolean;
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * The hero. The whole first screen IS the front of a sealed envelope — a
 * full-bleed flap + body with a gold wax seal at its heart. It opens, on tap or
 * by itself after a beat, to unveil the headline and calls to action beneath.
 * The product's thesis in one gesture: a link that feels like breaking a seal.
 * Honours reduced motion (snaps open) and is keyboard-operable.
 */
export function WaxSealHero(props: WaxSealHeroProps) {
  let stageRef!: HTMLDivElement;
  let flapRef!: HTMLDivElement;
  let sealRef!: HTMLButtonElement;
  let promptRef!: HTMLParagraphElement;
  let glowRef!: HTMLDivElement;
  let contentRef!: HTMLDivElement;

  const [opened, setOpened] = createSignal(false);

  function refs(): WaxSealRefs {
    return {
      stage: stageRef,
      flap: flapRef,
      seal: sealRef,
      prompt: promptRef,
      glow: glowRef,
      content: contentRef,
    };
  }

  async function open() {
    if (opened()) return;
    setOpened(true);
    if (prefersReducedMotion()) {
      const { revealInstant } = await import("./WaxSeal.motion");
      revealInstant(refs());
      return;
    }
    const { openSeal } = await import("./WaxSeal.motion");
    await openSeal(refs());
  }

  onMount(() => {
    if (prefersReducedMotion()) {
      void open();
      return;
    }
    const timer = window.setTimeout(() => void open(), 1600);
    onCleanup(() => window.clearTimeout(timer));
  });

  function onSealKey(e: KeyboardEvent) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      void open();
    }
  }

  return (
    <section
      class="relative flex min-h-[100svh] items-center justify-center overflow-hidden px-6 py-24 text-center"
      aria-label="Cire — invitations worthy of the moment"
    >
      {/* Revealed hero backdrop: a warm celebration photo, dimmed, with a gold
          glow that blooms as the seal breaks. Sits behind everything. */}
      <div class="absolute inset-0 -z-10">
        <img
          src={unsplash(props.heroImageId, 2000)}
          alt={props.heroImageAlt}
          class="h-full w-full object-cover opacity-40"
          fetchpriority="high"
        />
        <div
          class="absolute inset-0"
          style={{
            background:
              "radial-gradient(120% 90% at 50% 30%, oklch(19.96% 0.0331 147.34 / 0.55), oklch(19.96% 0.0331 147.34 / 0.96))",
          }}
        />
      </div>
      <div
        ref={glowRef}
        aria-hidden="true"
        class="pointer-events-none absolute top-1/2 left-1/2 -z-10 h-[42rem] w-[42rem] -translate-x-1/2 -translate-y-1/2 opacity-0"
        style={{
          background: "radial-gradient(circle, oklch(74.99% 0.0854 82.08 / 0.45), transparent 60%)",
        }}
      />

      {/* The unveiled letter — hidden until the seal opens. */}
      <div ref={contentRef} class="relative mx-auto max-w-[44rem]" style={{ display: "none" }}>
        <p data-stagger class="font-body text-gold mb-5 text-[0.74rem] tracking-[0.28em] uppercase">
          Bespoke digital wedding invitations
        </p>
        <h1
          data-stagger
          class="font-display text-text text-[clamp(2.6rem,8vw,5rem)] leading-[1.05] font-light italic"
        >
          Invitations worthy
          <br />
          of the moment
        </h1>
        <p
          data-stagger
          class="font-body text-text-muted mx-auto mt-6 max-w-[34rem] text-[1.02rem] leading-[1.7] font-light"
        >
          Paper is beautiful but still. Generic e-invites are soulless. Cire is a real invitation —
          tactile, animated, personal — that also happens to track every RSVP for you.
        </p>
        <div data-stagger class="mt-10 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <a
            href={props.organiserUrl}
            class="border-gold bg-gold text-bg hover:text-gold font-body w-full rounded-sm border px-7 py-3.5 text-[0.84rem] tracking-[0.12em] uppercase transition-colors duration-200 hover:bg-transparent sm:w-auto"
          >
            Create your invitation
          </a>
          <a
            href={props.demoHref}
            target={props.demoIsExternal ? "_blank" : undefined}
            rel={props.demoIsExternal ? "noopener noreferrer" : undefined}
            class="border-border font-body text-text hover:border-gold hover:text-gold w-full rounded-sm border bg-transparent px-7 py-3.5 text-[0.84rem] tracking-[0.12em] uppercase transition-colors duration-200 sm:w-auto"
          >
            See a live invite
          </a>
        </div>
      </div>

      {/* ── THE ENVELOPE FRONT — the whole screen, sealed ─────────────────────
          Covers the viewport until opened. Clicking anywhere (or the seal, or
          the auto-timer) breaks it open. */}
      <div
        ref={stageRef}
        class="absolute inset-0 z-20 cursor-pointer"
        style={{ perspective: "1600px" }}
        onClick={() => void open()}
      >
        {/* Envelope paper — full-bleed body. */}
        <div
          class="absolute inset-0"
          style={{
            background:
              "linear-gradient(168deg, var(--color-surface-raised), var(--color-surface) 55%, var(--color-bg))",
          }}
        />
        {/* Bottom pocket seams — two hairlines rising from the corners to centre. */}
        <div
          aria-hidden="true"
          class="absolute inset-0"
          style={{
            background:
              "linear-gradient(to top right, transparent calc(50% - 0.5px), var(--color-border) 50%, transparent calc(50% + 0.5px)) left / 50% 100% no-repeat, linear-gradient(to top left, transparent calc(50% - 0.5px), var(--color-border) 50%, transparent calc(50% + 0.5px)) right / 50% 100% no-repeat",
          }}
        />
        {/* The flap — a full-width triangle hinged at the very top edge. */}
        <div
          ref={flapRef}
          aria-hidden="true"
          class="absolute inset-x-0 top-0 h-[60vh] origin-top"
          style={{
            "transform-style": "preserve-3d",
            "clip-path": "polygon(0 0, 100% 0, 50% 100%)",
            background:
              "linear-gradient(180deg, var(--color-surface-raised), var(--color-surface))",
            filter: "drop-shadow(0 2px 1px oklch(0% 0 0 / 0.25))",
          }}
        />

        {/* The wax seal, embossed with the Cire monogram, at the heart.
            TODO(design): PLACEHOLDER graphic — to be replaced by a separately
            designed wax-seal asset. Swap only the inner seal <div> below (the
            gold gradient disc + monogram); the surrounding button, layout and
            open/animation wiring stay as-is. Deferred per product — see
            wiki/apps/cire-landing.md "Deferred". */}
        <div class="absolute top-1/2 left-1/2 flex -translate-x-1/2 -translate-y-1/2 flex-col items-center">
          <button
            ref={sealRef}
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              void open();
            }}
            onKeyDown={onSealKey}
            class="block cursor-pointer rounded-full border-0 bg-transparent p-0 focus-visible:outline-none"
            aria-label="Open the invitation"
          >
            <div
              class="flex h-[7rem] w-[7rem] items-center justify-center rounded-full sm:h-[8rem] sm:w-[8rem]"
              style={{
                background:
                  "radial-gradient(circle at 38% 32%, oklch(82% 0.09 82.08), oklch(63% 0.085 70) 70%, oklch(54% 0.08 65))",
                "box-shadow":
                  "inset 0 2px 4px oklch(95% 0.05 82 / 0.5), inset 0 -4px 8px oklch(40% 0.06 60 / 0.6), 0 10px 28px oklch(0% 0 0 / 0.45)",
              }}
            >
              <span
                class="font-display text-[3.5rem] leading-none italic sm:text-[4rem]"
                style={{ color: "oklch(30% 0.04 80)" }}
              >
                C
              </span>
            </div>
          </button>
          <p
            ref={promptRef}
            class="font-body text-text-muted mt-8 text-[0.72rem] tracking-[0.24em] uppercase"
          >
            <Show when={!opened()} fallback={<span>&nbsp;</span>}>
              Tap to open
            </Show>
          </p>
        </div>
      </div>
    </section>
  );
}
