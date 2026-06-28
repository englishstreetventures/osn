import { animate, stagger } from "motion";

// The signature opening: a sealed envelope whose wax seal lifts, flap opens, and
// the hero "letter" rises into place underneath. Kept in a `*.motion.ts` file
// per the cire convention so the choreography is testable + swappable in
// isolation from the component wiring. All refs are passed in by WaxSealHero.

export interface WaxSealRefs {
  /** The envelope graphic wrapper — fades + scales away once opened. */
  stage: HTMLElement;
  /** The envelope's top flap — rotates open about its hinge. */
  flap: HTMLElement;
  /** The wax seal disc — presses in, then lifts + fades with a gold flash. */
  seal: HTMLElement;
  /** The "tap to open" hint — fades on the first interaction. */
  prompt: HTMLElement;
  /** Radial gold glow behind the seal — flashes as the seal breaks. */
  glow: HTMLElement;
  /** The hero content (headline + CTAs) — hidden until the unveil. */
  content: HTMLElement;
}

const EASE_OUT = [0.22, 1, 0.36, 1] as const;

/** Snap straight to the opened state — reduced motion or a no-JS-then-hydrate path. */
export function revealInstant(refs: WaxSealRefs): void {
  refs.stage.style.display = "none";
  refs.content.style.display = "";
  refs.content.style.opacity = "1";
  refs.content.style.transform = "none";
  for (const el of refs.content.querySelectorAll<HTMLElement>("[data-stagger]")) {
    el.style.opacity = "1";
    el.style.transform = "none";
  }
}

/** Play the full unveil. Resolves once the hero content has begun settling in. */
export async function openSeal(refs: WaxSealRefs): Promise<void> {
  const { stage, flap, seal, prompt, glow, content } = refs;

  animate(prompt, { opacity: [1, 0] }, { duration: 0.3, easing: "ease-out" });

  // The seal presses in, then a gold flash blooms as it lifts and spins away.
  await animate(
    seal,
    { transform: ["scale(1)", "scale(0.92)"] },
    {
      duration: 0.18,
      easing: "ease-in",
    },
  ).finished;
  animate(glow, { opacity: [0, 0.85, 0.35] }, { duration: 1, easing: "ease-out" });
  animate(
    seal,
    { opacity: [1, 0], transform: ["scale(0.92)", "scale(1.55) rotate(-14deg)"] },
    { duration: 0.6, easing: EASE_OUT },
  );

  // The flap swings open about its top hinge.
  animate(
    flap,
    { transform: ["rotateX(0deg)", "rotateX(-176deg)"] },
    {
      duration: 0.7,
      easing: EASE_OUT,
    },
  );

  // Envelope lifts away to uncover the letter beneath it.
  await new Promise((r) => setTimeout(r, 240));
  await animate(
    stage,
    { opacity: [1, 0], transform: ["scale(1)", "scale(1.08)"] },
    { duration: 0.55, easing: "ease-in" },
  ).finished;
  stage.style.display = "none";

  // The hero content rises in, its lines staggering up after it.
  content.style.display = "";
  animate(
    content,
    { opacity: [0, 1], transform: ["translateY(28px)", "translateY(0)"] },
    { duration: 0.7, easing: EASE_OUT },
  );
  const items = content.querySelectorAll<HTMLElement>("[data-stagger]");
  if (items.length > 0) {
    animate(
      items,
      { opacity: [0, 1], transform: ["translateY(16px)", "translateY(0)"] },
      { duration: 0.6, easing: EASE_OUT, delay: stagger(0.1, { start: 0.15 }) },
    );
  }
}
