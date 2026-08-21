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

// The card entrance, in one place: the stagger is built from these AND the cap
// that bounds it is derived from them, so the two cannot drift. A five-event
// invite already runs 1.08s of stagger, which the flat `STEP_TIMEOUT_MS` would
// have called finished with cards still moving (P-I3).
const CARD_DURATION_S = 0.45;
const CARD_STAGGER_S = 0.12;
const CARD_STAGGER_START_S = 0.15;

/** How long the staggered entrance of `count` cards actually takes, in ms. */
function cardStaggerTimeoutMs(count: number): number {
  const seconds = CARD_STAGGER_START_S + CARD_STAGGER_S * Math.max(0, count - 1) + CARD_DURATION_S;
  // Plus the same slack a single animation gets, for a device that starts late.
  return seconds * 1000 + STEP_TIMEOUT_MS;
}

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
  /**
   * Awaited just before the events step, so the entrance has something to
   * animate. The event cards come from a `lazy` component, so on a cold cache
   * their chunk can still be in flight when the claim resolves — see
   * `awaitEventCards`, which is what the island passes here and which caps its
   * own wait. Awaiting it HERE rather than before the sequence is deliberate:
   * the wait then runs while the form fades out and alongside the layout beat
   * below, instead of on top of them, so a warm cache costs nothing and a cold
   * one usually costs nothing either. The island starts the fetch at claim
   * time, so by this point it is normally already in flight.
   *
   * Not awaited on the reduced-motion path: there is no entrance to protect
   * there, and holding a reveal back for an animation the guest has asked not
   * to see is the wrong trade.
   */
  waitForEvents?: () => Promise<void>;
}

/**
 * Runs one animation step and resolves when it is over — settled, timed out or
 * thrown. There is no value to hand back: `motion`'s `finished` resolves with
 * nothing a caller can use, and every step here is awaited only for its timing.
 * So the step is a `Promise<void>`, not an `unknown` for the caller to guess at.
 */
function tryAnimate(
  run: () => { finished: Promise<void> },
  /**
   * This step's cap. Defaults to the one-animation budget; the staggered card
   * entrance passes its own, because its length grows with the number of events
   * and a fixed cap would report it "settled" while cards were still moving.
   */
  timeoutMs: number = STEP_TIMEOUT_MS,
): Promise<void> {
  try {
    const { finished } = run();
    // Race against a cap so a stalled animation can't wedge the sequence.
    return Promise.race([
      finished,
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
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

  // 3. Reveal events section with staggered cards. There is nothing to animate
  // until the cards are in the DOM, so wait for them first — the caller caps
  // that wait — and run the layout beat ALONGSIDE it rather than after it: the
  // beat only gives the section a moment in the layout, which has nothing to do
  // with when the card chunk lands, so serialising them stacked two waits on
  // the one path that can least afford it (P-I1).
  eventsSection.style.display = "";
  await Promise.all([
    hooks?.waitForEvents?.() ?? Promise.resolve(),
    new Promise((r) => setTimeout(r, 200)),
  ]);

  // The ORDER here is the whole trick, and getting it wrong flashes. The
  // section's base is the `opacity-0` class, so writing the inline `1` BEFORE
  // starting the animation paints one full-brightness frame of the entire
  // events section — the animation commits its own first keyframe a tick later
  // and drops it back to zero, so the guest sees the invite blink in, vanish,
  // then fade in. The cards flashed for far longer: nothing hides a card (only
  // their section carries `opacity-0`), so the stagger's 150ms `startDelay`
  // left every card painted at full opacity from the moment the section became
  // visible until Motion committed its first frame.
  //
  // So the cards are hidden inline BEFORE the section can paint, both
  // animations run, and the inline end state — the real reveal, since Motion
  // v12 reverts to base styles on finish — is written once they have settled.
  // Queried AFTER both waits, never before them: a chunk that resolves inside
  // that window renders cards this loop would otherwise miss, and a missed card
  // is one that arrives at full opacity while its siblings stagger (P-I2).
  const cards = [...eventsSection.querySelectorAll<HTMLElement>("[data-event-card]")];
  for (const card of cards) card.style.opacity = "0";

  try {
    await Promise.all([
      tryAnimate(() =>
        animate(
          eventsSection,
          { opacity: [0, 1], transform: ["translateY(32px)", "translateY(0)"] },
          { duration: 0.5, ease: [0.22, 1, 0.36, 1] },
        ),
      ),
      cards.length > 0
        ? tryAnimate(
            () =>
              animate(
                cards,
                { opacity: [0, 1], transform: ["translateY(24px)", "translateY(0)"] },
                {
                  duration: CARD_DURATION_S,
                  ease: [0.22, 1, 0.36, 1],
                  delay: stagger(CARD_STAGGER_S, { startDelay: CARD_STAGGER_START_S }),
                },
              ),
            cardStaggerTimeoutMs(cards.length),
          )
        : Promise.resolve(),
    ]);
  } finally {
    // Never leave a card on the `0` written above — that is the same
    // invisible-invite failure the inline end state exists to prevent, and
    // `tryAnimate` already caps every step, so this runs even when an animation
    // stalls or throws.
    eventsSection.style.opacity = "1";
    for (const card of cards) card.style.opacity = "1";
  }
}
