import { createSignal, onMount, Show, For } from "solid-js";

import { TurnstileWidget, turnstileEnabled } from "./TurnstileWidget";
import type { ClaimResult } from "./types";
import { isValidClaimResponse } from "./utils";

interface LoginSectionProps {
  apiUrl: string;
  result: ClaimResult | null;
  onClaimed: (result: ClaimResult) => void;
  formRef?: (el: HTMLDivElement) => void;
  welcomeRef?: (el: HTMLDivElement) => void;
}

export function LoginSection(props: LoginSectionProps) {
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
      const res = await fetch(`${props.apiUrl}/api/claim`, {
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
      props.onClaimed(data);
    } catch {
      setError("Could not connect. Please check your connection.");
      setLoading(false);
    }
  }

  async function handleSubmit(e: SubmitEvent) {
    e.preventDefault();
    await submitCode(code());
  }

  // Organiser "Preview invite" deep-link: ?code=<host code> auto-claims so the
  // host lands straight on the events view without retyping the code.
  onMount(() => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    const prefill = url.searchParams.get("code");
    if (prefill && !props.result) {
      setCode(prefill.trim().toUpperCase());
      // S-L1: strip the credential from the address bar + forward history
      // immediately. submitCode already captured the value, and the claim sets
      // the session cookie, so the URL copy is no longer needed.
      url.searchParams.delete("code");
      window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
      void submitCode(prefill);
    }
  });

  return (
    <section class="border-border border-b px-6 py-16 md:px-8 md:py-20">
      <div class="mx-auto max-w-[540px] text-center md:max-w-[640px]">
        {/* Login form — visible before claim */}
        <div ref={props.formRef} style={{ display: props.result ? "none" : "" }}>
          <p class="font-body text-gold mb-3 text-[0.72rem] tracking-[0.2em] uppercase">
            Your Invitation
          </p>
          <h2 class="font-display text-text mb-5 text-[clamp(2rem,5vw,3rem)] leading-[1.15] font-light italic">
            Enter Your Code
          </h2>
          <p class="text-text-muted mb-8 text-[0.92rem] leading-[1.6] font-light">
            Enter the code from your invitation to see your events.
          </p>
          <form class="mx-auto flex max-w-[360px] flex-col gap-3" onSubmit={handleSubmit}>
            {/* maxLength 48 comfortably fits the worst-case code: SURNAME(16) +
                "-" + longest word(10) + "-" + secure hash "XXXXX-XXXXX"(11) = 39
                chars, so a long code like THENGUYENFAMILY-BANISTER-DM65HQ (31) is
                never truncated. The server still validates the code. */}
            <input
              type="text"
              class="border-border font-body text-text placeholder:text-text-muted focus:border-gold w-full rounded-sm border bg-transparent px-4 py-3.5 text-center text-base tracking-[0.1em] uppercase transition-colors duration-200 placeholder:tracking-[0.04em] placeholder:normal-case focus:outline-none disabled:opacity-50"
              placeholder="e.g. PATEL-JOY-RK97"
              value={code()}
              onInput={(e) => setCode(e.currentTarget.value)}
              autocapitalize="characters"
              autocorrect="off"
              spellcheck={false}
              disabled={loading()}
              maxLength={48}
              pattern="[A-Za-z0-9-]+"
            />
            <Show when={error()}>
              <p class="font-body text-error py-2 text-[0.82rem]" role="alert">
                {error()}
              </p>
            </Show>
            {/* Turnstile challenge — renders only when a sitekey is configured;
                otherwise this is nothing and the form is unchanged. */}
            <TurnstileWidget onToken={setTurnstileToken} class="flex justify-center" />
            <button
              type="submit"
              class="border-gold font-body text-gold hover:bg-gold hover:text-bg disabled:hover:text-gold rounded-sm border bg-transparent px-6 py-3.5 text-[0.88rem] tracking-[0.12em] uppercase transition-colors duration-200 disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent"
              disabled={loading() || !code().trim() || (turnstileEnabled() && !turnstileToken())}
            >
              {loading() ? "Checking\u2026" : "Open Invitation"}
            </button>
          </form>
        </div>

        {/* Welcome message — visible after claim */}
        <div ref={props.welcomeRef} style={{ display: props.result ? "" : "none" }}>
          <Show when={props.result?.preview}>
            <p
              class="border-gold/40 bg-gold/5 text-gold mx-auto mb-6 max-w-[420px] rounded-sm border px-4 py-3 text-[0.78rem] tracking-[0.08em] uppercase"
              role="status"
            >
              Preview mode — every event is shown. RSVP is disabled.
            </p>
          </Show>
          <p class="font-body text-gold mb-3 text-[0.72rem] tracking-[0.2em] uppercase">Welcome</p>
          <h2 class="font-display text-gold mb-3 text-[clamp(2rem,5vw,3rem)] leading-[1.15] font-light italic">
            The {props.result?.familyName} Family
          </h2>
          <p class="text-text-muted mb-2 text-[0.92rem] leading-[1.6] font-light">
            We are delighted to invite you to celebrate with us.
          </p>
          <p class="text-text mb-8 text-[0.88rem] leading-[1.6] font-light">
            <For each={props.result?.members}>
              {(member, i) => (
                <>
                  {i() > 0 && ", "}
                  {member.firstName}
                </>
              )}
            </For>
          </p>
        </div>
      </div>
    </section>
  );
}
