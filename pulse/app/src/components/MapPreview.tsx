import { openUrl } from "@tauri-apps/plugin-opener";
import type * as Leaflet from "leaflet";
import { onCleanup, onMount, Show } from "solid-js";

/**
 * Read-only map preview for the event detail page. Uses Leaflet + OSM tiles
 * (no API key required, no third-party JS bundle requirements).
 *
 * Falls back to a text "location" card when coordinates are missing.
 *
 * P-W3: Leaflet (~150KB + CSS) is loaded via a dynamic `await import`
 * inside `onMount` rather than a top-level import, so events without
 * coordinates never pay for the chunk and the home feed never fetches
 * it at all (route-level splitting in `App.tsx` handles the home case).
 */
export function MapPreview(props: {
  latitude: number | null;
  longitude: number | null;
  label?: string | null;
}) {
  let mapEl: HTMLDivElement | undefined;
  let map: Leaflet.Map | undefined;

  onMount(async () => {
    if (!mapEl || props.latitude == null || props.longitude == null) return;
    // Dynamic imports — Vite emits Leaflet + its CSS into their own
    // chunk that's only fetched the first time this onMount runs.
    const [{ default: L }] = await Promise.all([
      import("leaflet"),
      import("leaflet/dist/leaflet.css"),
    ]);
    if (!mapEl) return; // component unmounted while we awaited
    map = L.map(mapEl, {
      center: [props.latitude, props.longitude],
      zoom: 15,
      zoomControl: false,
      attributionControl: true,
      scrollWheelZoom: false,
      dragging: true,
    });
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      maxZoom: 19,
    }).addTo(map);
    L.marker([props.latitude, props.longitude]).addTo(map);
  });

  onCleanup(() => {
    map?.remove();
  });

  async function findDirections() {
    if (props.latitude == null || props.longitude == null) return;
    // Use an `apple.com/maps` URL — on iOS it hands off to Apple Maps,
    // and on other platforms it redirects to the web viewer. Safer than
    // `maps://` which can silently fail on non-Apple web targets.
    const url = `https://maps.apple.com/?daddr=${encodeURIComponent(
      `${props.latitude},${props.longitude}`,
    )}`;
    try {
      await openUrl(url);
    } catch {
      // On non-Tauri web targets `openUrl` is unavailable — fall back to
      // a regular anchor navigation.
      window.open(url, "_blank", "noopener,noreferrer");
    }
  }

  return (
    <Show
      when={props.latitude != null && props.longitude != null}
      fallback={
        <Show when={props.label}>
          <div class="border-border bg-card rounded-xl border p-4">
            <p class="text-foreground text-sm font-medium">Location</p>
            <p class="text-muted-foreground text-sm">{props.label}</p>
          </div>
        </Show>
      }
    >
      <div class="border-border bg-card overflow-hidden rounded-xl border">
        <div ref={mapEl} class="h-48 w-full" />
        <div class="flex items-center justify-between gap-3 p-3">
          <Show when={props.label}>
            <p class="text-muted-foreground truncate text-xs">{props.label}</p>
          </Show>
          <button
            type="button"
            onClick={findDirections}
            class="bg-primary text-primary-foreground hover:bg-primary/90 shrink-0 rounded-md px-3 py-1.5 text-xs font-medium"
          >
            Find directions
          </button>
        </div>
      </div>
    </Show>
  );
}
