import { useAuth } from "@osn/client/solid";
import { createSignal, For, onMount, Show } from "solid-js";
import { toast } from "solid-toast";

import { apiUrl, isAuthExpired, redirectToLogin } from "../lib/api";
import {
  ensureEventsLoaded,
  type EventRow,
  eventsAccessor,
  patchCachedEvent,
} from "../lib/events-store";
import SectionIntro from "./SectionIntro";

interface GeocodePoint {
  lat: number;
  lng: number;
  formattedAddress: string;
}

type GeocodeResponse =
  | { status: "ok"; point: GeocodePoint; pricingRegion: string }
  | { status: "not_found" }
  | { status: "unavailable" };

/** Pricing-region choices — mirrors the API's closed enum (single source of
 *  truth: `cire/api/src/lib/pricing-regions.ts`); the save is validated
 *  server-side against it. Normally set by the address lookup; the select is
 *  the manual fallback. */
const REGION_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "Not set" },
  { value: "au-nsw", label: "New South Wales" },
  { value: "au-vic", label: "Victoria" },
  { value: "au-qld", label: "Queensland" },
  { value: "au-wa", label: "Western Australia" },
  { value: "au-sa", label: "South Australia" },
  { value: "au-tas", label: "Tasmania" },
  { value: "au-act", label: "ACT" },
  { value: "au-nt", label: "Northern Territory" },
  { value: "au-other", label: "Australia — other" },
  { value: "international", label: "Outside Australia" },
];

const labelClass = "font-body text-text-muted text-[0.72rem] tracking-[0.1em] uppercase";
const inputClass =
  "border-border bg-bg font-body text-text focus:border-gold rounded-sm border px-3 py-2 text-[0.9rem] transition-colors outline-none placeholder:opacity-40 disabled:opacity-40";
const hintClass = "font-body text-text-muted text-[0.75rem] leading-snug";

/** One event row's editable location, kept as input strings so half-typed
 *  numbers never round-trip through a parse. */
interface RowDraft {
  lat: string;
  lng: string;
  region: string;
  note: string | null;
  busy: boolean;
}

const draftFromEvent = (e: EventRow): RowDraft => ({
  lat: e.locationLat === null ? "" : String(e.locationLat),
  lng: e.locationLng === null ? "" : String(e.locationLng),
  region: e.pricingRegion ?? "",
  note: null,
  busy: false,
});

/**
 * Per-event location editor (Events tab). Location is EVENT-scoped — one
 * wedding can celebrate across countries (a Sydney reception + Jaipur
 * ceremonies), so each event carries its own point + pricing region while the
 * wedding keeps a single main currency in Settings. The venue address itself
 * comes from the events sheet (read-only here); "Look up" geocodes it
 * server-side when a key is configured, and the coordinate/region fields stay
 * manually editable either way. Member-level like the import — co-hosts can
 * edit (the API gates with weddingMember()).
 */
