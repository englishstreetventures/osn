import { useAuth } from "@osn/client/solid";
import { useNavigate } from "@solidjs/router";
import { onMount } from "solid-js";
import { toast } from "solid-toast";

import { REDIRECT_URI } from "../lib/auth";

/**
 * Mounts at the dedicated `/callback` route (P-I3). On mount, parses the
 * `code` + `state` from the URL, completes the OAuth exchange, surfaces
 * any failure to the user via a toast (S-M2), and redirects home.
 */
export function CallbackHandler() {
  const { handleCallback } = useAuth();
  const navigate = useNavigate();

  onMount(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    const state = params.get("state");

    if (!code || !state) {
      navigate("/", { replace: true });
      return;
    }

    handleCallback({ code, state, redirectUri: REDIRECT_URI() })
      .catch((err: unknown) => {
        toast.error(err instanceof Error ? err.message : "Sign-in failed");
      })
      .finally(() => {
        // Clear auth params from the URL regardless of outcome so the
        // code/state cannot be bookmarked or re-sent on refresh.
        navigate("/", { replace: true });
      });
  });

  return null;
}
