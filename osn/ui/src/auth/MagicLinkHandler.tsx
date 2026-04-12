import type { LoginClient } from "@osn/client";
import { useAuth } from "@osn/client/solid";
import { onMount } from "solid-js";

/**
 * Invisible helper component: on mount, checks the current URL for a
 * `?token=…` query param. If present, exchanges it at `/login/magic/verify`
 * via the injected `LoginClient`, adopts the returned session, and clears
 * the token from the URL so refreshing doesn't retry the consumed link.
 *
 * Mount this once at the app root alongside any other callback handlers.
 * It is a no-op when the URL doesn't contain a magic token, so it's safe
 * to leave always-mounted.
 */

export interface MagicLinkHandlerProps {
  client: LoginClient;
  /** Fires after the session has been adopted. Useful for navigation. */
  onSuccess?: () => void;
  /** Fires on any failure. Defaults to silently logging. */
  onError?: (err: unknown) => void;
  /**
   * Query param name containing the magic token. Defaults to `token`,
   * matching the emailed link and the `/login/magic/verify` endpoint.
   */
  paramName?: string;
}

export function MagicLinkHandler(props: MagicLinkHandlerProps) {
  const { adoptSession } = useAuth();

  onMount(() => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    const paramName = props.paramName ?? "token";
    const token = url.searchParams.get(paramName);
    if (!token) return;

    // Clear the token from the URL immediately — the token is single-use,
    // so we never want a refresh to retry it.
    url.searchParams.delete(paramName);
    window.history.replaceState({}, "", url.toString());

    props.client
      .magicVerify(token)
      .then(({ session }) => adoptSession(session))
      .then(() => props.onSuccess?.())
      .catch((err) => {
        if (props.onError) props.onError(err);
        // eslint-disable-next-line no-console -- client-side fallback when no onError handler
        else console.error("[MagicLinkHandler] verify failed", err);
      });
  });

  return null;
}
