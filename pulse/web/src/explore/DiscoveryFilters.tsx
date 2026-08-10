import { Button } from "@osn/ui/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@osn/ui/ui/dialog";
import { Input } from "@osn/ui/ui/input";
import { Label } from "@osn/ui/ui/label";
import { Show, createSignal } from "solid-js";

export interface DiscoveryFilterValues {
  from: string | null;
  to: string | null;
  radiusKm: number | null;
  /**
   * S-L2/P-W2: location is resolved at most once per filter session, when
   * the user explicitly clicks "Use my location". The drawer never fires
   * `navigator.geolocation` implicitly. If the user enters a radius
   * without granting location, the filter is dropped silently with an
   * inline explainer.
   */
  coords: { lat: number; lng: number } | null;
  priceMin: number | null;
  priceMax: number | null;
  friendsOnly: boolean;
}

export const emptyFilters = (): DiscoveryFilterValues => ({
  from: null,
  to: null,
  radiusKm: null,
  coords: null,
  priceMin: null,
  priceMax: null,
  friendsOnly: false,
});

export const hasActiveFilters = (v: DiscoveryFilterValues): boolean =>
  v.from != null ||
  v.to != null ||
  v.radiusKm != null ||
  v.priceMin != null ||
  v.priceMax != null ||
  v.friendsOnly;

const toNumberOrNull = (raw: string): number | null => {
  if (raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
};

async function getCurrentPosition(): Promise<{ lat: number; lng: number } | null> {
  if (typeof navigator === "undefined" || !navigator.geolocation) return null;
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => resolve(null),
      { timeout: 5000, maximumAge: 60_000 },
    );
  });
}

export function DiscoveryFilters(props: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  signedIn: boolean;
  value: DiscoveryFilterValues;
  onApply: (v: DiscoveryFilterValues) => void;
}) {
  // Internal draft — applied to the outer state only when the user clicks
  // Apply, so a partial edit doesn't trigger a refetch on every keystroke.
  const [draft, setDraft] = createSignal<DiscoveryFilterValues>({ ...props.value });
  const [geoBusy, setGeoBusy] = createSignal(false);
  const [geoError, setGeoError] = createSignal<string | null>(null);

  const setField = <K extends keyof DiscoveryFilterValues>(
    key: K,
    value: DiscoveryFilterValues[K],
  ) => setDraft((prev) => ({ ...prev, [key]: value }));

  return (
    <Dialog
      open={props.open}
      onOpenChange={(v) => {
        if (v) setDraft({ ...props.value });
        props.onOpenChange(v);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>More filters</DialogTitle>
        </DialogHeader>

        <div class="flex flex-col gap-4 p-4">
          <div class="grid grid-cols-2 gap-3">
            <div class="flex flex-col gap-1">
              <Label for="discovery-from">From</Label>
              <Input
                id="discovery-from"
                type="datetime-local"
                value={draft().from ?? ""}
                onInput={(e) => setField("from", e.currentTarget.value || null)}
              />
            </div>
            <div class="flex flex-col gap-1">
              <Label for="discovery-to">To</Label>
              <Input
                id="discovery-to"
                type="datetime-local"
                value={draft().to ?? ""}
                onInput={(e) => setField("to", e.currentTarget.value || null)}
              />
            </div>
          </div>

          <div class="flex flex-col gap-1">
            <Label for="discovery-radius">Within radius (km)</Label>
            <Input
              id="discovery-radius"
              type="number"
              min="1"
              max="500"
              step="1"
              placeholder="e.g. 25"
              value={draft().radiusKm ?? ""}
              onInput={(e) => setField("radiusKm", toNumberOrNull(e.currentTarget.value))}
            />
            <div class="flex items-center justify-between gap-2">
              <p class="text-muted-foreground text-xs">
                <Show
                  when={draft().coords}
                  fallback="Click 'Use my location' to enable. Max 500km."
                >
                  Using your location. Max 500km.
                </Show>
              </p>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={geoBusy()}
                onClick={async () => {
                  setGeoBusy(true);
                  setGeoError(null);
                  const pos = await getCurrentPosition();
                  setGeoBusy(false);
                  if (pos) setField("coords", pos);
                  else setGeoError("Couldn't resolve your location.");
                }}
              >
                {draft().coords ? "Update location" : "Use my location"}
              </Button>
            </div>
            <Show when={geoError()}>
              <p class="text-destructive text-xs">{geoError()}</p>
            </Show>
          </div>

          <div class="grid grid-cols-2 gap-3">
            <div class="flex flex-col gap-1">
              <Label for="discovery-price-min">Price min</Label>
              <Input
                id="discovery-price-min"
                type="number"
                min="0"
                step="1"
                placeholder="0"
                value={draft().priceMin ?? ""}
                onInput={(e) => setField("priceMin", toNumberOrNull(e.currentTarget.value))}
              />
            </div>
            <div class="flex flex-col gap-1">
              <Label for="discovery-price-max">Price max</Label>
              <Input
                id="discovery-price-max"
                type="number"
                min="0"
                step="1"
                placeholder="Any"
                value={draft().priceMax ?? ""}
                onInput={(e) => setField("priceMax", toNumberOrNull(e.currentTarget.value))}
              />
            </div>
          </div>

          <Show when={props.signedIn}>
            <label class="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={draft().friendsOnly}
                onChange={(e) => setField("friendsOnly", e.currentTarget.checked)}
              />
              Only events hosted by or RSVPed by friends
            </label>
          </Show>
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              setDraft(emptyFilters());
              props.onApply(emptyFilters());
              props.onOpenChange(false);
            }}
          >
            Clear
          </Button>
          <Button
            type="button"
            onClick={() => {
              props.onApply(draft());
              props.onOpenChange(false);
            }}
          >
            Apply
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
