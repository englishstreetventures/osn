import { animate, stagger } from "motion";

/**
 * Motion v12 does NOT persist a keyframe animation's final value: when the
 * animation finishes, the element reverts to its base styles. The events
 * column's base is the `opacity-0` utility class, so relying on the animation
 * alone left the whole invite invisible after the reveal (guests saw no
 * events). Every step below therefore writes its end state as an inline style
 * — the keyframes only paint the transition — and each animate call is guarded
 * so a throwing or stalled animation can never hide the invite.
 *
 * Choreography differs from classic (tighter, denser rhythm to match gala's
 * narrow claim panel + wide events column) but every guard is verbatim.
 */

/** Longest we wait on one animation before the reveal proceeds without it. */
const STEP_TIMEOUT_MS = 1000;

/** True when the guest's device asks for reduced motion. */
function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * The reveal's end state, applied with no animation: claim panel form gone,
 * welcome and events visible. This is what every animated step below settles
 * on, so a reduced-motion guest sees exactly the same invite — it simply
 * arrives at once.
 */
function settleRevealed(
  loginForm: HTMLElement,
  welcomeEl: HTMLElement,
  eventsSection: HTMLElement,
) {
  loginForm.style.display = "none";
  welcomeEl.style.display = "";
  welcomeEl.style.opacity = "1";
  eventsSection.style.display = "";
  eventsSection.style.opacity = "1";
}

function tryAnimate(run: () => { finished: Promise<unknown> }): Promise<unknown> {
  try {
    const { finished } = run();
    // Race against a cap so a stalled animation can't wedge the sequence.
    return Promise.race([
      finished,
      new Promise((resolve) => setTimeout(resolve, STEP_TIMEOUT_MS)),
    ]).catch(() => {});
  } catch {
    return Promise.resolve();
  }
}

/**
 * Plays the unlock reveal sequence:
 * 1. Claim panel form fades out
 * 2. Welcome message fades in with a gold shimmer
 * 3. Events column slides up with a tight staggered card entrance
 */
export async function unlockRevealSequence(
  loginForm: HTMLElement,
  welcomeEl: HTMLElement,
  eventsSection: HTMLElement,
) {
  // Reduced motion: skip the choreography, land on the same end state.
  if (prefersReducedMotion()) {
    settleRevealed(loginForm, welcomeEl, eventsSection);
    return;
  }

  // 1. Fade out the claim panel form
  await tryAnimate(() =>
    animate(
      loginForm,
      { opacity: [1, 0], transform: ["translateY(0)", "translateY(-8px)"] },
      { duration: 0.3, ease: "easeIn" },
    ),
  );
  loginForm.style.display = "none";

  // 2. Reveal welcome message
  welcomeEl.style.display = "";
  welcomeEl.style.opacity = "1";
  void tryAnimate(() =>
    animate(
      welcomeEl,
      { opacity: [0, 1], transform: ["translateY(10px)", "translateY(0)"] },
      { duration: 0.4, ease: [0.16, 1, 0.3, 1] },
    ),
  );

  // Gold shimmer on the heading
  const heading = welcomeEl.querySelector("h2");
  if (heading) {
    void tryAnimate(() =>
      animate(
        heading,
        { opacity: [0.5, 1, 0.9, 1] },
        {
          duration: 1,
          ease: "easeInOut",
        },
      ),
    );
  }

  // 3. Reveal events column with staggered cards. The inline opacity is the
  // real reveal (it outlives the animation and overrides the `opacity-0`
  // class); the keyframes replay 0 → 1 on top of it for the entrance.
  eventsSection.style.display = "";
  await new Promise((r) => setTimeout(r, 150));
  eventsSection.style.opacity = "1";

  void tryAnimate(() =>
    animate(
      eventsSection,
      { opacity: [0, 1], transform: ["translateY(20px)", "translateY(0)"] },
      { duration: 0.4, ease: [0.16, 1, 0.3, 1] },
    ),
  );

  const cards = eventsSection.querySelectorAll("[data-event-card]");
  if (cards.length > 0) {
    void tryAnimate(() =>
      animate(
        cards as NodeListOf<HTMLElement>,
        { opacity: [0, 1], transform: ["translateY(16px)", "translateY(0)"] },
        {
          duration: 0.35,
          ease: [0.16, 1, 0.3, 1],
          delay: stagger(0.08, { startDelay: 0.1 }),
        },
      ),
    );
  }
}
