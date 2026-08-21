import { useAuth } from "@shared/rp-auth/solid";
import { toast } from "@shared/toast";
import { createSignal, onMount, Show } from "solid-js";

import { apiUrl, isAuthExpired, redirectToLogin } from "../lib/api";
import { haptic } from "../lib/haptics";
import { browserTimeZone, describeTimeZone } from "../lib/timezones";
import DatePicker from "./DatePicker";
import SectionIntro from "./SectionIntro";
import Button from "./ui/Button";
import Field, { Input } from "./ui/Field";
import Notice from "./ui/Notice";

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

// `browserTimeZone` + `describeTimeZone` used to live here. They moved to
// `lib/timezones.ts` unchanged when the events drawer needed the same two
// answers ("which zone is this organiser in?" and "what do I call it?") — two
// copies of a cached-`Intl.DateTimeFormat` helper is exactly the kind of thing
// that drifts quietly.

/** Kept for the two blocks that are NOT a control: the read-only invite link,
 *  and the standing notes beside a DatePicker (which draws its own label). Every
 *  real input on this panel goes through `Field`. */
const labelClass = "font-body text-text-muted text-[0.72rem] tracking-[0.1em] uppercase";
const hintClass = "font-body text-text-muted text-[0.75rem] leading-snug";

/** The RSVP-by half of the settings PUT body — on its own it is the whole patch
 *  an editor co-host may send. */
interface RsvpDeadlinePatch {
  rsvpDeadline: string | null;
  rsvpDeadlineTimezone: string | null;
}

/** The owner's patch: the profile fields plus the deadline half. Mirrors the
 *  writable subset of {@link WeddingProfile} — `id` and `slug` are not
 *  settable here. */
interface WeddingSettingsPatch extends RsvpDeadlinePatch {
  displayName: string;
  weddingDate: string | null;
  guestCountEstimate: number | null;
  currency: string;
}

interface SettingsPanelProps {
  weddingId: string;
  /** Owner of this wedding? The profile fields are owner-only — co-hosts see
   *  them read-only. */
  canManage: boolean;
  /** Editor co-host (or owner)? The RSVP-by date is the one field here an
   *  editor may change — chasing replies is exactly their job — so it stays
   *  live while the rest of the form is read-only. Viewers get nothing. */
  canEditRsvpDeadline?: boolean;
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
  // The deadline as the server last gave it to us. A date that lapsed while
  // nobody touched it is a normal state to be sitting in, so the past-date
  // guard below judges the CHANGE, not the value — otherwise a wedding whose
  // RSVP date has passed could never save this panel again.
  const [seededRsvpDeadline, setSeededRsvpDeadline] = createSignal("");

  const [saving, setSaving] = createSignal(false);

  // Two read-only levels: the owner-only profile fields, and the RSVP-by date
  // an editor co-host may move as well. A viewer has neither, so the form
  // renders exactly as it always did for them.
  const readOnly = () => !props.canManage;
  const rsvpReadOnly = () => !props.canManage && !props.canEditRsvpDeadline;
  // The deadline is the last field to go read-only, so anyone who can still
  // edit it has something to save.
  const canSave = () => !rsvpReadOnly();

