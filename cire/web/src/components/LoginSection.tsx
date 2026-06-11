import { createSignal, Show, For } from "solid-js";

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

  async function handleSubmit(e: SubmitEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const res = await fetch(`${props.apiUrl}/api/claim`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Include cookies so the API's Set-Cookie response sticks for follow-up
        // calls (e.g. /api/rsvp). Requires CORS `credentials: true` server-side.
        credentials: "include",
        body: JSON.stringify({ publicId: code().trim().toUpperCase() }),
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
              maxLength={30}
              pattern="[A-Za-z0-9-]+"
            />
            <Show when={error()}>
              <p class="font-body text-error py-2 text-[0.82rem]" role="alert">
                {error()}
              </p>
            </Show>
            <button
              type="submit"
              class="border-gold font-body text-gold hover:bg-gold hover:text-bg disabled:hover:text-gold rounded-sm border bg-transparent px-6 py-3.5 text-[0.88rem] tracking-[0.12em] uppercase transition-colors duration-200 disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent"
              disabled={loading() || !code().trim()}
            >
              {loading() ? "Checking\u2026" : "Open Invitation"}
            </button>
          </form>
        </div>

        {/* Welcome message — visible after claim */}
        <div ref={props.welcomeRef} style={{ display: props.result ? "" : "none" }}>
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
