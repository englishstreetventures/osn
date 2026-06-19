import { useAuth } from "@osn/client/solid";
import { createSignal, For, onMount, Show } from "solid-js";
import { toast } from "solid-toast";

import { apiUrl, isAuthExpired, redirectToLogin } from "../lib/api";
import type { CodeStyle } from "./CreateWeddingForm";
import SectionIntro from "./SectionIntro";

interface RemintPanelProps {
  weddingId: string;
}

interface GuestRow {
  familyId: string;
  publicId: string;
  codeSharedAt: number | null;
}

const STYLE_OPTIONS: { value: CodeStyle; label: string; hint: string }[] = [
  {
    value: "secure",
    label: "Secure",
    hint: "Longer codes that are harder to guess. Recommended.",
  },
  {
    value: "simple",
    label: "Simple",
    hint: "Shorter, friendlier codes — easy to read aloud or type.",
  },
];

/**
 * Owner-only control to re-mint every family's claim code onto a different
 * style. Reminting is destructive: it rotates every code and breaks any link a
 * guest was already given, so the panel warns when families have already been
 * sent their codes and requires an explicit confirm before firing.
 */
export default function RemintPanel(props: RemintPanelProps) {
  const { authFetch } = useAuth();
  const [targetStyle, setTargetStyle] = createSignal<CodeStyle>("simple");
  const [sharedCount, setSharedCount] = createSignal(0);
  const [familyCount, setFamilyCount] = createSignal(0);
  const [loading, setLoading] = createSignal(true);
  const [confirming, setConfirming] = createSignal(false);
  const [busy, setBusy] = createSignal(false);

  async function loadSharedCount() {
    try {
      const res = await authFetch(apiUrl(`/api/organiser/weddings/${props.weddingId}/guests`));
      if (res.status === 401) return redirectToLogin();
      if (!res.ok) return;
      const rows = (await res.json()) as GuestRow[];
      // Dedupe to families (guest rows repeat per member).
      const byFamily = new Map<string, boolean>();
      for (const r of rows) {
        byFamily.set(r.familyId, byFamily.get(r.familyId) || r.codeSharedAt !== null);
      }
      setFamilyCount(byFamily.size);
      setSharedCount(Array.from(byFamily.values()).filter(Boolean).length);
    } catch (err) {
      if (isAuthExpired(err)) return redirectToLogin();
      // A failed count just means the warning is omitted — the remint endpoint
      // is still authoritative.
    } finally {
      setLoading(false);
    }
  }

  onMount(() => void loadSharedCount());

  async function remint() {
    if (busy()) return;
    setBusy(true);
    try {
      const res = await authFetch(apiUrl(`/api/organiser/weddings/${props.weddingId}/remint`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ codeStyle: targetStyle() }),
      });
      if (res.status === 401) return redirectToLogin();
      if (!res.ok) {
        toast.error("Could not re-mint the codes. Please try again.");
        return;
      }
      const body = (await res.json()) as { reminted: number };
      toast.success(`Re-minted ${body.reminted} family codes`);
      setConfirming(false);
      // The new codes start un-shared.
      setSharedCount(0);
    } catch (err) {
      if (isAuthExpired(err)) return redirectToLogin();
      toast.error("Could not re-mint the codes. Is the API running?");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="border-border bg-surface/30 flex flex-col gap-5 rounded-sm border p-6">
      <SectionIntro
        eyebrow="Guest codes"
        title="Change the code style"
        description="Each household has a private code they enter to open your invite and RSVP. If you'd rather they were shorter and friendlier — or longer and harder to guess — switch the style here. Re-minting replaces every code, so any code you've already shared will stop working."
      />

      <fieldset class="m-0 flex flex-col gap-1.5 border-0 p-0">
        <legend class="font-body text-text-muted mb-1.5 text-[0.72rem] tracking-[0.1em] uppercase">
          New code style
        </legend>
        <div class="flex flex-col gap-2 sm:flex-row">
          <For each={STYLE_OPTIONS}>
            {(option) => (
              <label
                class={`flex flex-1 cursor-pointer flex-col gap-1 rounded-sm border p-3 transition-colors ${
                  targetStyle() === option.value
                    ? "border-gold bg-gold/5"
                    : "border-border bg-bg hover:border-gold/50"
                } ${busy() ? "opacity-40" : ""}`}
              >
                <span class="flex items-center gap-2">
                  <input
                    type="radio"
                    name="remintStyle"
                    value={option.value}
                    checked={targetStyle() === option.value}
                    disabled={busy()}
                    onChange={() => setTargetStyle(option.value)}
                    class="accent-gold"
                  />
                  <span class="font-body text-text text-[0.9rem]">{option.label}</span>
                </span>
                <span class="font-body text-text-muted pl-6 text-[0.78rem] leading-snug">
                  {option.hint}
                </span>
              </label>
            )}
          </For>
        </div>
      </fieldset>

      <Show when={!confirming()}>
        <button
          type="button"
          onClick={() => setConfirming(true)}
          disabled={loading() || familyCount() === 0}
          class="border-gold bg-gold font-body text-bg hover:bg-gold-dim self-start rounded-sm border px-4 py-2 text-[0.82rem] tracking-[0.1em] uppercase transition disabled:opacity-40"
        >
          Re-mint all codes
        </button>
      </Show>

      <Show when={confirming()}>
        <div class="border-error/30 bg-error/5 flex flex-col gap-3 rounded-sm border p-4">
          <Show when={sharedCount() > 0}>
            <p class="font-body text-error text-[0.88rem] leading-relaxed">
              {sharedCount() === 1
                ? "1 family has already been sent their code."
                : `${sharedCount()} families have already been sent their codes.`}{" "}
              Re-minting will invalidate those codes — anyone who already has a link will need the
              new one.
            </p>
          </Show>
          <p class="font-body text-text text-[0.88rem]">
            Re-mint all {familyCount()} family codes in the{" "}
            <span class="text-gold">{targetStyle()}</span> style? This can&apos;t be undone.
          </p>
          <div class="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => void remint()}
              disabled={busy()}
              class="border-error bg-error font-body text-bg rounded-sm border px-4 py-2 text-[0.82rem] tracking-[0.1em] uppercase transition hover:opacity-90 disabled:opacity-40"
            >
              {busy() ? "Re-minting…" : "Yes, re-mint"}
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              disabled={busy()}
              class="font-body text-text-muted text-[0.82rem] underline-offset-4 hover:underline disabled:opacity-40"
            >
              Cancel
            </button>
          </div>
        </div>
      </Show>
    </div>
  );
}
