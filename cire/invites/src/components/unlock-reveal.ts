/**
 * The unlock reveal: what a household sees once its code is accepted. The code
 * form closes at once, the welcome rises with a shimmer on its heading, then
 * the events rise with their cards one after another. The form holds a live
 * field and button, so it never fades: a fading form would still take a tap or
 * a key in a box that is going away.
 *
 * The motion is CSS (`styles/global.css`, "The unlock reveal"). This module
 * only orders it: it marks each element with the step it plays
 * (`data-unlock`) and the design pack whose timing it plays it on
 * (`data-unlock-pack`), waits for that step's animations to end, writes the
 * end state inline and takes both marks off. A CSS animation holds its last
 * frame only while its rule still matches, and the events section's base is
 * the `opacity-0` class, so without the inline end state the whole invite
 * would vanish the moment the marks come off.
 *
 * Every wait is capped and every step guarded: an animation that stalls,
 * throws or never starts (no stylesheet, a hidden element) can delay the
 * reveal by at most a second past its own end, and never hide the invite.
 */

/** A design pack's reveal. */
export interface RevealPack {
  /** Picks the pack's timing in `styles/global.css` (`[data-unlock-pack]`). */
  name: "classic" | "gala";
  /**
   * The pause between the welcome's rise and the events' step: the events
   * section takes its place in the layout first. Script waits it out, so it
   * lives here rather than in the stylesheet.
   */
  layoutBeatMs: number;
}

/**
 * The one thing this sequence cannot do itself: swap the code form out for the
 * welcome banner, the reveal's first move.
 *
 * Both elements' `display` is a reactive SolidJS binding, and Solid diffs a
 * style binding against the last value IT wrote. So an imperative
 * `style.display = "none"` on the form from here does not just duplicate the
 * binding — it desynchronises it: Solid still believes `display` is `""`, and
 * every later attempt to restore the form is a no-op it skips. The form could
 * never be shown again for the life of the page.
 *
 * So the sequence reports the moment instead of performing it, and the island
 * flips one signal. One owner for `display`.
 */
export interface RevealHooks {
  /**
   * Fired once, before any step: the code form leaves the layout and the
   * welcome takes its place. The welcome's step starts straight after, and a
   * CSS animation never starts on a `display: none` element, so the island
   * must apply the swap before this returns.
   */
  onFormHidden?: () => void;
  /**
   * Awaited just before the events step, so the entrance has something to
   * animate. The event cards come from a `lazy` component, so on a cold cache
   * their chunk can still be in flight when the claim resolves — see
   * `awaitEventCards`, which is what the island passes here and which caps its
   * own wait. Awaiting it HERE rather than before the sequence is deliberate:
   * the wait then runs alongside the welcome's rise and the layout beat,
   * instead of on top of them, so a warm cache costs nothing and a cold one
   * usually costs nothing either. The island starts the fetch at claim time,
   * so by this point it is normally already in flight.
   *
   * Not awaited on the reduced-motion path: there is no entrance to protect
   * there, and holding a reveal back for an animation the guest has asked not
   * to see is the wrong trade.
   */
  waitForEvents?: () => Promise<void>;
}

/** The steps `global.css` styles under `[data-unlock]`. */
type Step = "welcome" | "shimmer" | "section" | "card";

/** How long past a step's own end the sequence waits before going on without it. */
const SLACK_MS = 1000;

/** True when the guest's device asks for reduced motion. */
function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * The reveal's end state, applied with no animation: code form gone, welcome
 * and events visible. Every animated step below settles on the same state, so
 * a reduced-motion guest sees exactly the same invite — it simply arrives at
 * once. The `display` of the form and the welcome stays with SolidJS
 * ({@link RevealHooks}).
 */
function settleRevealed(welcomeEl: HTMLElement, eventsSection: HTMLElement, hooks?: RevealHooks) {
  hooks?.onFormHidden?.();
  welcomeEl.style.opacity = "1";
  eventsSection.style.display = "";
  eventsSection.style.opacity = "1";
}

/** The reveal's own animations, by the `unlock-` prefix its keyframes share. */
function isRevealAnimation(animation: Animation): boolean {
  return (
    "animationName" in animation &&
    typeof animation.animationName === "string" &&
    animation.animationName.startsWith("unlock-")
  );
}

