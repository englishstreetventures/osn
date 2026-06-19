import { useAuth } from "@osn/client/solid";
import { createSignal, onMount, Show, For } from "solid-js";
import { toast } from "solid-toast";

import { apiUrl, isAuthExpired, redirectToLogin } from "../lib/api";

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

  /** Patch one event row's imageUrl in place after an upload/remove. */
  function patchImage(eventId: string, imageUrl: string | null) {
    setEvents((rows) => rows.map((r) => (r.id === eventId ? { ...r, imageUrl } : r)));
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

  return (
    <div class="flex flex-col gap-6">
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

      <Show when={!loading() && !error()}>
        <div class="flex flex-col gap-1">
          <p class="font-body text-text-muted text-[0.82rem]">{events().length} events</p>
          <p class="font-body text-text-muted text-[0.72rem] italic">
            Event details come from your spreadsheet import. You can add one image per event below —
            uploading replaces the current one.
          </p>
        </div>

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
                  onSelect={(f) => void uploadImage(event.id, f)}
                  onRemove={() => void removeImage(event.id)}
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
  onSelect: (file: File) => void;
  onRemove: () => void;
}) {
  return (
    <div class="border-border/60 mt-1 flex flex-col gap-2 rounded-sm border border-dashed p-3">
      <span class="font-body text-text-muted text-[0.72rem] tracking-[0.1em] uppercase">
        Event image
      </span>
      <Show when={props.url}>
        {(url) => (
          <img
            src={apiUrl(url())}
            alt=""
            class="border-border h-28 w-full max-w-xs rounded-sm border object-cover"
          />
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
            onClick={() => props.onRemove()}
            class="font-body text-text-muted text-[0.82rem] underline-offset-4 hover:underline"
          >
            Remove
          </button>
        </Show>
      </div>
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
