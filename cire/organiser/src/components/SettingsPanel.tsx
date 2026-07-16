import { useAuth } from "@osn/client/solid";
import { createSignal, onMount, Show } from "solid-js";
import { toast } from "solid-toast";

import { apiUrl, isAuthExpired, redirectToLogin } from "../lib/api";
import DatePicker from "./DatePicker";
import SectionIntro from "./SectionIntro";

/** The wedding profile as the settings API reads/writes it. Location is
 *  deliberately absent — an event's place is its free-text `address` (the sole
 *  location source, shown on the invite); the wedding holds one MAIN currency
 *  + budget. */
interface WeddingProfile {
  id: string;
  slug: string;
  displayName: string;
  weddingDate: string | null;
  guestCountEstimate: number | null;
  currency: string;
  budgetTotalMinor: number | null;
}

const labelClass = "font-body text-text-muted text-[0.72rem] tracking-[0.1em] uppercase";
const inputClass =
  "border-border bg-bg font-body text-text focus:border-gold rounded-sm border px-3 py-2 text-[0.95rem] transition-colors outline-none placeholder:opacity-40 disabled:opacity-40";
const hintClass = "font-body text-text-muted text-[0.75rem] leading-snug";

interface SettingsPanelProps {
  weddingId: string;
  /** Owner of this wedding? Settings writes are owner-only — co-hosts see the
   *  profile read-only. */
  canManage: boolean;
  /** Reports a saved name/slug up so the header + wedding list stay current
   *  without a refetch. */
  onWeddingUpdated?: (patch: { displayName: string; slug: string }) => void;
}

/**
 * The wedding profile: name, guest-site link, date, guest count, and money.
 * Money is wedding-scoped on purpose — one MAIN currency the couple thinks in,
 * even when events span countries (per-event locations live on the Events
 * tab). These facts drive the planning modules (checklist lead times, pricing
 * estimates) — none of them change the guest invite except the name and the
 * link slug.
 */
