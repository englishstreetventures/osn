/**
 * Gala's unlock reveal: the sequence in `components/unlock-reveal.ts`, on
 * gala's tighter timing (`[data-unlock-pack="gala"]` in `styles/global.css`),
 * to match its narrow claim panel beside a wide events column. The island
 * imports this chunk when a claim resolves.
 */
import { runUnlockReveal, type RevealHooks } from "../../components/unlock-reveal";

export type { RevealHooks } from "../../components/unlock-reveal";

/** Gala's events rise 150ms after its welcome. */
const GALA = { name: "gala", layoutBeatMs: 150 } as const;

export function unlockRevealSequence(
  welcomeEl: HTMLElement,
  eventsSection: HTMLElement,
  hooks?: RevealHooks,
): Promise<void> {
  return runUnlockReveal(GALA, welcomeEl, eventsSection, hooks);
}
