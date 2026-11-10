/**
 * Classic's unlock reveal: the sequence in `components/unlock-reveal.ts`, on
 * classic's timing (`[data-unlock-pack="classic"]` in `styles/global.css`).
 * The island imports this chunk when a claim resolves.
 */
import { runUnlockReveal, type RevealHooks } from "../../components/unlock-reveal";

export type { RevealHooks } from "../../components/unlock-reveal";

/** Classic's full-bleed band settles for 200ms before its events rise. */
const CLASSIC = { name: "classic", layoutBeatMs: 200 } as const;

export function unlockRevealSequence(
  loginForm: HTMLElement,
  welcomeEl: HTMLElement,
  eventsSection: HTMLElement,
  hooks?: RevealHooks,
): Promise<void> {
  return runUnlockReveal(CLASSIC, loginForm, welcomeEl, eventsSection, hooks);
}
