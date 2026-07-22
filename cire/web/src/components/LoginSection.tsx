import { createSignal, onMount, Show, For } from "solid-js";

import { filterThemeVars } from "./invite-theme";
import { TurnstileWidget, turnstileEnabled } from "./TurnstileWidget";
import type { ClaimResult } from "./types";
import { isValidClaimResponse } from "./utils";

interface LoginSectionProps {
  apiUrl: string;
  result: ClaimResult | null;
  onClaimed: (result: ClaimResult) => void;
  formRef?: (el: HTMLDivElement) => void;
  welcomeRef?: (el: HTMLDivElement) => void;
  /**
   * Validated CSS-variable map for the "welcome" theme section
   * (`sectionVars(theme, "welcome")`) — which derived surface the code-entry
   * form and post-claim welcome banner sit on. The colours themselves come from
   * the palette at the document root. Empty/absent ⇒ the page ground.
   */
  themeVars?: Record<string, string>;
  /**
   * Organiser override for the post-claim greeting line shown under the family
   * or guest name. Absent/null ⇒ the built-in default greeting.
   */
  welcomeMessage?: string | null;
}

// The built-in post-claim greeting, used when the organiser hasn't overridden it.
const DEFAULT_WELCOME_MESSAGE = "We are delighted to invite you to celebrate with us.";

export function LoginSection(props: LoginSectionProps) {
  const [code, setCode] = createSignal("");
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  // Turnstile token. `null` until the widget solves; only REQUIRED when a
  // sitekey is configured (`turnstileEnabled()`). When Turnstile is off, this
  // stays null and submit proceeds without it.
  const [turnstileToken, setTurnstileToken] = createSignal<string | null>(null);

  // A claim code can cover one guest or a whole household. A single-guest code
  // greets the person individually ("Dear {name}"); a multi-guest code greets
  // the household ("The {familyName} Family"). For an individual, an optional
  // nickname overrides their first name.
  const members = () => props.result?.members ?? [];
  const isIndividual = () => members().length === 1;
  const individualName = () => {
    const m = members()[0];
    if (!m) return "";
    return m.nickname?.trim() ? m.nickname.trim() : m.firstName;
  };

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
    <section
      class="border-border border-b px-6 py-16 md:px-8 md:py-20"
      style={{
        // themeVars carries this section's tone — which derived surface it sits
        // on. Every gold/font utility inside (eyebrow labels, headings, the
        // input's focus border, the submit button and its hover fill, the
        // preview-mode chip) already resolves the organiser's scheme from the
        // root palette, hover and focus states included.
        ...filterThemeVars(props.themeVars),
        "background-color": "var(--invite-section-bg)",
      }}
    >
      <div class="mx-auto max-w-[540px] text-center md:max-w-[640px]">
        {/* Login form — visible before claim */}
        <div ref={props.formRef} style={{ display: props.result ? "none" : "" }}>
          <p class="font-body text-gold mb-3 text-[0.72rem] tracking-[0.2em] uppercase">
            Your Invitation
          </p>
          <h2 class="font-display text-text mb-5 text-[clamp(2rem,5vw,3rem)] leading-[1.15] font-light">
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
              // A border tint alone is too quiet to mark focus on the page's
              // one input; the ring keeps keyboard users oriented. Text cursor
              // on a text field — the pointer belongs on buttons only.
              class="border-border font-body text-text placeholder:text-text-muted focus:border-gold w-full cursor-text rounded-sm border bg-transparent px-4 py-3.5 text-center text-base tracking-[0.1em] uppercase transition-colors duration-200 placeholder:tracking-[0.04em] placeholder:normal-case focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--invite-focus)] disabled:cursor-not-allowed disabled:opacity-50"
              placeholder="e.g. PATEL-JOY-RK97"
              value={code()}
              onInput={(e) => setCode(e.currentTarget.value)}
              autocapitalize="characters"
              autocorrect="off"
              spellcheck={false}
              disabled={loading()}
              maxLength={48}
              // NB: the hyphen must be escaped — Chrome compiles `pattern` with
              // the `v` flag, where a trailing unescaped `-` is a syntax error
              // that voids the whole pattern.
              pattern="[A-Za-z0-9\-]+"
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
              class="border-gold font-body text-gold hover:bg-gold hover:text-bg disabled:hover:text-gold rounded-sm border bg-transparent px-6 py-3.5 text-[0.88rem] tracking-[0.12em] uppercase transition-colors duration-200 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
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
              Preview mode. Every event is shown; try the RSVP, nothing you send is saved.
            </p>
          </Show>
          <Show
            when={isIndividual()}
            fallback={
              <>
                {/* No "Welcome" eyebrow above this heading: the greeting IS the
                    heading, and a label repeating it only adds a fourth gold
                    uppercase micro-label to a page that already has too many. */}
                <h2 class="font-display text-gold mb-3 text-[clamp(2rem,5vw,3rem)] leading-[1.15] font-light">
                  Welcome, the {props.result?.familyName} Family
                </h2>
                <p class="text-text-muted mb-2 text-[0.92rem] leading-[1.6] font-light">
                  {props.welcomeMessage ?? DEFAULT_WELCOME_MESSAGE}
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
              </>
            }
          >
            {/* Single-guest code → greet the individual by name (nickname wins).
                "Dear" reads as part of the greeting, so it belongs in the
                heading, not stranded above it as an uppercase label. */}
            <h2 class="font-display text-gold mb-3 text-[clamp(2rem,5vw,3rem)] leading-[1.15] font-light">
              Dear {individualName()}
            </h2>
            <p class="text-text-muted mb-8 text-[0.92rem] leading-[1.6] font-light">
              {props.welcomeMessage ?? DEFAULT_WELCOME_MESSAGE}
            </p>
          </Show>
        </div>
      </div>
    </section>
  );
}
