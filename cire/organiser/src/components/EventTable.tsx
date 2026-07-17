import { useAuth } from "@osn/client/solid";
import { createSignal, lazy, onMount, Show, For, Suspense } from "solid-js";
import { toast } from "solid-toast";

import { apiUrl, isAuthExpired, redirectToLogin } from "../lib/api";
import { downloadBlob } from "../lib/download";
import {
  ensureEventsLoaded,
  type EventRow,
  eventsAccessor,
  hasCachedEvents,
  patchCachedEvent,
} from "../lib/events-store";
import {
  CROP_ASPECT,
  cropAspectRatio,
  cropBackgroundStyle,
  type ImageCrop,
} from "../lib/image-crop";
import SectionIntro from "./SectionIntro";

const ImageCropModal = lazy(() => import("./ImageCropModal"));

/** Module-scope formatter cache keyed by timezone — each timezone's two formatters
 * are constructed once and reused across all row renders and re-renders. */
const fmtCache = new Map<string, { dateFmt: Intl.DateTimeFormat; timeFmt: Intl.DateTimeFormat }>();

function getFormatters(timezone: string) {
  const cached = fmtCache.get(timezone);
  if (cached) return cached;
  const entry = {
    dateFmt: new Intl.DateTimeFormat("en-AU", {
      weekday: "short",
      day: "numeric",
      month: "short",
      year: "numeric",
      timeZone: timezone,
    }),
    timeFmt: new Intl.DateTimeFormat("en-AU", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      timeZone: timezone,
    }),
  };
  fmtCache.set(timezone, entry);
  return entry;
}

interface EventTableProps {
  weddingId: string;
  /** URL slug of the wedding — embedded in the events CSV download filename. */
  weddingSlug: string;
}

function formatRange(startAt: string, endAt: string, timezone: string): string {
  try {
    const start = new Date(startAt);
    const { dateFmt, timeFmt } = getFormatters(timezone);
    // endAt "" = no stated end — show just the start time.
    const end = endAt.trim().length === 0 ? null : new Date(endAt);
    const endLabel = end === null || Number.isNaN(end.getTime()) ? "" : ` – ${timeFmt.format(end)}`;
    return `${dateFmt.format(start)} · ${timeFmt.format(start)}${endLabel}`;
  } catch {
    return endAt.trim().length === 0 ? startAt : `${startAt} – ${endAt}`;
  }
}

