import { createSignal, onMount, type Accessor } from "solid-js";

/** The hero's built-in title for a hero the organiser gave no title. */
export const HERO_FALLBACK_TITLE = "You're Invited";

/** The greeting for a household that has replied before, fully or in part. */
export const WELCOME_BACK = "Welcome back to your invite";

/** Shown to that household while it still owes replies and may still give them. */
export const REPLIES_OWED = "You still have replies to give";

/**
 * Whether the household this page holds has replied before — the hero's half
 * of the welcome panel's greeting.
 *
 * The hero and the panel are separate islands with no shared Solid root, but
 * both import this module and a page loads one instance of it, so this one
 * signal reaches both. `CLAIM_SESSION_EVENT` is not used for it: that event
 * carries nothing and asks its listeners to re-read the server, which here
 * would spend a request on every returning visit, and a hero that hydrated
 * after the event would miss it. The panel (`LoginSection`) is the only
 * writer.
 */
const [returning, setReturning] = createSignal(false);

export const returningHousehold: Accessor<boolean> = returning;

/**
 * Publish whether the page holds a returning household. Ignored in the Worker,
 * where a module-scope value would outlive the request and reach the next
 * one's HTML; the server never knows the household anyway.
 */
export function setReturningHousehold(value: boolean): void {
  if (typeof window === "undefined") return;
  setReturning(value);
}

/**
 * The hero's fallback title: "Welcome back to your invite" for a returning
 * household, "You're Invited" otherwise.
 *
 * The server always renders "You're Invited", and so does the hero's first
 * client render, which runs during hydration: hydration keeps the server's
 * text node rather than writing a string, so a different first value would
 * leave the old words on screen with nothing to change them later. The swap
 * waits for the hero's mount.
 */
export function createHeroFallbackTitle(): Accessor<string> {
  const [mounted, setMounted] = createSignal(false);
  onMount(() => setMounted(true));
  return () => (mounted() && returning() ? WELCOME_BACK : HERO_FALLBACK_TITLE);
}
