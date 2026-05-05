import { createSignal, Show } from "solid-js";
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
        body: JSON.stringify({ code: code() }),
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
    <section class="border-b border-border px-6 py-16 md:px-8 md:py-20">
      <div class="mx-auto max-w-[540px] text-center md:max-w-[640px]">
        {/* Login form — visible before claim */}
        <div ref={props.formRef} style={{ display: props.result ? "none" : "" }}>
          <p class="mb-3 font-body text-[0.72rem] uppercase tracking-[0.2em] text-gold">
            Your Invitation
          </p>
          <h2 class="mb-5 font-display text-[clamp(2rem,5vw,3rem)] font-light italic leading-[1.15] text-text">
            Enter Your Code
          </h2>
          <p class="text-text-muted text-[0.92rem] font-light leading-[1.6] mb-8">
            Enter the code from your invitation to see your events.
          </p>
          <form class="mx-auto flex max-w-[360px] flex-col gap-3" onSubmit={handleSubmit}>
            <input
              type="text"
              class="w-full rounded-sm border border-border bg-transparent px-4 py-3.5 text-center font-body text-base uppercase tracking-[0.1em] text-text transition-colors duration-200 placeholder:normal-case placeholder:tracking-[0.04em] placeholder:text-text-muted focus:border-gold focus:outline-none disabled:opacity-50"
              placeholder="e.g. DEV-JOY-RK97"
              value={code()}
              onInput={(e) => setCode(e.currentTarget.value)}
              autocapitalize="characters"
              autocorrect="off"
              spellcheck={false}
              disabled={loading()}
              maxLength={20}
              pattern="[A-Za-z0-9\\-]+"
            />
            <Show when={error()}>
              <p class="font-body text-[0.82rem] text-error py-2" role="alert">
                {error()}
              </p>
            </Show>
            <button
              type="submit"
              class="rounded-sm border border-gold bg-transparent px-6 py-3.5 font-body text-[0.88rem] uppercase tracking-[0.12em] text-gold transition-colors duration-200 hover:bg-gold hover:text-bg disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-gold"
              disabled={loading() || !code().trim()}
            >
              {loading() ? "Checking\u2026" : "Open Invitation"}
            </button>
          </form>
        </div>

        {/* Welcome message — visible after claim */}
        <div ref={props.welcomeRef} style={{ display: props.result ? "" : "none" }}>
          <p class="mb-3 font-body text-[0.72rem] uppercase tracking-[0.2em] text-gold">Welcome</p>
          <h2 class="mb-5 font-display text-[clamp(2rem,5vw,3rem)] font-light italic leading-[1.15] text-gold">
            {props.result?.guestName}
          </h2>
          <p class="text-text-muted text-[0.92rem] font-light leading-[1.6] mb-8">
            We are delighted to invite you to celebrate with us.
          </p>
        </div>
      </div>
    </section>
  );
}
