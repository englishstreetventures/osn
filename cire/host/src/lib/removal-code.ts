/**
 * The code Musubi sends a person back with, `#/remove-data?code=…`: kept in
 * `sessionStorage` (`keepCode`) and taken out of the address at once, before
 * anything can carry the address elsewhere. A sign-in bounce copies the whole
 * address into `/login/?returnTo=…`, which reaches cire-api's request line and
 * the tab's history; with the code gone from the address first, only
 * `#/remove-data` travels.
 *
 * `OrganiserApp` calls it before it checks the session, and again on a hash
 * change. Read by the removal screen through `keptCode`.
 */
import { keepCode } from "./account-removal";
import { parseRoute, serializeRoute } from "./dashboard-route";

/** Keeps the code the address carries and rewrites the address without it; the code, or undefined. */
export function takeRemovalCode(): string | undefined {
  if (typeof window === "undefined") return undefined;
  const route = parseRoute(window.location.hash);
  if (route.view !== "remove-data") return undefined;
  if (route.code !== undefined) keepCode(route.code);
  const canonical = serializeRoute(route);
  if (window.location.hash !== canonical) {
    history.replaceState(
      null,
      "",
      `${window.location.pathname}${window.location.search}${canonical}`,
    );
  }
  return route.code;
}
