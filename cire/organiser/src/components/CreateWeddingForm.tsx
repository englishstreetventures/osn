import { useAuth } from "@shared/rp-auth/solid";
import { createSignal, For, Show } from "solid-js";

import { apiUrl, isAuthExpired, redirectToLogin } from "../lib/api";
import { haptic } from "../lib/haptics";
import Button from "./ui/Button";
import Field, { Fieldset, Input } from "./ui/Field";
import Notice from "./ui/Notice";

export interface WeddingSummary {
  id: string;
  slug: string;
  displayName: string;
  /** The signed-in organiser's role on this wedding. Owners manage hosts,
   *  codes, settings + destructive actions; editors get full module writes
   *  (import, invite builder, event locations); viewers are read-only. */
  role: "owner" | "editor" | "viewer";
  /** Entitlement keys active on this wedding (e.g. `"vendors"`, `"capacity_500"`).
   *  Populated by the `/api/organiser/weddings` list endpoint. */
  entitlements: string[];
  /** Effective guest ceiling derived from the entitlement set. Defaults to 100. */
  guestCap: number;
}

/** Claim-code style, mirroring the API's `weddings.code_style` enum. */
export type CodeStyle = "simple" | "secure";

const MAX_DISPLAY_NAME = 120;

/** Friendly, non-technical labels for the two code styles. `secure` is the
 *  recommended default; `simple` trades guess-resistance for shorter codes. */
const CODE_STYLE_OPTIONS: { value: CodeStyle; label: string; hint: string }[] = [
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
 * Inline form to create a new wedding. POSTs the display name to
 * /api/organiser/weddings (owner = the signed-in organiser, derived server-side
 * from the OSN token) and hands the created wedding back to the parent so it can
 * update the list without a round-trip.
 */
export default function CreateWeddingForm(props: {
  onCreated: (wedding: WeddingSummary) => void;
  onCancel?: () => void;
}) {
  const { authFetch } = useAuth();
  const [name, setName] = createSignal("");
  const [codeStyle, setCodeStyle] = createSignal<CodeStyle>("secure");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  async function submit(e: Event) {
    e.preventDefault();
    const displayName = name().trim();
    if (!displayName) {
      setError("Give the wedding a name.");
      haptic("reject");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const res = await authFetch(apiUrl("/api/organiser/weddings"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName, codeStyle: codeStyle() }),
      });
      if (res.status === 401) {
        redirectToLogin();
        return;
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Could not create the wedding (${res.status}).`);
      }
      const body = (await res.json()) as { wedding: WeddingSummary };
      setName("");
      haptic("commit");
      props.onCreated(body.wedding);
    } catch (err) {
      if (isAuthExpired(err)) {
        redirectToLogin();
        return;
      }
      setError(err instanceof Error ? err.message : "Could not create the wedding.");
      haptic("reject");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      class="border-border bg-surface/30 flex flex-col gap-4 rounded-sm border p-6"
      onSubmit={submit}
    >
      <div class="flex flex-col gap-1">
        <p class="font-body text-gold text-[0.72rem] tracking-[0.2em] uppercase">New wedding</p>
        <h2 class="font-display text-text text-[1.4rem] font-light">Start a new celebration</h2>
      </div>

      <Field label="Wedding name">
        {(field) => (
          <Input
            {...field}
            value={name()}
            maxLength={MAX_DISPLAY_NAME}
            placeholder="e.g. Nadia &amp; Sam"
            autocomplete="off"
            onInput={(e) => setName(e.currentTarget.value)}
            disabled={busy()}
          />
        )}
      </Field>

      <Fieldset legend="Guest code style">
        <div class="flex flex-col gap-2 @lg/page:flex-row">
          <For each={CODE_STYLE_OPTIONS}>
            {(option) => (
              <label
                class={`flex flex-1 cursor-pointer flex-col gap-1 rounded-sm border p-3 transition-colors ${
                  codeStyle() === option.value
                    ? "border-gold bg-gold/5"
                    : "border-border bg-bg hover:border-gold/50"
                } ${busy() ? "opacity-40" : ""}`}
              >
                <span class="flex items-center gap-2">
                  <input
                    type="radio"
                    name="codeStyle"
                    value={option.value}
                    checked={codeStyle() === option.value}
                    disabled={busy()}
                    onChange={() => setCodeStyle(option.value)}
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
      </Fieldset>

      <div class="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="primary" disabled={busy()}>
          {busy() ? "Creating…" : "Create wedding"}
        </Button>
        <Show when={props.onCancel}>
          {/* Not a Button: cancelling out of a form the host has not committed
              to is a link's worth of weight, and giving it a border would put
              it in the same tier as the thing it backs out of. */}
          <button
            type="button"
            onClick={() => props.onCancel?.()}
            disabled={busy()}
            class="font-body text-text-muted text-[0.82rem] underline-offset-4 hover:underline disabled:opacity-40"
          >
            Cancel
          </button>
        </Show>
      </div>

      <Show when={error()}>
        <Notice tone="error" alert>
          {error()}
        </Notice>
      </Show>
    </form>
  );
}