export default function EventTable(props: EventTableProps) {
  const { authFetch } = useAuth();
  // Events live in a module-scoped, weddingId-keyed cache (`../lib/events-store`)
  // so this fetch fires once per wedding and is reused when the dashboard tabs
  // unmount/remount us on a Guests ↔ Events switch. A wedding change keys to a
  // fresh entry; an import apply invalidates the entry (see ImportPanel) so the
  // next mount refetches.
  const events = () => eventsAccessor(props.weddingId)() ?? [];
  // Show the skeleton only while we have nothing to render yet — a cache hit
  // means we already have rows, so a remount paints them immediately.
  const [loading, setLoading] = createSignal(!hasCachedEvents(props.weddingId));
  const [error, setError] = createSignal<string | null>(null);
  const [exporting, setExporting] = createSignal(false);

  onMount(async () => {
    // ensureEventsLoaded resolves immediately on a cache hit and dedupes an
    // in-flight fetch with any sibling panel mounting in the same tick — one
    // request per wedding either way.
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
      setError("Could not load events. Is the API running?");
    } finally {
      setLoading(false);
    }
  });

  /** Patch one event row's imageUrl in place after an upload/remove. An upload or
   * remove also resets the crop server-side, so clear it locally to match.
   * Writes through the cache so the edit survives a tab switch. */
  function patchImage(eventId: string, imageUrl: string | null) {
    patchCachedEvent(props.weddingId, eventId, { imageUrl, imageCrop: null });
  }

  /** Patch one event row's crop in place after a crop save/reset. */
  function patchCrop(eventId: string, imageCrop: ImageCrop | null) {
    patchCachedEvent(props.weddingId, eventId, { imageCrop });
  }

  const eventImageBase = (eventId: string) =>
    `/api/organiser/weddings/${props.weddingId}/events/${eventId}/image`;

  // One image per event — a re-upload REPLACES the current one (the API points
  // the single `event_image_key` column at the new R2 object). Mirrors the
  // InviteBuilder uploadImage/removeImage toast pattern.
  async function uploadImage(eventId: string, file: File) {
    setError(null);
    try {
      const res = await authFetch(apiUrl(eventImageBase(eventId)), { method: "POST", body: file });
      if (res.status === 401) return redirectToLogin();
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Upload failed (${res.status})`);
      }
      const { imageUrl } = (await res.json()) as { imageUrl: string };
      patchImage(eventId, imageUrl);
      toast.success("Event image updated");
    } catch (err) {
      if (isAuthExpired(err)) return redirectToLogin();
      toast.error(err instanceof Error ? err.message : "Upload failed.");
    }
  }

  async function removeImage(eventId: string) {
    setError(null);
    try {
      const res = await authFetch(apiUrl(eventImageBase(eventId)), { method: "DELETE" });
      if (res.status === 401) return redirectToLogin();
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Remove failed (${res.status})`);
      }
      patchImage(eventId, null);
      toast.success("Event image removed");
    } catch (err) {
      if (isAuthExpired(err)) return redirectToLogin();
      toast.error(err instanceof Error ? err.message : "Remove failed.");
    }
  }

  // Save (or reset, with `crop: null`) an event image's crop rectangle. Throws on
  // failure so the modal can keep itself open and surface a retry.
  async function saveCrop(eventId: string, crop: ImageCrop | null) {
    const res = await authFetch(apiUrl(`${eventImageBase(eventId)}/crop`), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ crop }),
    });
    if (res.status === 401) {
      redirectToLogin();
      throw new Error("unauthorised");
    }
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? `Save failed (${res.status})`);
    }
    patchCrop(eventId, crop);
    toast.success(crop ? "Crop saved" : "Crop reset");
  }

  /**
   * Download the wedding's event list CSV. Built (and formula-sanitised)
   * server-side at `GET …/events.csv`; the response Blob is handed to the
   * shared download helper. Gated by `weddingMember()` so the owner OR a
   * co-host can export — same pattern as the Guests tab's exports.
   */
  async function exportEvents() {
    if (exporting()) return;
    setExporting(true);
    try {
      const res = await authFetch(apiUrl(`/api/organiser/weddings/${props.weddingId}/events.csv`));
      if (res.status === 401) return redirectToLogin();
      if (!res.ok) throw new Error(`Export failed (${res.status})`);
      const blob = await res.blob();
      downloadBlob(`cire-events-${props.weddingSlug}.csv`, blob);
      toast.success("Events export downloaded");
    } catch (err) {
      if (isAuthExpired(err)) return redirectToLogin();
      toast.error("Events export failed. Try again.");
    } finally {
      setExporting(false);
    }
  }

  const hasEvents = () => events().length > 0;

  return (
    <div class="flex flex-col gap-6">
      <SectionIntro
        eyebrow="Events"
        title="The day, hour by hour"
        description="Every event your guests can be invited to — the details come from your spreadsheet import. Add one photo per event here to bring each card to life."
        actions={
          <Show when={!loading() && !error() && hasEvents()}>
            <button
              type="button"
              onClick={() => void exportEvents()}
              disabled={exporting()}
              class="border-gold/40 font-body text-gold hover:border-gold hover:bg-gold/10 rounded-sm border px-3 py-1.5 text-[0.72rem] tracking-[0.1em] uppercase transition disabled:opacity-40"
            >
              {exporting() ? "Exporting…" : "Download events (CSV)"}
            </button>
          </Show>
        }
      />

      <Show when={loading()}>
        <div class="flex flex-col gap-3">
          <For each={[1, 2, 3, 4]}>
            {() => <div class="bg-surface h-[140px] animate-pulse rounded-sm" />}
          </For>
        </div>
      </Show>

      <Show when={error()}>
        <p class="border-error/20 bg-error/5 text-error rounded-sm border p-4 text-[0.88rem]">
          {error()}
        </p>
      </Show>

      <Show when={!loading() && !error() && !hasEvents()}>
        <div class="border-border bg-surface/30 flex flex-col items-start gap-2 rounded-sm border border-dashed p-8 text-center">
          <p class="font-display text-gold-dim w-full text-[1.2rem] italic">No events yet</p>
          <p class="font-body text-text-muted w-full text-[0.85rem] leading-relaxed">
            Import your events sheet from the Spreadsheet Import above. Add the events first —
            guests are matched to events that already exist.
          </p>
        </div>
      </Show>

      <Show when={!loading() && !error() && hasEvents()}>
        <p class="font-body text-text-muted text-[0.82rem]">
          {events().length} {events().length === 1 ? "event" : "events"} · uploading a photo
          replaces the current one
        </p>

        <ul class="flex flex-col gap-4">
          <For each={events()}>
            {(event) => (
              <li class="border-border bg-surface/30 flex flex-col gap-3 rounded-sm border p-5">
                <header class="flex flex-col gap-1">
                  <span class="font-body text-gold text-[0.72rem] tracking-[0.2em] uppercase">
                    {event.slug}
                  </span>
                  <h3 class="font-display text-text text-[1.5rem] font-light italic">
                    {event.name}
                  </h3>
                  <p class="font-body text-text-muted text-[0.82rem]">
                    {formatRange(event.startAt, event.endAt, event.timezone)} · {event.timezone}
                  </p>
                </header>

                <dl class="font-body grid grid-cols-1 gap-x-6 gap-y-2 text-[0.88rem] md:grid-cols-2">
                  <Show when={event.address}>
                    <Detail label="Address" value={event.address!} />
                  </Show>
                  <Show when={event.description}>
                    <Detail label="Notes" value={event.description} span />
                  </Show>
                  <Show when={event.dressCodeDescription}>
                    <Detail label="Dress code" value={event.dressCodeDescription!} span />
                  </Show>
                </dl>

                <Show when={event.dressCodePalette && event.dressCodePalette.length > 0}>
                  <div class="flex flex-wrap gap-2">
                    <For each={event.dressCodePalette!}>
                      {(swatch) => (
                        <span
                          class="border-border bg-bg font-body text-text-muted inline-flex items-center gap-2 rounded-sm border px-2 py-1 text-[0.72rem] tracking-[0.06em] uppercase"
                          title={swatch.color}
                        >
                          <span
                            class="border-border inline-block h-3 w-3 rounded-sm border"
                            style={{ background: swatch.color }}
                          />
                          {swatch.name}
                        </span>
                      )}
                    </For>
                  </div>
                </Show>

                <Show when={event.pinterestUrl || event.mapsUrl}>
                  <div class="font-body flex flex-wrap gap-4 pt-1 text-[0.82rem]">
                    <Show when={event.mapsUrl}>
                      <a
                        href={event.mapsUrl!}
                        target="_blank"
                        rel="noreferrer"
                        class="text-gold underline-offset-4 hover:underline"
                      >
                        Maps ↗
                      </a>
                    </Show>
                    <Show when={event.pinterestUrl}>
                      <a
                        href={event.pinterestUrl!}
                        target="_blank"
                        rel="noreferrer"
                        class="text-gold underline-offset-4 hover:underline"
                      >
                        Pinterest ↗
                      </a>
                    </Show>
                  </div>
                </Show>

                <EventImageField
                  url={event.imageUrl}
                  crop={event.imageCrop}
                  onSelect={(f) => void uploadImage(event.id, f)}
                  onRemove={() => void removeImage(event.id)}
                  onSaveCrop={(c) => saveCrop(event.id, c)}
                />
              </li>
            )}
          </For>
        </ul>
      </Show>
    </div>
  );
}

