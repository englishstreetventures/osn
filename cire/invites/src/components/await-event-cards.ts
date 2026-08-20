/**
 * Hold the unlock choreography until the event cards are actually in the DOM.
 *
 * The post-claim components — `EventCard` among them — are `lazy` (P-W1), so
 * they live in their own chunk. `InvitePage` warms that chunk at idle, but a
 * guest opening their invite for the first time on a phone can easily claim
 * before an idle callback has run, and then the chunk is still in flight when
 * the claim resolves. Solid renders `<Suspense fallback={null}>` — no cards —
 * and the reveal sequence animates an EMPTY section, finds nothing to stagger,
 * and finishes; the cards slam into the layout at full opacity whenever the
 * chunk lands. That is the "the events just appear, nothing animates" bug.
 *
 * Both waits are CAPPED, and every cap is in WALL-CLOCK time. A reveal that
 * waits forever on a chunk that never arrives (offline mid-session, a stale
 * deploy) is the invisible-invite failure every other guard in this flow exists
 * to prevent, so the caller reveals anyway once the caps expire.
 */

/** Longest we wait on the post-claim chunk before revealing without its cards. */
export const CARD_CHUNK_TIMEOUT_MS = 1500;

/** Longest we then wait for SolidJS to paint the resolved cards into the DOM. */
export const CARD_RENDER_TIMEOUT_MS = 300;

/** How often we look for a rendered card while inside that render budget. */
const POLL_INTERVAL_MS = 16;

/**
 * A sleep that can be called off. The chunk race below leaves a loser every
 * time, and on the warm path that loser is a 1.5s timer holding its closure
 * alive long after the invite has been revealed (P-I4).
 */
interface CancellableSleep {
  /** Resolves when the delay is up — or never, if it was called off first. */
  readonly elapsed: Promise<void>;
  /** Clears the timer. Safe to call after it has already fired. */
  readonly cancel: () => void;
}

function sleep(ms: number): CancellableSleep {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const elapsed = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  return { elapsed, cancel: () => clearTimeout(timer) };
}

export async function awaitEventCards(
  /** The lazy component's loader — `EventCard.preload` in both design packs. */
  preload: () => Promise<void>,
  /** The events section, read lazily: it only exists once the claim renders. */
  getSection: () => HTMLElement | undefined,
): Promise<void> {
  const cap = sleep(CARD_CHUNK_TIMEOUT_MS);
  // A rejected chunk is not an error here — the caller reveals without the
  // stagger, exactly as it does when the sequence itself fails to load.
  const loaded = await Promise.race([
    preload().then(
      () => true,
      () => false,
    ),
    cap.elapsed.then(() => false),
  ]);
  cap.cancel();

  // Nothing resolved, so nothing can have rendered: polling for a card here
  // would be 300ms of dead wait bolted onto a reveal that has already been held
  // for a second and a half (P-W2).
  if (!loaded) return;

  // Resolving the chunk is not the same as having painted with it: Suspense
  // still has to re-render. Poll rather than guess a tick count, so a slow
  // device gets the frames it needs and a fast one loses nothing.
  //
  // Bounded on the CLOCK, not on iterations. This poll runs at the busiest
  // moment on the page — Solid mounting the card list while Motion drives the
  // welcome fade — and under long tasks a 16ms timer routinely returns in 50ms
  // or more, so counting ticks would quietly stretch a 300ms budget into
  // seconds on exactly the phones it was written for (P-W3).
  const deadline = Date.now() + CARD_RENDER_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (getSection()?.querySelector("[data-event-card]")) return;
    // Sequential on purpose: this is a poll, so each wait has to follow the
    // check before it.
    // eslint-disable-next-line no-await-in-loop
    await sleep(POLL_INTERVAL_MS).elapsed;
  }
}
