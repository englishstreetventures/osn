import { clearAuthError, readAuthError } from "@shared/rp-auth";
import { toast } from "@shared/toast";
import { onMount } from "solid-js";

/**
 * Surfaces a failed sign-in.
 *
 * Pulse has no dedicated login page — `PULSE_LOGIN_URL` is the site root —
 * so the callback's `?auth_error=` marker lands on whatever page the user
 * was heading for. This sits in the root layout and reads it wherever it
 * lands, then strips it from the URL so a reload doesn't repeat the toast.
 */
// Keyed by a value that is open at runtime (see the `??` fallback at the
// read site), so the contract is an index signature, not a closed union.
interface ErrorCopyTable {
  readonly [code: string]: string;
}

const ERROR_COPY: ErrorCopyTable = {
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