/**
 * Per-event image control — file input (JPEG/PNG/WebP), preview thumbnail, and a
 * Remove button when an image is set. Reuses the look + behaviour of the
 * InviteBuilder's ImageField. One image per event: re-uploading replaces it.
 */
function EventImageField(props: {
  url: string | null;
  crop: ImageCrop | null;
  onSelect: (file: File) => void;
  onRemove: () => void;
  onSaveCrop: (crop: ImageCrop | null) => Promise<void>;
}) {
  const [cropping, setCropping] = createSignal(false);
  const absoluteUrl = (): string | null => (props.url ? apiUrl(props.url) : null);
  // WYSIWYG thumbnail: render the cropped region with the same fraction technique
  // the guest event card uses; fall back to the plain object-cover image with no
  // crop.
  const cropStyle = () => {
    const url = absoluteUrl();
    return url ? cropBackgroundStyle(url, props.crop) : null;
  };

  return (
    <div class="border-border/60 mt-1 flex flex-col gap-2 rounded-sm border border-dashed p-3">
      <span class="font-body text-text-muted text-[0.72rem] tracking-[0.1em] uppercase">
        Event image
      </span>
      <Show when={absoluteUrl()}>
        {(url) => (
          <Show
            when={cropStyle()}
            fallback={
              <img
                src={url()}
                alt=""
                class="border-border h-28 w-full max-w-xs rounded-sm border object-cover"
              />
            }
          >
            {(style) => (
              <div
                aria-label="Event image (cropped)"
                // WYSIWYG with the guest event card: the box adopts the crop's true
                // pixel aspect, the region scales uniformly inside it (no stretch).
                class="border-border w-full max-w-xs overflow-hidden rounded-sm border"
                style={{
                  ...style(),
                  "aspect-ratio": String(cropAspectRatio(props.crop, CROP_ASPECT.event)),
                }}
              />
            )}
          </Show>
        )}
      </Show>
      <div class="flex flex-wrap items-center gap-3">
        <input
          type="file"
          accept="image/jpeg,image/png,image/webp"
          aria-label="Event image"
          onChange={(e) => {
            const file = e.currentTarget.files?.[0];
            if (file) props.onSelect(file);
            e.currentTarget.value = "";
          }}
          class="font-body text-text file:border-border file:bg-bg file:font-body file:text-text hover:file:border-gold text-[0.82rem] file:mr-3 file:rounded-sm file:border file:px-3 file:py-1.5 file:text-[0.82rem]"
        />
        <Show when={props.url}>
          <button
            type="button"
            onClick={() => setCropping(true)}
            class="font-body text-gold text-[0.82rem] underline-offset-4 hover:underline"
          >
            Crop
          </button>
          <button
            type="button"
            onClick={() => props.onRemove()}
            class="font-body text-text-muted text-[0.82rem] underline-offset-4 hover:underline"
          >
            Remove
          </button>
        </Show>
      </div>
      <Show when={cropping() && absoluteUrl()}>
        {(url) => (
          <Suspense>
            <ImageCropModal
              imageUrl={url()}
              slot="event"
              initialCrop={props.crop}
              onSave={props.onSaveCrop}
              onReset={() => props.onSaveCrop(null)}
              onClose={() => setCropping(false)}
            />
          </Suspense>
        )}
      </Show>
    </div>
  );
}

function Detail(props: { label: string; value: string; span?: boolean }) {
  return (
    <div class={props.span ? "md:col-span-2" : ""}>
      <dt class="font-body text-text-muted text-[0.72rem] tracking-[0.1em] uppercase">
        {props.label}
      </dt>
      <dd class="text-text">{props.value}</dd>
    </div>
  );
}
