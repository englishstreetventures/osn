import { useAuth } from "@shared/rp-auth/solid";
import { toast } from "@shared/toast";
import { createEffect, createMemo, createResource, createSignal, For, Show } from "solid-js";

import { friendlyError } from "../lib/api";
import { haptic } from "../lib/haptics";
import { categoryLabel, SERVICE_CATEGORIES } from "../lib/service-categories";
import { fetchListing, putListing, takeSeededListing } from "../lib/vendor-store";
import Button from "./ui/Button";
import Card, { CardEyebrow } from "./ui/Card";
import Chip from "./ui/Chip";
import Field, { Checkbox, Fieldset, Input, Select, Textarea } from "./ui/Field";
import Loading from "./ui/Loading";
import Notice from "./ui/Notice";

// ── Price-band options ─────────────────────────────────────────────────────
const PRICE_BANDS = [
  { value: "", label: "None" },
  { value: "$", label: "$" },
  { value: "$$", label: "$$" },
  { value: "$$$", label: "$$$" },
  { value: "$$$$", label: "$$$$" },
] as const;

/** The required-field mark: seen as a glyph, read as a word. */
function Required() {
  return (
    <>
      <span aria-hidden="true" class="text-gold">
        {" *"}
      </span>
      <span class="sr-only"> (required)</span>
    </>
  );
}

interface ListingEditorProps {
  orgId: string;
  orgName: string;
}

