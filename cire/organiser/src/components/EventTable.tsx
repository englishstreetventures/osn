import { useAuth } from "@osn/client/solid";
import { createSignal, onMount, Show, For } from "solid-js";
import { toast } from "solid-toast";

import { apiUrl, isAuthExpired, redirectToLogin } from "../lib/api";
import { cropBackgroundStyle, type ImageCrop } from "../lib/image-crop";
import ImageCropModal from "./ImageCropModal";
import SectionIntro from "./SectionIntro";

interface DressSwatch {
  name: string;
  color: string;
}

interface EventRow {
  id: string;
  name: string;
  slug: string;
  sortOrder: number;
  date: string;
  startAt: string;
  endAt: string;
  timezone: string;
  location: string;
  address: string | null;
  description: string;
  dressCodeDescription: string | null;
  dressCodePalette: DressSwatch[] | null;
  pinterestUrl: string | null;
  mapsUrl: string | null;
  /** First-party path to this event's optional image (or null). API-origin
   * relative — prepend `apiUrl()` before use. */
  imageUrl: string | null;
  /** Normalised crop rectangle the guest site applies (or null for the default
   * centre crop). */
  imageCrop: ImageCrop | null;
}

interface EventTableProps {
  weddingId: string;
}

function formatRange(startAt: string, endAt: string, timezone: string): string {
  try {
    const start = new Date(startAt);
    const end = new Date(endAt);
    const dateFmt = new Intl.DateTimeFormat("en-AU", {
      weekday: "short",
      day: "numeric",
      month: "short",
      year: "numeric",
      timeZone: timezone,
    });
    const timeFmt = new Intl.DateTimeFormat("en-AU", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      timeZone: timezone,
    });
    return `${dateFmt.format(start)} · ${timeFmt.format(start)} – ${timeFmt.format(end)}`;
  } catch {
    return `${startAt} – ${endAt}`;
  }
}

export default function EventTable(props: EventTableProps) {
  const { authFetch } = useAuth();
  const [events, setEvents] = createSignal<EventRow[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal<string | null>(null);

  onMount(async () => {
    try {
      const res = await authFetch(apiUrl(`/api/organiser/weddings/${props.weddingId}/events`));
      if (res.status === 401) return redirectToLogin();
      if (!res.ok) throw new Error("Failed to load");
      setEvents((await res.json()) as EventRow[]);
    } catch (err) {
      if (isAuthExpired(err)) return redirectToLogin();
      setError("Could not load events. Is the API running?");
    } finally {
      setLoading(false);
    }
  });

  /** Patch one event row's imageUrl in place after an upload/remove. An upload or
   * remove also resets the crop server-side, so clear it locally to match. */
  function patchImage(eventId: string, imageUrl: string | null) {
    setEvents((rows) =>
      rows.map((r) => (r.id === eventId ? { ...r, imageUrl, imageCrop: null } : r)),
    );
  }

  /** Patch one event row's crop in place after a crop save/reset. */
  function patchCrop(eventId: string, imageCrop: ImageCrop | null) {
    setEvents((rows) => rows.map((r) => (r.id === eventId ? { ...r, imageCrop } : r)));
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

  const hasEvents = () => events().length > 0;

  return (
    <div class="flex flex-col gap-6">
      <SectionIntro
        eyebrow="Events"
        title="The day, hour by hour"
        description="Every event your guests can be invited to — the details come from your spreadsheet import. Add one photo per event here to bring each card to life."
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
                  <Show when={event.location}>
                    <Detail label="Location" value={event.location} />
                  </Show>
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
                class="border-border h-28 w-full max-w-xs rounded-sm border"
                style={style()}
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
          <ImageCropModal
            imageUrl={url()}
            slot="event"
            initialCrop={props.crop}
            onSave={props.onSaveCrop}
            onReset={() => props.onSaveCrop(null)}
            onClose={() => setCropping(false)}
          />
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