/** When an animation ends, delay included, in ms from its start. */
function endTimeOf(animation: Animation): number {
  return Number(animation.effect?.getComputedTiming().endTime) || 0;
}

/**
 * Starts `step` on `elements` and resolves when it is over: finished, capped,
 * cancelled or thrown. With no animation to wait for — no stylesheet, or an
 * element out of the layout — it resolves at once.
 */
function play(pack: RevealPack, step: Step, elements: readonly HTMLElement[]): Promise<void> {
  try {
    for (const el of elements) {
      el.dataset.unlockPack = pack.name;
      el.dataset.unlock = step;
    }
    // `getAnimations` brings style up to date, so the step's animations exist
    // by the time it returns. jsdom has none.
    const animations = elements.flatMap((el) =>
      typeof el.getAnimations === "function" ? el.getAnimations().filter(isRevealAnimation) : [],
    );
    if (animations.length === 0) return Promise.resolve();
    // Capped from the step's own end, so a long stagger is not cut short.
    const cap = Math.max(...animations.map(endTimeOf)) + SLACK_MS;
    return Promise.race([
      Promise.all(animations.map((animation) => animation.finished)).then(() => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, cap)),
    ]).catch(() => {});
  } catch {
    return Promise.resolve();
  }
}

/** Takes the step's marks off, ending its animations with them. */
function release(elements: readonly HTMLElement[]) {
  for (const el of elements) {
    delete el.dataset.unlock;
    delete el.dataset.unlockPack;
    el.style.removeProperty("--unlock-i");
  }
}

/**
 * Plays the unlock reveal on `pack`'s timing:
 * 1. the code form closes at once, through `hooks.onFormHidden`;
 * 2. the welcome rises, and its heading shimmers;
 * 3. after the layout beat, the events rise, their cards one after another.
 */
export async function runUnlockReveal(
  pack: RevealPack,
  welcomeEl: HTMLElement,
  eventsSection: HTMLElement,
  hooks?: RevealHooks,
) {
  // Reduced motion: no step at all, the same end state.
  if (prefersReducedMotion()) {
    settleRevealed(welcomeEl, eventsSection, hooks);
    return;
  }

  // 1. The form closes at once, and the welcome is in the layout to rise.
  hooks?.onFormHidden?.();

  // 2. The welcome rises and its heading shimmers, neither awaited: the
  // events' step starts on the beat, not when these end.
  welcomeEl.style.opacity = "1";
  void play(pack, "welcome", [welcomeEl]).then(() => release([welcomeEl]));
  const heading = welcomeEl.querySelector("h2");
  if (heading) void play(pack, "shimmer", [heading]).then(() => release([heading]));

  // 3. The events. Wait for the cards to be in the DOM — the caller caps that
  // wait — alongside the layout beat rather than after it: the beat only gives
  // the section a moment in the layout, which has nothing to do with when the
  // card chunk lands.
  eventsSection.style.display = "";
  await Promise.all([
    hooks?.waitForEvents?.() ?? Promise.resolve(),
    new Promise((resolve) => setTimeout(resolve, pack.layoutBeatMs)),
  ]);

  // Queried after both waits, so a card that rendered during them is in the
  // step. Only the section carries `opacity-0`, so each card is hidden inline
  // before the section can paint — or it would show at full opacity until its
  // own delay ends — and given its place in the stagger.
  const cards = [...eventsSection.querySelectorAll<HTMLElement>("[data-event-card]")];
  cards.forEach((card, index) => {
    card.style.opacity = "0";
    card.style.setProperty("--unlock-i", String(index));
  });

  try {
    await Promise.all([play(pack, "section", [eventsSection]), play(pack, "card", cards)]);
  } finally {
    // Never leave the section on its `opacity-0` class or a card on the `0`
    // written above: that is an invisible invite. Every step is capped, so
    // this runs even when an animation stalls or throws.
    eventsSection.style.opacity = "1";
    for (const card of cards) card.style.opacity = "1";
    release([eventsSection, ...cards]);
  }
}