export default function ListingEditor(props: ListingEditorProps) {
  const { authFetch } = useAuth();

  // Load the listing (may be null for a brand-new org). A claim that just
  // redirected here may have left the listing seeded in sessionStorage
  // (VP-P-W2) — use it once instead of re-fetching what consumeClaim already
  // returned.
  const [listing] = createResource(async () => {
    const seeded = takeSeededListing(props.orgId);
    if (seeded !== undefined) return seeded;
    return fetchListing(authFetch, props.orgId);
  });

  // ── Form signals ─────────────────────────────────────────────────────────
  const [name, setName] = createSignal("");
  const [description, setDescription] = createSignal("");
  const [email, setEmail] = createSignal("");
  const [phone, setPhone] = createSignal("");
  const [website, setWebsite] = createSignal("");
  const [instagram, setInstagram] = createSignal("");
  const [locationText, setLocationText] = createSignal("");
  const [priceBand, setPriceBand] = createSignal("");
  // Money: displayed in major units (dollars); "" means null (no value set).
  const [priceMin, setPriceMin] = createSignal("");
  const [priceMax, setPriceMax] = createSignal("");
  // Per-key checked state: Record<categoryKey, boolean>, held as one signal.
  // `toggleCategory` below spreads a fresh object on every toggle, so every
  // row's `checked()[key]` read re-runs on every toggle, not just the one
  // that changed — this is a single signal, not one per key, and SolidJS has
  // no way to see that only one property moved. That recomputes 14 boolean
  // lookups per toggle (`SERVICE_CATEGORIES` has 14 entries), which costs
  // nothing worth a per-key signal split (xchromo/osn-tracker#132).
  const [checked, setChecked] = createSignal<Record<string, boolean>>({});

  const [seeded, setSeeded] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  // Set when a save comes back rejected, so the message lands on the field
  // rather than only in a toast that has since faded.
  const [saveError, setSaveError] = createSignal<string | null>(null);

  // Seed form once when the resource settles (idiomatic SolidJS — no reactive side-effects).
  createEffect(() => {
    if (!listing.loading && !seeded()) {
      const data = listing();
      if (data) {
        setName(data.name ?? "");
        setDescription(data.description ?? "");
        setEmail(data.email ?? "");
        setPhone(data.phone ?? "");
        setWebsite(data.website ?? "");
        setInstagram(data.instagram ?? "");
        setLocationText(data.locationText ?? "");
        setPriceBand(data.priceBand ?? "");
        setPriceMin(data.priceMinMinor != null ? String(data.priceMinMinor / 100) : "");
        setPriceMax(data.priceMaxMinor != null ? String(data.priceMaxMinor / 100) : "");
        const rec: Record<string, boolean> = {};
        for (const key of data.categories ?? []) rec[key] = true;
        setChecked(rec);
      }
      // data === null means no listing yet → form stays empty; mark seeded either way.
      setSeeded(true);
    }
  });

  // ── Category toggle ───────────────────────────────────────────────────────
  const toggleCategory = (key: string, isChecked: boolean) => {
    setChecked((prev) => ({ ...prev, [key]: isChecked }));
  };

  // Derive the categories array for the save payload (keys where checked[key] === true).
  const checkedCategories = createMemo(() =>
    Object.entries(checked())
      .filter(([, v]) => v)
      .map(([k]) => k),
  );

  // ── Save-button disable condition (VP-P-I3) ──────────────────────────────
  // createMemo dedupes to signal-change boundaries rather than re-running on every
  // render pass of the button effect.
  const saveDisabled = createMemo(
    () => saving() || name().trim() === "" || checkedCategories().length === 0,
  );

  // ── Save handler ─────────────────────────────────────────────────────────
  const handleSave = async (e: Event) => {
    e.preventDefault();
    if (saveDisabled()) return;

    const minStr = priceMin().trim();
    const maxStr = priceMax().trim();

    const input = {
      name: name().trim(),
      categories: checkedCategories(),
      description: description().trim() || null,
      email: email().trim() || null,
      phone: phone().trim() || null,
      website: website().trim() || null,
      instagram: instagram().trim() || null,
      locationText: locationText().trim() || null,
      priceBand: priceBand() || null,
      priceMinMinor: minStr !== "" ? Math.round(Number(minStr) * 100) : null,
      priceMaxMinor: maxStr !== "" ? Math.round(Number(maxStr) * 100) : null,
    };

    setSaving(true);
    setSaveError(null);
    try {
      await putListing(authFetch, props.orgId, input);
      // The change took. Fired here rather than in `Button`, which cannot know
      // whether a press turned into anything.
      haptic("commit");
      toast.success("Listing saved");
    } catch (err) {
      haptic("reject");
      const message = friendlyError(err);
      setSaveError(message);
      toast.error(message);
    } finally {
      setSaving(false);
    }
  };

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <Card>
      {/* Header row: title + listed badge */}
      <div class="flex items-start justify-between gap-4">
        <div class="flex min-w-0 flex-col gap-0.5">
          <CardEyebrow>Directory listing</CardEyebrow>
          <h2 class="font-display text-text text-[1.4rem] leading-tight font-light">
            {props.orgName}
          </h2>
        </div>
        <Show when={listing()}>
          {(l) => <Chip tone={l().listed === "live" ? "live" : "neutral"}>{l().listed}</Chip>}
        </Show>
      </div>

      <Show when={listing.loading}>
        <Loading label="Loading listing…" />
      </Show>

      <Show when={listing.error}>
        <Notice tone="error" alert>
          Could not load your listing. Please refresh.
        </Notice>
      </Show>

      {/* Form — rendered once seeded (includes empty-form case for new orgs) */}
      <Show when={!listing.loading && !listing.error && seeded()}>
        <form class="flex flex-col gap-5" noValidate onSubmit={handleSave}>
          <Field
            label={
              <>
                Name
                <Required />
              </>
            }
          >
            {(field) => (
              <Input
                {...field}
                value={name()}
                onInput={(e) => setName(e.currentTarget.value)}
                required
                aria-required="true"
                maxLength={200}
                autocomplete="off"
              />
            )}
          </Field>

          <Fieldset
            legend={
              <>
                Categories
                <Required />
                <span class="sr-only"> — select at least one</span>
              </>
            }
          >
            {/* Intrinsic rather than `grid-cols-2 sm:grid-cols-3`: the label
                lengths are what decide how many fit, not the viewport, and this
                panel is narrower than the window on every screen. */}
            <div class="auto-grid [--auto-grid-gap:0.5rem] [--auto-grid-min:11rem]">
              <For each={SERVICE_CATEGORIES}>
                {(cat) => (
                  <Checkbox
                    checked={checked()[cat.key] ?? false}
                    onChange={(next) => toggleCategory(cat.key, next)}
                    label={categoryLabel(cat.key)}
                  />
                )}
              </For>
            </div>
          </Fieldset>

          <Field label="Description" hint="Shown to couples browsing the directory.">
            {(field) => (
              <Textarea
                {...field}
                value={description()}
                onInput={(e) => setDescription(e.currentTarget.value)}
                rows={3}
                maxLength={2000}
                // This form sits inside `createAutoSize()`'s frame, whose
                // reflow guard watches width only — dragging this box's own
                // resize grip at a fixed width reads as a content change on
                // every delivery (xchromo/osn-tracker#130).
                resize="none"
              />
            )}
          </Field>

          <div class="auto-grid [--auto-grid-min:16rem]">
            <Field label="Email">
              {(field) => (
                <Input
                  {...field}
                  type="email"
                  value={email()}
                  onInput={(e) => setEmail(e.currentTarget.value)}
                  autocomplete="off"
                />
              )}
            </Field>

            <Field label="Phone">
              {(field) => (
                <Input
                  {...field}
                  type="tel"
                  value={phone()}
                  onInput={(e) => setPhone(e.currentTarget.value)}
                  autocomplete="off"
                />
              )}
            </Field>

            <Field label="Website">
              {(field) => (
                <Input
                  {...field}
                  type="url"
                  value={website()}
                  onInput={(e) => setWebsite(e.currentTarget.value)}
                  autocomplete="off"
                />
              )}
            </Field>

            <Field label="Instagram">
              {(field) => (
                <Input
                  {...field}
                  value={instagram()}
                  onInput={(e) => setInstagram(e.currentTarget.value)}
                  placeholder="@handle"
                  autocomplete="off"
                />
              )}
            </Field>
          </div>

          <Field label="Location">
            {(field) => (
              <Input
                {...field}
                value={locationText()}
                onInput={(e) => setLocationText(e.currentTarget.value)}
                placeholder="e.g. Sydney, NSW"
                autocomplete="off"
              />
            )}
          </Field>

          <div class="auto-grid [--auto-grid-min:11rem]">
            <Field label="Price band">
              {(field) => (
                <Select
                  {...field}
                  value={priceBand()}
                  onChange={(e) => setPriceBand(e.currentTarget.value)}
                >
                  <For each={PRICE_BANDS}>
                    {(band) => <option value={band.value}>{band.label}</option>}
                  </For>
                </Select>
              )}
            </Field>

            <Field label="Price min ($)">
              {(field) => (
                <Input
                  {...field}
                  type="number"
                  min="0"
                  step="0.01"
                  value={priceMin()}
                  onInput={(e) => setPriceMin(e.currentTarget.value)}
                  placeholder="0.00"
                />
              )}
            </Field>

            <Field label="Price max ($)">
              {(field) => (
                <Input
                  {...field}
                  type="number"
                  min="0"
                  step="0.01"
                  value={priceMax()}
                  onInput={(e) => setPriceMax(e.currentTarget.value)}
                  placeholder="0.00"
                />
              )}
            </Field>
          </div>

          {/* The rejection, kept on screen. A toast is the notification; this is
              the record of it, and it is what is still there when the vendor
              looks back up from the field they were fixing. */}
          <Show when={saveError()}>
            {(message) => (
              <Notice tone="error" alert>
                {message()}
              </Notice>
            )}
          </Show>

          <Button type="submit" variant="primary" disabled={saveDisabled()} class="self-start">
            {saving() ? "Saving…" : "Save listing"}
          </Button>
        </form>
      </Show>
    </Card>
  );
}
