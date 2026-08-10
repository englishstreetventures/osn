import { clearAuthError, readAuthError } from "@shared/rp-auth";
import { onMount } from "solid-js";
import { toast } from "solid-toast";

/**
 * Surfaces a failed sign-in.
 *
 * Pulse has no dedicated login page — `PULSE_LOGIN_URL` is the site root —
 * so the callback's `?auth_error=` marker lands on whatever page the user
 * was heading for. This sits in the root layout and reads it wherever it
 * lands, then strips it from the URL so a reload doesn't repeat the toast.
 */
const ERROR_COPY: Record<string, string> = {
  sign_in_declined: "Sign-in was cancelled. Nothing was shared with Pulse.",
  sign_in_failed: "Sign-in did not go through. Try again.",
  sign_in_unavailable: "Sign-in is temporarily unavailable. Please try again shortly.",
};

export function AuthErrorToast() {
  onMount(() => {
    const marker = readAuthError();
    if (!marker) return;
    toast.error(ERROR_COPY[marker] ?? ERROR_COPY.sign_in_failed!);
    clearAuthError();
  });

  return null;
}
