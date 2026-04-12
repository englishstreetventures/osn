import { useAuth } from "@osn/client/solid";
import { onMount } from "solid-js";

import { REDIRECT_URI } from "../lib/auth";

export function CallbackHandler() {
  const { handleCallback } = useAuth();

  onMount(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    const state = params.get("state");

    if (code && state) {
      handleCallback({ code, state, redirectUri: REDIRECT_URI() }).then(() => {
        window.history.replaceState({}, "", window.location.pathname);
        return undefined;
      });
    }
  });

  return null;
}
