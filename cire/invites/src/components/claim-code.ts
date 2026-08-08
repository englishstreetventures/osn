import { createSignal, onMount, type Accessor } from "solid-js";

import { turnstileEnabled } from "./TurnstileWidget";
import type { ClaimResult } from "./types";
import { isValidClaimResponse } from "./utils";

export interface ClaimCodeOptions {
  apiUrl: string;
  /** Current claim result — non-null once claimed (suppresses ?code= auto-claim re-fire). */
  result: Accessor<ClaimResult | null>;
  onClaimed: (result: ClaimResult) => void;
}

export interface ClaimCode {
  code: Accessor<string>;
  setCode: (value: string) => void;
  loading: Accessor<boolean>;
  error: Accessor<string | null>;
  turnstileToken: Accessor<string | null>;
  setTurnstileToken: (token: string | null) => void;
  handleSubmit: (e: Event) => void;
  /**
   * Return the form to a pristine, SUBMITTABLE state — for the case where a
   * guest steps back to the code entry after a claim has already succeeded
   * ("Use a different claim code"). Clears the code, any error, the stuck
   * loading flag and the spent Turnstile token; see the notes in the
   * implementation for why each one would otherwise strand the form.
   */
  reset: () => void;
}

/**
 * Headless claim-code submission primitive — the code entry field, the
 * Turnstile-gated POST to `/api/claim`, and the `?code=` deep-link auto-claim
 * (with its S-L1 URL strip), factored out of LoginSection so every design
 * pack (classic, gala, …) can reuse the identical behaviour behind whatever
 * markup it wants.
 */
export function createClaimCode(options: ClaimCodeOptions): ClaimCode {
  const [code, setCode] = createSignal("");
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  // Turnstile token. `null` until the widget solves; only REQUIRED when a
  // sitekey is configured (`turnstileEnabled()`). When Turnstile is off, this
  // stays null and submit proceeds without it.
  const [turnstileToken, setTurnstileToken] = createSignal<string | null>(null);

  async function submitCode(rawCode: string) {
    const publicId = rawCode.trim().toUpperCase();
    if (!publicId) return;
    // Block submit until the challenge is solved when Turnstile is configured.
    const token = turnstileToken();
    if (turnstileEnabled() && !token) {
      setError("Please complete the verification challenge below.");
      return;
    }
    setError(null);
    setLoading(true);

    try {
      const res = await fetch(`${options.apiUrl}/api/claim`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Include cookies so the API's Set-Cookie response sticks for follow-up
        // calls (e.g. /api/rsvp). Requires CORS `credentials: true` server-side.
        credentials: "include",
        // `turnstileToken` is included only when present; the server treats a
        // missing token as a hard fail ONLY when it has a secret configured.
        body: JSON.stringify(token ? { publicId, turnstileToken: token } : { publicId }),
      });

      if (res.status === 401) {
        setError("That code doesn't look right. Check your invitation and try again.");
        setLoading(false);
        return;
      }

      if (!res.ok) {
        setError("Something went wrong. Please try again.");
        setLoading(false);
        return;
      }

      const data: unknown = await res.json();
      if (!isValidClaimResponse(data)) {
        setError("Something went wrong. Please try again.");
        setLoading(false);
        return;
      }
      options.onClaimed(data);
    } catch {
      setError("Could not connect. Please check your connection.");
      setLoading(false);
    }
  }

  function handleSubmit(e: Event) {
    e.preventDefault();
    void submitCode(code());
  }

  function reset() {
    setCode("");
    setError(null);
    // `submitCode` clears `loading` on every FAILURE branch but deliberately
    // not on success: the form is mid-fade-out by then, and flipping the button
    // label from "Checking…" back to "Open Invitation" underneath that fade
    // would flash. The flag therefore stays true once a claim succeeds — which
    // was unobservable while the form could never come back, and is exactly
    // what strands it now that it can. Without this line the restored form
    // returns with a `disabled` input and a permanently disabled "Checking…"
    // button, i.e. the escape hatch leads nowhere.
    setLoading(false);
    // Turnstile tokens are SINGLE USE — the claim that just succeeded redeemed
    // this one. Carrying it into the next submit means the server's verifier
    // answers `timeout-or-duplicate` → 403, which `submitCode` reports as the
    // generic "Something went wrong" while leaving the button enabled and the
    // token in place: a retry loop that burns a Worker invocation and an
    // outbound siteverify per click until the per-IP limiter 429s the guest.
    // Nulling it re-disables submit; the caller resets the widget so a fresh
    // token can actually arrive.
    setTurnstileToken(null);
  }

  // Organiser "Preview invite" deep-link: ?code=<host code> auto-claims so the
  // host lands straight on the events view without retyping the code.
  onMount(() => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    const prefill = url.searchParams.get("code");
    if (prefill && !options.result()) {
      setCode(prefill.trim().toUpperCase());
      // S-L1: strip the credential from the address bar + forward history
      // immediately. submitCode already captured the value, and the claim sets
      // the session cookie, so the URL copy is no longer needed.
      url.searchParams.delete("code");
      window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
      void submitCode(prefill);
    }
  });

  return {
    code,
    setCode,
    loading,
    error,
    turnstileToken,
    setTurnstileToken,
    handleSubmit,
    reset,
  };
}
