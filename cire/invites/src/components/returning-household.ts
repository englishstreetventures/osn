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
 * Whether the hero's fallback title shows "Welcome back to your invite" rather
 * than "You're Invited": true for a returning household, once the hero has
 * mounted.
 *
 * The server always shows "You're Invited", and so does the hero's first
 * client render, which runs during hydration: hydration keeps the server's
 * attributes rather than writing them (`setAttribute` and `className` return
 * early while hydrating), so a different first value would leave the server's
 * choice on screen with nothing to change it later. The swap waits for the
 * hero's mount.
 */
export function createWelcomeBack(): Accessor<boolean> {
  const [mounted, setMounted] = createSignal(false);
  onMount(() => setMounted(true));
  return () => mounted() && returning();
}