export default function EventLocationsPanel(props: { weddingId: string }) {
  const { authFetch } = useAuth();
  const events = () => eventsAccessor(props.weddingId)() ?? [];
  const [loaded, setLoaded] = createSignal(false);
  // One draft per event id, seeded lazily from the cached rows.
  const [drafts, setDrafts] = createSignal<Record<string, RowDraft>>({});
  // Flips true the first time the server answers `unavailable` — the Look up
  // buttons hide and the manual-entry hint shows (key-optional degradation
  // discovered on use; no extra request just to probe availability).
  const [geocodeDown, setGeocodeDown] = createSignal(false);

  onMount(async () => {
    try {
      await ensureEventsLoaded(props.weddingId, async () => {
        const res = await authFetch(apiUrl(`/api/organiser/weddings/${props.weddingId}/events`));
        if (res.status === 401) {
          redirectToLogin();
          throw new Error("unauthenticated");
        }
        if (!res.ok) throw new Error("Failed to load");
        return (await res.json()) as EventRow[];
      });
    } catch (err) {
      if (isAuthExpired(err)) return redirectToLogin();
      // EventTable (mounted above on the same tab) already surfaces the load
      // error — this panel just stays hidden rather than doubling the message.
    } finally {
      setLoaded(true);
    }
  });

  const draftFor = (event: EventRow): RowDraft => drafts()[event.id] ?? draftFromEvent(event);

  function patchDraft(event: EventRow, patch: Partial<RowDraft>) {
    setDrafts((prev) => ({ ...prev, [event.id]: { ...draftFor(event), ...patch } }));
  }

  async function lookUp(event: EventRow) {
    const query = (event.address ?? "").trim();
    if (!query) return;
    patchDraft(event, { busy: true, note: null });
    try {
      const res = await authFetch(
        apiUrl(`/api/organiser/weddings/${props.weddingId}/settings/geocode`),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query }),
        },
      );
      if (res.status === 401) return redirectToLogin();
      if (!res.ok) {
        patchDraft(event, { note: "The lookup failed — you can enter coordinates instead." });
        return;
      }
      const body = (await res.json()) as GeocodeResponse;
      if (body.status === "ok") {
        patchDraft(event, {
          lat: String(body.point.lat),
          lng: String(body.point.lng),
          region: body.pricingRegion,
          note: `Matched: ${body.point.formattedAddress}`,
        });
      } else if (body.status === "not_found") {
        patchDraft(event, { note: "No match for that address — enter coordinates instead." });
      } else {
        setGeocodeDown(true);
        patchDraft(event, { note: "Lookup isn't available — enter coordinates manually." });
      }
    } catch (err) {
      if (isAuthExpired(err)) return redirectToLogin();
      patchDraft(event, { note: "The lookup failed — you can enter coordinates instead." });
    } finally {
      patchDraft(event, { busy: false });
    }
  }

  async function save(event: EventRow) {
    const draft = draftFor(event);
    if (draft.busy) return;

    const latText = draft.lat.trim();
    const lngText = draft.lng.trim();
    if ((latText === "") !== (lngText === "")) {
      toast.error("Enter both a latitude and a longitude, or neither.");
      return;
    }
    const lat = latText === "" ? null : Number(latText);
    const lng = lngText === "" ? null : Number(lngText);
    if (lat !== null && (!Number.isFinite(lat) || Math.abs(lat) > 90)) {
      toast.error("Latitude must be a number between -90 and 90.");
      return;
    }
    if (lng !== null && (!Number.isFinite(lng) || Math.abs(lng) > 180)) {
      toast.error("Longitude must be a number between -180 and 180.");
      return;
    }

    patchDraft(event, { busy: true });
    try {
      const res = await authFetch(
        apiUrl(`/api/organiser/weddings/${props.weddingId}/events/${event.id}/location`),
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            locationLat: lat,
            locationLng: lng,
            pricingRegion: draft.region || null,
          }),
        },
      );
      if (res.status === 401) return redirectToLogin();
      if (!res.ok) {
        toast.error(`Could not save the location for ${event.name}.`);
        return;
      }
      // Write through the shared cache so EventTable rows + a remount reflect
      // the save without a refetch.
      patchCachedEvent(props.weddingId, event.id, {
        locationLat: lat,
        locationLng: lng,
        pricingRegion: draft.region || null,
      });
      toast.success(`Location saved for ${event.name}`);
    } catch (err) {
      if (isAuthExpired(err)) return redirectToLogin();
      toast.error(`Could not save the location for ${event.name}. Is the API running?`);
    } finally {
      patchDraft(event, { busy: false });
    }
  }

  return (
    <Show when={loaded() && events().length > 0}>
      <div class="border-border bg-surface/30 flex flex-col gap-5 rounded-sm border p-6">
        <SectionIntro
          eyebrow="Locations"
          title="Where each event happens"
          description="Weddings don't all happen in one place — a reception here, ceremonies overseas. Pin each event so planning tools like vendor search and price estimates use the right place, per event. Guests never see any of this; the invite shows the address from your events sheet."
        />

        <Show when={geocodeDown()}>
          <p class={hintClass}>
            Address lookup isn&apos;t available right now — enter coordinates and a region by hand.
          </p>
        </Show>

        <ul class="m-0 flex list-none flex-col gap-4 p-0">
          <For each={events()}>
            {(event) => {
              const draft = () => draftFor(event);
              return (
                <li class="border-border bg-bg/40 flex flex-col gap-3 rounded-sm border p-4">
                  <div class="flex flex-wrap items-baseline justify-between gap-2">
                    <span class="font-body text-text text-[0.95rem]">{event.name}</span>
                    <span class={hintClass}>
                      {event.address ?? "No address on the events sheet"}
                    </span>
                  </div>

                  <div class="flex flex-wrap items-end gap-3">
                    <label class="flex min-w-28 flex-1 flex-col gap-1.5">
                      <span class={labelClass}>Latitude</span>
                      <input
                        type="text"
                        inputmode="decimal"
                        value={draft().lat}
                        autocomplete="off"
                        onInput={(e) => patchDraft(event, { lat: e.currentTarget.value })}
                        disabled={draft().busy}
                        class={inputClass}
                      />
                    </label>
                    <label class="flex min-w-28 flex-1 flex-col gap-1.5">
                      <span class={labelClass}>Longitude</span>
                      <input
                        type="text"
                        inputmode="decimal"
                        value={draft().lng}
                        autocomplete="off"
                        onInput={(e) => patchDraft(event, { lng: e.currentTarget.value })}
                        disabled={draft().busy}
                        class={inputClass}
                      />
                    </label>
                    <label class="flex min-w-36 flex-1 flex-col gap-1.5">
                      <span class={labelClass}>Region</span>
                      <select
                        value={draft().region}
                        onChange={(e) => patchDraft(event, { region: e.currentTarget.value })}
                        disabled={draft().busy}
                        class={inputClass}
                      >
                        <For each={REGION_OPTIONS}>
                          {(option) => <option value={option.value}>{option.label}</option>}
                        </For>
                      </select>
                    </label>
                    <Show when={!geocodeDown()}>
                      <button
                        type="button"
                        onClick={() => void lookUp(event)}
                        disabled={draft().busy || (event.address ?? "").trim() === ""}
                        title={
                          (event.address ?? "").trim() === ""
                            ? "Add an address to this event in the events sheet first"
                            : "Find coordinates from the event's address"
                        }
                        class="border-border font-body text-text hover:border-gold hover:text-gold rounded-sm border px-4 py-2 text-[0.78rem] tracking-[0.1em] uppercase transition disabled:opacity-40"
                      >
                        {draft().busy ? "Working…" : "Look up"}
                      </button>
                    </Show>
                    <button
                      type="button"
                      onClick={() => void save(event)}
                      disabled={draft().busy}
                      class="border-gold bg-gold font-body text-bg hover:bg-gold-dim rounded-sm border px-4 py-2 text-[0.78rem] tracking-[0.1em] uppercase transition disabled:opacity-40"
                    >
                      Save
                    </button>
                  </div>

                  <Show when={draft().note}>{(note) => <p class={hintClass}>{note()}</p>}</Show>
                </li>
              );
            }}
          </For>
        </ul>
      </div>
    </Show>
  );
}