export default function SettingsPanel(props: SettingsPanelProps) {
  const { authFetch } = useAuth();

  const [loading, setLoading] = createSignal(true);
  const [loadError, setLoadError] = createSignal<string | null>(null);

  // Form state, seeded from the loaded profile. Numbers are kept as input
  // strings so a half-typed value never round-trips through parseFloat.
  const [displayName, setDisplayName] = createSignal("");
  // Read-only: renaming the slug would free the old one for another organiser
  // to claim while printed invite links still point at it (S-M1) — a rename
  // feature needs slug tombstoning first.
  const [slug, setSlug] = createSignal("");
  const [weddingDate, setWeddingDate] = createSignal("");
  const [guestCount, setGuestCount] = createSignal("");
  const [currency, setCurrency] = createSignal("AUD");

  const [saving, setSaving] = createSignal(false);

  const readOnly = () => !props.canManage;

  function seed(profile: WeddingProfile) {
    setDisplayName(profile.displayName);
    setSlug(profile.slug);
    setWeddingDate(profile.weddingDate ?? "");
    setGuestCount(profile.guestCountEstimate === null ? "" : String(profile.guestCountEstimate));
    setCurrency(profile.currency);
  }

  onMount(async () => {
    try {
      const res = await authFetch(apiUrl(`/api/organiser/weddings/${props.weddingId}/settings`));
      if (res.status === 401) return redirectToLogin();
      if (!res.ok) {
        setLoadError(`Could not load the wedding profile (${res.status}).`);
        return;
      }
      const body = (await res.json()) as { wedding: WeddingProfile };
      seed(body.wedding);
    } catch (err) {
      if (isAuthExpired(err)) return redirectToLogin();
      setLoadError("Could not load the wedding profile. Is the API running?");
    } finally {
      setLoading(false);
    }
  });

  /** Parse the form into the PUT body, or return a human error. Mirrors the
   *  server's validation so the common mistakes never round-trip. */
  function buildBody(): { body: Record<string, unknown> } | { error: string } {
    const name = displayName().trim();
    if (!name) return { error: "Give the wedding a name." };

    const curr = currency().trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(curr)) {
      return { error: "Currency must be a 3-letter code, like AUD." };
    }

    const guests = guestCount().trim();
    const guestNum = guests === "" ? null : Number(guests);
    if (guestNum !== null && (!Number.isInteger(guestNum) || guestNum < 1 || guestNum > 10_000)) {
      return { error: "Guest count must be a whole number between 1 and 10,000." };
    }

    return {
      body: {
        displayName: name,
        weddingDate: weddingDate() || null,
        guestCountEstimate: guestNum,
        currency: curr,
      },
    };
  }

  async function save(e: Event) {
    e.preventDefault();
    if (saving() || readOnly()) return;
    const built = buildBody();
    if ("error" in built) {
      toast.error(built.error);
      return;
    }
    setSaving(true);
    try {
      const res = await authFetch(apiUrl(`/api/organiser/weddings/${props.weddingId}/settings`), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(built.body),
      });
      if (res.status === 401) return redirectToLogin();
      if (!res.ok) {
        toast.error("Could not save the settings. Please check the fields and try again.");
        return;
      }
      const body = (await res.json()) as { wedding: WeddingProfile };
      seed(body.wedding);
      props.onWeddingUpdated?.({
        displayName: body.wedding.displayName,
        slug: body.wedding.slug,
      });
      toast.success("Settings saved");
    } catch (err) {
      if (isAuthExpired(err)) return redirectToLogin();
      toast.error("Could not save the settings. Is the API running?");
    } finally {
      setSaving(false);
    }
  }

  const disabled = () => readOnly() || saving();

  return (
    <div class="border-border bg-surface/30 flex flex-col gap-6 rounded-sm border p-6">
      <SectionIntro
        eyebrow="Settings"
        title="Wedding profile"
        description="The facts that drive your planning tools — the date and roughly how many guests, in the currency you think in. Where each event happens is set per event on the Events tab, so celebrations across cities or countries just work. Guests never see any of this; only the name and the invite link appear on the invite."
      />

      <Show when={loadError()}>
        {(message) => (
          <p class="border-error/20 bg-error/5 text-error rounded-sm border p-4 text-[0.88rem]">
            {message()}
          </p>
        )}
      </Show>

      <Show when={!loading() && !loadError()}>
        {/* noValidate: buildBody() mirrors the server's validation with friendlier
            messages, so native constraint UI never fires — and number/step
            constraint math is float-buggy in some DOM engines anyway. */}
        <form class="flex flex-col gap-5" noValidate onSubmit={save}>
          <Show when={readOnly()}>
            <p class={hintClass}>Only the wedding&apos;s owner can change these settings.</p>
          </Show>

          <div class="grid gap-4 sm:grid-cols-2">
            <label class="flex flex-col gap-1.5">
              <span class={labelClass}>Wedding name</span>
              <input
                type="text"
                value={displayName()}
                maxLength={120}
                autocomplete="off"
                onInput={(e) => setDisplayName(e.currentTarget.value)}
                disabled={disabled()}
                class={inputClass}
              />
            </label>

            <div class="flex flex-col gap-1.5">
              <span class={labelClass}>Invite link</span>
              <p class="font-body text-text border-border bg-bg/50 rounded-sm border px-3 py-2 text-[0.95rem] opacity-70">
                {slug()}
              </p>
              <span class={hintClass}>
                Your invite link can&apos;t be changed — invites you&apos;ve already shared (or
                printed) keep working.
              </span>
            </div>

            <div class="flex flex-col gap-1.5">
              <DatePicker
                label="Wedding date"
                value={weddingDate() || null}
                onChange={(v) => setWeddingDate(v ?? "")}
                readOnly={readOnly()}
                disabled={saving()}
              />
              <Show when={!readOnly()}>
                <span class={hintClass}>
                  Leave this empty if you haven&apos;t set a date yet — you can add it any time.
                </span>
              </Show>
            </div>

            <label class="flex flex-col gap-1.5">
              <span class={labelClass}>Expected guests</span>
              <input
                type="number"
                min="1"
                max="10000"
                step="1"
                value={guestCount()}
                onInput={(e) => setGuestCount(e.currentTarget.value)}
                disabled={disabled()}
                class={inputClass}
              />
            </label>

            <label class="flex flex-col gap-1.5">
              <span class={labelClass}>Currency</span>
              <input
                type="text"
                value={currency()}
                maxLength={3}
                autocomplete="off"
                placeholder="AUD"
                onInput={(e) => setCurrency(e.currentTarget.value.toUpperCase())}
                disabled={disabled()}
                class={inputClass}
              />
              <span class={hintClass}>
                Your main currency — the one your budget and payments are counted in, even if some
                events happen in another country.
              </span>
            </label>
          </div>

          <Show when={!readOnly()}>
            <button
              type="submit"
              disabled={saving()}
              class="border-gold bg-gold font-body text-bg hover:bg-gold-dim self-start rounded-sm border px-4 py-2 text-[0.82rem] tracking-[0.1em] uppercase transition disabled:opacity-40"
            >
              {saving() ? "Saving…" : "Save settings"}
            </button>
          </Show>
        </form>
      </Show>
    </div>
  );
}
