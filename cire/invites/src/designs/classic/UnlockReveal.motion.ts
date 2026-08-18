import { animate, stagger } from "motion";

/**
 * Motion v12 does NOT persist a keyframe animation's final value: when the
 * animation finishes, the element reverts to its base styles. The events
 * section's base is the `opacity-0` utility class, so relying on the animation
 * alone left the whole invite invisible after the reveal (guests saw no
 * events). Every step below therefore writes its end state as an inline style
 * — the keyframes only paint the transition — and each animate call is guarded
 * so a throwing or stalled animation can never hide the invite.
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
 * The reveal's end state, applied with no animation: login form gone, welcome
 * and events visible. This is what every animated step below settles on, so a
 * reduced-motion guest sees exactly the same invite — it simply arrives at once.
 *
 * Note what this does NOT touch: the `display` of the login form and the welcome
 * banner. Those two belong to SolidJS, which drives them from the island's
 * `revealed` signal — see {@link RevealHooks}.
 */
function settleRevealed(welcomeEl: HTMLElement, eventsSection: HTMLElement, hooks?: RevealHooks) {
  hooks?.onFormHidden?.();
  welcomeEl.style.opacity = "1";
  eventsSection.style.display = "";
  eventsSection.style.opacity = "1";
}

/**
 * The one thing this sequence cannot do itself: swap the code form out for the
 * welcome banner.
 *
 * Both elements' `display` is a reactive SolidJS binding, and Solid diffs a
 * style binding against the last value IT wrote. So an imperative
 * `loginForm.style.display = "none"` from here does not just duplicate the
 * binding — it desynchronises it: Solid still believes `display` is `""`, and
 * every later attempt to restore the form is a no-op it skips. The form could
 * never be shown again for the life of the page. That is latent rather than live
 * today only because nothing sets `claimResult` back to `null`; a sign-out or a
 * rolled-back claim would surface it immediately.
 *
 * So the sequence reports the moment instead of performing it, and the island
 * flips one signal. One owner for `display`, and the choreography also gets the
 * fade it was written for: the form is still on screen while step 1 runs,
 * whereas the old arrangement had Solid hide it the instant the claim resolved —
 * a beat before this ran — leaving the fade-out animating an invisible element.
 */
export interface RevealHooks {
  /** Fired once the code form has faded out and should leave the layout. */
  onFormHidden?: () => void;
}

/**
 * Runs one animation step and resolves when it is over — settled, timed out or
 * thrown. There is no value to hand back: `motion`'s `finished` resolves with
 * nothing a caller can use, and every step here is awaited only for its timing.
 * So the step is a `Promise<void>`, not an `unknown` for the caller to guess at.
 */
function tryAnimate(run: () => { finished: Promise<void> }): Promise<void> {
  try {
    const { finished } = run();
    // Race against a cap so a stalled animation can't wedge the sequence.
    return Promise.race([
      finished,
      new Promise<void>((resolve) => setTimeout(resolve, STEP_TIMEOUT_MS)),
    ]).catch(() => {});
  } catch {
    return Promise.resolve();
  }
}

/**
 * Plays the unlock reveal sequence:
 * 1. Login form fades out
 * 2. Welcome message fades in with a gold shimmer
 * 3. Events section slides up with staggered card entrance
 */
export async function unlockRevealSequence(
  loginForm: HTMLElement,
  welcomeEl: HTMLElement,
  eventsSection: HTMLElement,
  hooks?: RevealHooks,
) {
  // Reduced motion: skip the choreography, land on the same end state.
  if (prefersReducedMotion()) {
    settleRevealed(welcomeEl, eventsSection, hooks);
    return;
  }

  // 1. Fade out the login form
  await tryAnimate(() =>
    animate(
      loginForm,
      { opacity: [1, 0], transform: ["translateY(0)", "translateY(-12px)"] },
      { duration: 0.35, ease: "easeIn" },
    ),
  );
  // Faded out — hand the swap back to the island, which owns `display`.
  hooks?.onFormHidden?.();

  // 2. Reveal welcome message
  welcomeEl.style.opacity = "1";
  void tryAnimate(() =>
    animate(
      welcomeEl,
      { opacity: [0, 1], transform: ["translateY(16px)", "translateY(0)"] },
      { duration: 0.5, ease: [0.22, 1, 0.36, 1] },
    ),
  );

  // Gold shimmer on the heading
  const heading = welcomeEl.querySelector("h2");
  if (heading) {
    void tryAnimate(() =>
      animate(
        heading,
        { opacity: [0.4, 1, 0.85, 1] },
        {
          duration: 1.2,
          ease: "easeInOut",
        },
      ),
    );
  }

  // 3. Reveal events section with staggered cards. The inline opacity is the
  // real reveal (it outlives the animation and overrides the `opacity-0`
  // class); the keyframes replay 0 → 1 on top of it for the entrance.
  eventsSection.style.display = "";
  await new Promise((r) => setTimeout(r, 200));
  eventsSection.style.opacity = "1";

  void tryAnimate(() =>
    animate(
      eventsSection,
      { opacity: [0, 1], transform: ["translateY(32px)", "translateY(0)"] },
      { duration: 0.5, ease: [0.22, 1, 0.36, 1] },
    ),
  );

  const cards = eventsSection.querySelectorAll("[data-event-card]");
  if (cards.length > 0) {
    void tryAnimate(() =>
      animate(
        cards as NodeListOf<HTMLElement>,
        { opacity: [0, 1], transform: ["translateY(24px)", "translateY(0)"] },
        {
          duration: 0.45,
          ease: [0.22, 1, 0.36, 1],
          delay: stagger(0.12, { startDelay: 0.15 }),
        },
      ),
    );
  }
}