  function seed(profile: WeddingProfile) {
    setDisplayName(profile.displayName);
    setSlug(profile.slug);
    setWeddingDate(profile.weddingDate ?? "");
    setGuestCount(profile.guestCountEstimate === null ? "" : String(profile.guestCountEstimate));
    setCurrency(profile.currency);
    setRsvpDeadline(profile.rsvpDeadline ?? "");
    setSeededRsvpDeadline(profile.rsvpDeadline ?? "");
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

  /** The RSVP-by half of the body — the whole patch for an editor co-host, and
   *  part of the owner's. Sending the zone as null alongside a cleared date
   *  keeps the two ends in step (the server pairs them too). */
  function rsvpDeadlineFields(): RsvpDeadlinePatch {
    return {
      rsvpDeadline: rsvpDeadline() || null,
      rsvpDeadlineTimezone: rsvpDeadline() ? rsvpDeadlineTimezone() : null,
    };
  }

  /** Today as `YYYY-MM-DD` in the organiser's own zone — the same calendar the
   *  DatePicker draws, so "not before today" means what they see. */
  function todayIso(): string {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  }

  /** A date the server would refuse (400 `rsvp_deadline_in_past`)? A backdated
   *  deadline locks the invite for every guest the moment it saves, so the
   *  server rejects MOVING one into the past for everyone — mirrored here so
   *  the mistake never round-trips. Today is fine (the deadline closes at the
   *  END of its day), and so is a deadline that lapsed while nobody touched it
   *  — otherwise a wedding whose date has passed could never save this panel
   *  again. */
  function deadlineMovedIntoPast(): boolean {
    const picked = rsvpDeadline();
    if (picked === "" || picked === seededRsvpDeadline()) return false;
    return picked < todayIso();
  }

  /** Parse the form into the PUT body, or return a human error. Mirrors the
   *  server's validation so the common mistakes never round-trip. */
  function buildBody(): { body: WeddingSettingsPatch | RsvpDeadlinePatch } | { error: string } {
    if (deadlineMovedIntoPast()) {
      return {
        error:
          "The RSVP-by date can't be moved into the past — guests would be locked out at once.",
      };
    }

    // An editor co-host may write ONLY the deadline: the server 403s a patch
    // that reaches past it, so the body must carry nothing else — not even the
    // unchanged values sitting in the disabled fields.
    if (readOnly()) return { body: rsvpDeadlineFields() };

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
        ...rsvpDeadlineFields(),
      },
    };
  }

  async function save(e: Event) {
    e.preventDefault();
    if (saving() || !canSave()) return;
    const built = buildBody();
    if ("error" in built) {
      haptic("reject");
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
        // A 403 means the server disagrees with this tab about the caller's
        // role — a co-host whose access changed since the page loaded, or one
        // whose form reached past the RSVP-by date. Telling them to "check the
        // fields" would send them hunting for a validation error that isn't
        // there, so permission failures say so.
        haptic("reject");
        toast.error(
          res.status === 403
            ? "You don't have permission to change these settings. Reload the page to see your current access."
            : "Could not save the settings. Please check the fields and try again.",
        );
        return;
      }
      const body = (await res.json()) as { wedding: WeddingProfile };
      seed(body.wedding);
      props.onWeddingUpdated?.({
        displayName: body.wedding.displayName,
        slug: body.wedding.slug,
      });
      haptic("commit");
      toast.success("Settings saved");
    } catch (err) {
      if (isAuthExpired(err)) return redirectToLogin();
      haptic("reject");
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
          <Notice tone="error" alert>
            {message()}
          </Notice>
        )}
      </Show>

      <Show when={!loading() && !loadError()}>
        {/* noValidate: buildBody() mirrors the server's validation with friendlier
            messages, so native constraint UI never fires — and number/step
            constraint math is float-buggy in some DOM engines anyway. */}
        <form class="flex flex-col gap-5" noValidate onSubmit={save}>
          <Show when={readOnly()}>
            <p class={hintClass}>
              Only the wedding&apos;s owner can change these settings.
              <Show when={!rsvpReadOnly()}> The RSVP-by date is yours to set as a co-host.</Show>
            </p>
          </Show>

          {/* Fields flow into as many ≥17rem columns as fit — a date input or a
              three-letter currency code stretched across half a widescreen looks
              broken, and stepping at `@lg/panel` capped the form at two columns
              no matter how much room it had. */}
          <div class="auto-grid items-start [--auto-grid-min:17rem]">
            <Field label="Wedding name">
              {(field) => (
                <Input
                  {...field}
                  value={displayName()}
                  maxLength={120}
                  autocomplete="off"
                  onInput={(e) => setDisplayName(e.currentTarget.value)}
                  disabled={disabled()}
                />
              )}
            </Field>

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
                readOnly={rsvpReadOnly()}
                disabled={saving()}
              />
              <Show
                when={rsvpDeadline()}
                fallback={
                  <Show when={!rsvpReadOnly()}>
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

            <Field label="Expected guests">
              {(field) => (
                <Input
                  {...field}
                  type="number"
                  min="1"
                  max="10000"
                  step="1"
                  value={guestCount()}
                  onInput={(e) => setGuestCount(e.currentTarget.value)}
                  disabled={disabled()}
                />
              )}
            </Field>

            {/* The hint is a `hint`, not a sibling span: inside the old
                `<label>` it was folded into the input's accessible NAME, so the
                box announced as "Currency your main currency the one your
                budget and payments are counted in…". */}
            <Field
              label="Currency"
              hint="Your main currency — the one your budget and payments are counted in, even if some events happen in another country."
            >
              {(field) => (
                <Input
                  {...field}
                  value={currency()}
                  maxLength={3}
                  autocomplete="off"
                  placeholder="AUD"
                  onInput={(e) => setCurrency(e.currentTarget.value.toUpperCase())}
                  disabled={disabled()}
                />
              )}
            </Field>
          </div>

          <Show when={canSave()}>
            <Button type="submit" variant="primary" class="self-start" disabled={saving()}>
              {/* A co-host's save writes the deadline and nothing else, so the
                  label says which — "Save settings" beside five disabled fields
                  reads as a button that will overwrite them. */}
              {saving() ? "Saving…" : readOnly() ? "Save RSVP-by date" : "Save settings"}
            </Button>
          </Show>
        </form>
      </Show>
    </div>
  );
}
