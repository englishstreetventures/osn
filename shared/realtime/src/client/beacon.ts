import type { FallbackOutcome } from "../protocol";

/**
 * Tell a product's API why a subscription fell back, so it can count it. Pass
 * it `onFallback`'s outcome. It never throws, never logs and returns nothing:
 * a beacon that cannot be sent changes nothing for the tab.
 *
 * The body is the outcome as a plain string, which `fetch` sends as
 * `text/plain` and so keeps the POST a CORS simple request, with no preflight.
 * `keepalive` lets the request finish if the tab is closing. `credentials:
 * "omit"` because the beacon needs no session and carries no id; this is also
 * why it is not `navigator.sendBeacon`, which always sends cookies.
 */
export function sendFallbackBeacon(endpoint: string, outcome: FallbackOutcome): void {
  try {
    fetch(endpoint, { method: "POST", body: outcome, keepalive: true, credentials: "omit" }).catch(
      () => {},
    );
  } catch {
    // No `fetch`, or a URL it refuses outright: the beacon is dropped.
  }
}
