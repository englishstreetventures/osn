import { useAuth } from "@osn/client/solid";
import { createEffect, createMemo, createResource, createSignal, For, Show } from "solid-js";
import { toast } from "solid-toast";

import { friendlyError } from "../lib/api";
import { categoryLabel, SERVICE_CATEGORIES } from "../lib/service-categories";
import { fetchListing, putListing } from "../lib/vendor-store";

// ── Tailwind class constants (mirrors organiser visual idiom) ──────────────
const labelClass = "font-body text-text-muted text-[0.72rem] tracking-[0.1em] uppercase";
const inputClass =
  "border-border bg-bg font-body text-text focus:border-gold rounded-sm border px-3 py-2 text-[0.95rem] transition-colors outline-none placeholder:opacity-40 disabled:opacity-40 w-full";

// ── Price-band options ─────────────────────────────────────────────────────
const PRICE_BANDS = [
  { value: "", label: "None" },
  { value: "$", label: "$" },
  { value: "$$", label: "$$" },
  { value: "$$$", label: "$$$" },
  { value: "$$$$", label: "$$$$" },
] as const;

interface ListingEditorProps {
  orgId: string;
  orgName: string;
}

export default function ListingEditor(props: ListingEditorProps) {
  const { authFetch } = useAuth();

  // Load the listing (may be null for a brand-new org).
  const [listing] = createResource(() => fetchListing(authFetch, props.orgId));

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
  // Per-key checked state: Record<categoryKey, boolean>.
  // Reading `checked()[key]` inside <For> is isolated to that row — toggling one key
  // only re-runs the expression for that checkbox (VP-P-W1).
  const [checked, setChecked] = createSignal<Record<string, boolean>>({});

  const [seeded, setSeeded] = createSignal(false);
  const [saving, setSaving] = createSignal(false);

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
    try {
      await putListing(authFetch, props.orgId, input);
      toast.success("Listing saved");
    } catch (err) {
      toast.error(friendlyError(err));
    } finally {
      setSaving(false);
    }
  };

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div class="border-border bg-surface/30 flex flex-col gap-6 rounded-sm border p-6">
      {/* Header row: title + listed badge */}
      <div class="flex items-start justify-between gap-4">
        <div>
          <p class="text-gold-dim font-body text-[0.68rem] tracking-[0.16em] uppercase">
            Directory listing
          </p>
          <h2 class="text-text font-body mt-0.5 text-[1.05rem] font-medium">{props.orgName}</h2>
        </div>
        <Show when={listing()}>
          {(l) => (
            <span
              class={`font-body rounded-full px-3 py-1 text-[0.72rem] tracking-[0.1em] uppercase ${
                l().listed === "live"
                  ? "bg-green-500/15 text-green-400"
                  : "bg-surface/40 text-text-muted"
              }`}
            >
              {l().listed}
            </span>
          )}
        </Show>
      </div>

      {/* Loading state */}
      <Show when={listing.loading}>
        <p
          role="status"
          class="font-body text-text-muted animate-pulse text-[0.88rem] tracking-[0.1em] uppercase"
        >
          Loading listing…
        </p>
      </Show>

      {/* Error state */}
      <Show when={listing.error}>
        <p
          role="alert"
          class="border-error/20 bg-error/5 text-error rounded-sm border p-4 text-[0.88rem]"
        >
          Could not load your listing. Please refresh.
        </p>
      </Show>

      {/* Form — rendered once seeded (includes empty-form case for new orgs) */}
      <Show when={!listing.loading && !listing.error && seeded()}>
        <form class="flex flex-col gap-5" noValidate onSubmit={handleSave}>
          {/* Name */}
          <label class="flex flex-col gap-1.5" for="listing-name">
            <span class={labelClass}>
              Name{" "}
              <span aria-hidden="true" class="text-gold">
                *
              </span>
            </span>
            <input
              id="listing-name"
              type="text"
              value={name()}
              onInput={(e) => setName(e.currentTarget.value)}
              required
              aria-required="true"
              maxLength={200}
              autocomplete="off"
              class={inputClass}
            />
          </label>

          {/* Categories */}
          <fieldset class="flex flex-col gap-2">
            <legend class={`${labelClass} mb-1`}>
              Categories{" "}
              <span aria-hidden="true" class="text-gold">
                *
              </span>
              <span class="sr-only">(select at least one)</span>
            </legend>
            <div class="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
              <For each={SERVICE_CATEGORIES}>
                {(cat) => {
                  const id = `cat-${cat.key}`;
                  return (
                    <label class="flex cursor-pointer items-center gap-2" for={id}>
                      <input
                        id={id}
                        type="checkbox"
                        checked={checked()[cat.key] ?? false}
                        onChange={(e) => toggleCategory(cat.key, e.currentTarget.checked)}
                        class="accent-gold h-4 w-4 cursor-pointer rounded"
                      />
                      <span class="font-body text-text text-[0.88rem]">
                        {categoryLabel(cat.key)}
                      </span>
                    </label>
                  );
                }}
              </For>
            </div>
          </fieldset>

          {/* Description */}
          <label class="flex flex-col gap-1.5" for="listing-description">
            <span class={labelClass}>Description</span>
            <textarea
              id="listing-description"
              value={description()}
              onInput={(e) => setDescription(e.currentTarget.value)}
              rows={3}
              maxLength={2000}
              class={`${inputClass} resize-y`}
            />
          </label>

          {/* Contact fields — 2-col grid */}
          <div class="grid gap-4 sm:grid-cols-2">
            <label class="flex flex-col gap-1.5" for="listing-email">
              <span class={labelClass}>Email</span>
              <input
                id="listing-email"
                type="email"
                value={email()}
                onInput={(e) => setEmail(e.currentTarget.value)}
                autocomplete="off"
                class={inputClass}
              />
            </label>

            <label class="flex flex-col gap-1.5" for="listing-phone">
              <span class={labelClass}>Phone</span>
              <input
                id="listing-phone"
                type="tel"
                value={phone()}
                onInput={(e) => setPhone(e.currentTarget.value)}
                autocomplete="off"
                class={inputClass}
              />
            </label>

            <label class="flex flex-col gap-1.5" for="listing-website">
              <span class={labelClass}>Website</span>
              <input
                id="listing-website"
                type="url"
                value={website()}
                onInput={(e) => setWebsite(e.currentTarget.value)}
                autocomplete="off"
                class={inputClass}
              />
            </label>

            <label class="flex flex-col gap-1.5" for="listing-instagram">
              <span class={labelClass}>Instagram</span>
              <input
                id="listing-instagram"
                type="text"
                value={instagram()}
                onInput={(e) => setInstagram(e.currentTarget.value)}
                placeholder="@handle"
                autocomplete="off"
                class={inputClass}
              />
            </label>
          </div>

          {/* Location */}
          <label class="flex flex-col gap-1.5" for="listing-location">
            <span class={labelClass}>Location</span>
            <input
              id="listing-location"
              type="text"
              value={locationText()}
              onInput={(e) => setLocationText(e.currentTarget.value)}
              placeholder="e.g. Sydney, NSW"
              autocomplete="off"
              class={inputClass}
            />
          </label>

          {/* Price band + min/max — 3-col grid */}
          <div class="grid gap-4 sm:grid-cols-3">
            <label class="flex flex-col gap-1.5" for="listing-price-band">
              <span class={labelClass}>Price band</span>
              <select
                id="listing-price-band"
                value={priceBand()}
                onChange={(e) => setPriceBand(e.currentTarget.value)}
                class={`${inputClass} cursor-pointer`}
              >
                <For each={PRICE_BANDS}>
                  {(band) => <option value={band.value}>{band.label}</option>}
                </For>
              </select>
            </label>

            <label class="flex flex-col gap-1.5" for="listing-price-min">
              <span class={labelClass}>Price min ($)</span>
              <input
                id="listing-price-min"
                type="number"
                min="0"
                step="0.01"
                value={priceMin()}
                onInput={(e) => setPriceMin(e.currentTarget.value)}
                placeholder="0.00"
                class={inputClass}
              />
            </label>

            <label class="flex flex-col gap-1.5" for="listing-price-max">
              <span class={labelClass}>Price max ($)</span>
              <input
                id="listing-price-max"
                type="number"
                min="0"
                step="0.01"
                value={priceMax()}
                onInput={(e) => setPriceMax(e.currentTarget.value)}
                placeholder="0.00"
                class={inputClass}
              />
            </label>
          </div>

          {/* Save button */}
          <button
            type="submit"
            disabled={saveDisabled()}
            class="border-gold bg-gold font-body text-bg hover:bg-gold-dim self-start rounded-sm border px-4 py-2 text-[0.82rem] tracking-[0.1em] uppercase transition disabled:opacity-40"
          >
            {saving() ? "Saving…" : "Save listing"}
          </button>
        </form>
      </Show>
    </div>
  );
}
