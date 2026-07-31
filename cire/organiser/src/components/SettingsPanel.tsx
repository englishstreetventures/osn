import { useAuth } from "@shared/rp-auth/solid";
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
  /** The "kindly respond by" date (`YYYY-MM-DD`), or null for no deadline. */
  rsvpDeadline: string | null;
  /** IANA zone the deadline day is measured in; null ⇒ UTC. */
  rsvpDeadlineTimezone: string | null;
}

/** The organiser's own zone, used to stamp a deadline they've just picked. A
 *  browser that won't name its zone (ancient/locked-down) falls back to UTC —
 *  the same default the API applies to a zone-less deadline. */
function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** Zone-name formatters, cached by zone (P-I3). Construction is the expensive
 *  part; only successful lookups are stored, so an unresolvable zone costs a
 *  throwaway construction and can't grow the map. */
const zoneNameFormatters = new Map<string, Intl.DateTimeFormat>();

function zoneNameFormatter(zone: string): Intl.DateTimeFormat | null {
  const cached = zoneNameFormatters.get(zone);
  if (cached) return cached;
  try {
    const formatter = new Intl.DateTimeFormat("en-AU", { timeZone: zone, timeZoneName: "short" });
    zoneNameFormatters.set(zone, formatter);
    return formatter;
  } catch {
    return null;
  }
}

/** "Australia/Sydney" → "Australia/Sydney (AEST)" where the runtime can name
 *  the abbreviation, so the hint says something an organiser recognises. */
function describeTimeZone(zone: string, on: string | null): string {
  const at = on ? new Date(`${on}T12:00:00Z`) : new Date();
  if (Number.isNaN(at.getTime())) return zone;
  const short = zoneNameFormatter(zone)
    ?.formatToParts(at)
    .find((p) => p.type === "timeZoneName")?.value;
  return short && short !== zone ? `${zone} (${short})` : zone;
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
  // The RSVP deadline is a date + the zone its day is measured in. The zone is
  // never picked by hand: it's whatever was stored, and it re-stamps to the
  // organiser's own zone the moment they CHANGE the date — so saving an
  // unrelated field from another country can't quietly move the deadline.
  const [rsvpDeadline, setRsvpDeadline] = createSignal("");
  const [rsvpDeadlineTimezone, setRsvpDeadlineTimezone] = createSignal<string | null>(null);

  const [saving, setSaving] = createSignal(false);

  const readOnly = () => !props.canManage;

  function seed(profile: WeddingProfile) {
    setDisplayName(profile.displayName);
    setSlug(profile.slug);
    setWeddingDate(profile.weddingDate ?? "");
    setGuestCount(profile.guestCountEstimate === null ? "" : String(profile.guestCountEstimate));
    setCurrency(profile.currency);
    setRsvpDeadline(profile.rsvpDeadline ?? "");
    setRsvpDeadlineTimezone(profile.rsvpDeadlineTimezone);
  }

  /** Pick (or clear) the RSVP-by date. Clearing drops the zone with it; picking
   *  stamps the organiser's current zone, which is the day they mean. */
  function changeRsvpDeadline(value: string | null) {
    setRsvpDeadline(value ?? "");
    setRsvpDeadlineTimezone(value ? browserTimeZone() : null);
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
        rsvpDeadline: rsvpDeadline() || null,
        // Paired with the date on the server too (clearing one clears both);
        // sending null here just keeps the two ends in step.
        rsvpDeadlineTimezone: rsvpDeadline() ? rsvpDeadlineTimezone() : null,
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
        description="The facts that drive your planning tools — the date and roughly how many guests, in the currency you think in. Where each event happens is set per event on the Events tab, so celebrations across cities or countries just work. Guests only ever see the name, the invite link and the RSVP-by date; the rest is yours alone."
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

          {/* Fields flow into as many ≥17rem columns as fit — a date input or a
              three-letter currency code stretched across half a widescreen looks
              broken, and stepping at `@lg/panel` capped the form at two columns
              no matter how much room it had. */}
          <div class="auto-grid items-start [--auto-grid-min:17rem]">
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

            {/* The one field on this panel guests actually feel — hence the
                explicit "guests see this" wording in the hint, against a
                section whose intro says the opposite of everything else here. */}
            <div class="flex flex-col gap-1.5">
              <DatePicker
                label="RSVP by"
                value={rsvpDeadline() || null}
                onChange={changeRsvpDeadline}
                readOnly={readOnly()}
                disabled={saving()}
              />
              <Show
                when={rsvpDeadline()}
                fallback={
                  <Show when={!readOnly()}>
                    <span class={hintClass}>
                      Leave this empty to keep RSVPs open — guests can reply, and change their
                      reply, right up to the day.
                    </span>
                  </Show>
                }
              >
                <span class={hintClass}>
                  Guests see this date on their invite and can reply until the end of that day (
                  {describeTimeZone(rsvpDeadlineTimezone() ?? "UTC", rsvpDeadline())}). After that
                  the invite locks — you can still record late replies yourself from the Guests tab.
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
