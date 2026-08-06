import { useAuth } from "@shared/rp-auth/solid";
import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";

import { apiUrl, isAuthExpired, redirectToLogin } from "../lib/api";
import { haptic } from "../lib/haptics";
import { categoryLabel, SERVICE_CATEGORIES } from "../lib/service-categories";
import { invalidateVendors } from "../lib/vendors-store";
import EnquireDialog from "./EnquireDialog";
import Button from "./ui/Button";
import Field, { Input, Select } from "./ui/Field";
import Notice from "./ui/Notice";

interface BrowseListing {
  id: string;
  name: string;
  description: string | null;
  categories: string[];
  locationText: string | null;
  priceBand: string | null;
  priceMinMinor: number | null;
  priceMaxMinor: number | null;
  website: string | null;
  instagram: string | null;
  email: string | null;
  phone: string | null;
  inWedding: boolean;
}

interface DirectoryBrowseViewProps {
  weddingId: string;
  canEdit?: boolean;
}

const PAGE_SIZE = 24;

export default function DirectoryBrowseView(props: DirectoryBrowseViewProps) {
  const { authFetch } = useAuth();

  // Filter state
  const [category, setCategory] = createSignal("");
  const [q, setQ] = createSignal("");
  const [location, setLocation] = createSignal("");

  // Results state
  const [listings, setListings] = createSignal<BrowseListing[]>([]);
  const [total, setTotal] = createSignal(0);
  const [offset, setOffset] = createSignal(0);

  // UI state
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [addError, setAddError] = createSignal<string | null>(null);

  // Detail modal state
  const [modalListing, setModalListing] = createSignal<BrowseListing | null>(null);

  // Add flow state
  const [addingId, setAddingId] = createSignal<string | null>(null);
  // category picker for multi-category listings
  const [pickerListingId, setPickerListingId] = createSignal<string | null>(null);
  const [pickerCategory, setPickerCategory] = createSignal("");

  // Enquire flow state
  const [enquireListing, setEnquireListing] = createSignal<BrowseListing | null>(null);

  // Debounce timer
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;

  // Safe href: only allow http/https URLs (prevents javascript: XSS)
  const safeHref = (u: string | null | undefined): string | null => {
    if (!u) return null;
    try {
      const p = new URL(u);
      return p.protocol === "https:" || p.protocol === "http:" ? u : null;
    } catch {
      return null;
    }
  };

  // Safe Instagram handle: strip leading @/whitespace, accept only [A-Za-z0-9._]+
  const safeInstagramHref = (handle: string | null | undefined): string | null => {
    if (!handle) return null;
    const cleaned = handle.replace(/^[@\s]+/, "");
    return /^[A-Za-z0-9._]+$/.test(cleaned) ? `https://instagram.com/${cleaned}` : null;
  };

  // Focus-return: track the element that triggered the modal open
  let modalOpener: HTMLElement | null = null;

  const buildUrl = (currentOffset: number) => {
    const params = new URLSearchParams();
    if (category()) params.set("category", category());
    if (q()) params.set("q", q());
    if (location()) params.set("location", location());
    params.set("limit", String(PAGE_SIZE));
    params.set("offset", String(currentOffset));
    return apiUrl(`/api/organiser/weddings/${props.weddingId}/directory?${params.toString()}`);
  };

  const fetchPage = async (currentOffset: number, append: boolean) => {
    setLoading(true);
    setError(null);
    try {
      const res = await authFetch(buildUrl(currentOffset));
      if (res.status === 401) {
        redirectToLogin();
        return;
      }
      if (!res.ok) throw new Error(`browse ${res.status}`);
      const data = (await res.json()) as { listings: BrowseListing[]; total: number };
      if (append) {
        setListings((prev) => [...prev, ...data.listings]);
      } else {
        setListings(data.listings);
      }
      setTotal(data.total);
      setOffset(currentOffset);
    } catch (err) {
      if (isAuthExpired(err)) return redirectToLogin();
      setError("Couldn't load the vendor directory. Refresh to try again.");
    } finally {
      setLoading(false);
    }
  };

  const resetAndFetch = () => {
    setOffset(0);
    void fetchPage(0, false);
  };

  const scheduleSearch = () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(resetAndFetch, 300);
  };

  onMount(() => {
    void fetchPage(0, false);
  });

  onCleanup(() => clearTimeout(debounceTimer));

  const clearFilters = () => {
    setCategory("");
    setQ("");
    setLocation("");
    // will trigger via reactive signals — but we call resetAndFetch directly
    // since we're clearing all at once
    clearTimeout(debounceTimer);
    setOffset(0);
    void fetchPage(0, false);
  };

  // Patch a listing's inWedding flag locally
  const markInWedding = (id: string) => {
    setListings((prev) => prev.map((l) => (l.id === id ? { ...l, inWedding: true } : l)));
    // also update modal if open
    setModalListing((ml) => (ml?.id === id ? { ...ml, inWedding: true } : ml));
  };

  const doAdd = async (listingId: string, chosenCategory: string) => {
    setAddingId(listingId);
    setAddError(null);
    try {
      const res = await authFetch(
        apiUrl(`/api/organiser/weddings/${props.weddingId}/directory/${listingId}/add`),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ category: chosenCategory }),
        },
      );
      if (res.status === 201 || res.status === 409) {
        // 409 is "already on the list" — from where the host stands the vendor
        // is now in the wedding either way, so both confirm.
        markInWedding(listingId);
        invalidateVendors(props.weddingId);
        haptic("commit");
      } else if (!res.ok) {
        haptic("reject");
        setAddError("Couldn't add this vendor. Please try again.");
      }
    } catch (err) {
      if (isAuthExpired(err)) return redirectToLogin();
      haptic("reject");
      setAddError("Couldn't add this vendor. Please try again.");
    } finally {
      setAddingId(null);
      setPickerListingId(null);
      setPickerCategory("");
    }
  };

  const handleAddClick = (listing: BrowseListing) => {
    if (listing.categories.length === 1) {
      void doAdd(listing.id, listing.categories[0]!);
    } else {
      // multi-category: show picker
      setPickerListingId(listing.id);
      setPickerCategory(listing.categories[0] ?? "");
    }
  };

  const handlePickerConfirm = (listingId: string) => {
    if (!pickerCategory()) return;
    void doAdd(listingId, pickerCategory());
  };

  /** Escape, the scrim and the close button all land here, and nothing else
   *  does — `doAdd` deliberately leaves the modal open so the host can see the
   *  listing flip to "in your wedding" — so the dismiss buzz belongs here. */
  const closeModal = () => {
    haptic("dismiss");
    setModalListing(null);
    setPickerListingId(null);
    setPickerCategory("");
    // Return focus to the element that opened the modal
    modalOpener?.focus();
    modalOpener = null;
  };

  const handleModalKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") closeModal();
  };

  return (
    <div class="flex flex-col gap-6">
      {/* Filter bar */}
      <div class="border-border bg-surface/20 flex flex-wrap items-end gap-3 rounded-sm border p-4">
        <Field label="Category">
          {(field) => (
            <Select
              {...field}
              value={category()}
              onChange={(e) => {
                setCategory(e.currentTarget.value);
                resetAndFetch();
              }}
            >
              <option value="">All categories</option>
              <For each={SERVICE_CATEGORIES}>{(c) => <option value={c.key}>{c.label}</option>}</For>
            </Select>
          )}
        </Field>

        <Field label="Keyword" class="min-w-[10rem] flex-1">
          {(field) => (
            <Input
              {...field}
              value={q()}
              onInput={(e) => {
                setQ(e.currentTarget.value);
                scheduleSearch();
              }}
              placeholder="Search vendors…"
            />
          )}
        </Field>

        <Field label="Location">
          {(field) => (
            <Input
              {...field}
              value={location()}
              onInput={(e) => {
                setLocation(e.currentTarget.value);
                scheduleSearch();
              }}
              placeholder="City or region…"
            />
          )}
        </Field>

        <Button variant="quiet" onClick={clearFilters}>
          Clear filters
        </Button>
      </div>

      {/* Global error */}
      <Show when={error()}>
        <Notice tone="error" alert>
          {error()}
        </Notice>
      </Show>

      {/* Add error */}
      <Show when={addError()}>
        <Notice tone="error" alert>
          {addError()}
        </Notice>
      </Show>

      {/* Loading */}
      <Show when={loading() && listings().length === 0}>
        <p role="status" class="text-text-muted text-[0.85rem] italic">
          Loading vendors…
        </p>
      </Show>

      {/* Empty state */}
      <Show when={!loading() && listings().length === 0 && !error()}>
        <p role="status" class="text-text-muted text-[0.85rem] italic">
          No vendors match your filters.
        </p>
      </Show>

      {/* Results grid */}
      <Show when={listings().length > 0}>
        <ul class="auto-grid items-start [--auto-grid-min:19rem]">
          <For each={listings()}>
            {(item) => (
              <li class="border-border bg-surface/10 flex flex-col gap-3 rounded-sm border p-4">
                <div class="flex flex-col gap-1">
                  <span class="text-text text-[0.95rem] font-medium">{item.name}</span>

                  {/* Category chips */}
                  <div class="flex flex-wrap gap-1">
                    <For each={item.categories}>
                      {(cat) => (
                        <span class="bg-surface/60 text-text-muted rounded-full px-2 py-0.5 text-[0.72rem]">
                          {categoryLabel(cat)}
                        </span>
                      )}
                    </For>
                  </div>

                  <Show when={item.locationText}>
                    <span class="text-text-muted text-[0.82rem]">{item.locationText}</span>
                  </Show>

                  <Show when={item.priceBand}>
                    <span class="text-text-muted text-[0.82rem]">{item.priceBand}</span>
                  </Show>

                  <Show when={item.description}>
                    <p class="text-text-muted line-clamp-2 text-[0.82rem]">{item.description}</p>
                  </Show>
                </div>

                <div class="flex flex-wrap items-center gap-2 pt-1">
                  <button
                    type="button"
                    onClick={(e) => {
                      modalOpener = e.currentTarget;
                      setModalListing(item);
                    }}
                    class="text-gold-dim hover:text-gold text-[0.78rem] underline-offset-2 hover:underline"
                  >
                    View
                  </button>

                  <Show when={props.canEdit}>
                    <Show
                      when={!item.inWedding}
                      fallback={
                        <button
                          type="button"
                          disabled
                          aria-label="Already added to this wedding"
                          class="text-text-muted text-[0.78rem] opacity-60"
                        >
                          Added ✓
                        </button>
                      }
                    >
                      {/* Category picker (shown inline when multi-category) */}
                      <Show
                        when={pickerListingId() === item.id}
                        fallback={
                          <div class="flex items-center gap-2">
                            <Button
                              variant="primary"
                              size="sm"
                              disabled={addingId() === item.id}
                              onClick={() => handleAddClick(item)}
                            >
                              {addingId() === item.id ? "Adding…" : "Add to wedding"}
                            </Button>
                            <button
                              type="button"
                              aria-label={`Enquire with ${item.name}`}
                              onClick={() => setEnquireListing(item)}
                              class="text-gold-dim hover:text-gold text-[0.78rem] underline-offset-2 hover:underline"
                            >
                              Enquire
                            </button>
                          </div>
                        }
                      >
                        <div class="flex flex-col gap-2">
                          <fieldset class="flex flex-wrap gap-2">
                            <legend class="text-gold-dim font-body sr-only text-[0.68rem] uppercase">
                              Pick a category
                            </legend>
                            <For each={item.categories}>
                              {(cat) => (
                                <label class="flex items-center gap-1 text-[0.82rem]">
                                  <input
                                    type="radio"
                                    name={`add-cat-${item.id}`}
                                    value={cat}
                                    checked={pickerCategory() === cat}
                                    onChange={() => setPickerCategory(cat)}
                                  />
                                  {categoryLabel(cat)}
                                </label>
                              )}
                            </For>
                          </fieldset>
                          <div class="flex gap-2">
                            <Button
                              variant="primary"
                              size="sm"
                              aria-label="Confirm add"
                              onClick={() => handlePickerConfirm(item.id)}
                            >
                              Confirm
                            </Button>
                            <Button
                              variant="quiet"
                              size="sm"
                              aria-label="Cancel category selection"
                              onClick={() => {
                                setPickerListingId(null);
                                setPickerCategory("");
                              }}
                            >
                              Cancel
                            </Button>
                          </div>
                        </div>
                      </Show>
                    </Show>
                  </Show>
                </div>
              </li>
            )}
          </For>
        </ul>

        {/* Load more */}
        <Show when={listings().length < total()}>
          <div class="flex justify-center pt-2">
            <Button
              variant="quiet"
              aria-label={`Load more vendors, showing ${listings().length} of ${total()}`}
              onClick={() => void fetchPage(offset() + PAGE_SIZE, true)}
              disabled={loading()}
            >
              {loading() ? "Loading…" : "Load more"}
            </Button>
          </div>
        </Show>
      </Show>

      {/* Detail modal */}
      <Show when={modalListing()}>
        {(ml) => (
          /* Portalled to document.body: the dashboard shell sets `container-type`
             on its layout boxes, which brings `contain: layout` with it and makes
             them the containing block for `position: fixed` descendants. */
          <Portal>
            <div
              class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
              onClick={(e) => {
                if (e.target === e.currentTarget) closeModal();
              }}
            >
              <div
                role="dialog"
                aria-modal="true"
                aria-label={ml().name}
                tabIndex={-1}
                ref={(el) => el?.focus()}
                onKeyDown={handleModalKeyDown}
                class="border-border bg-bg flex max-h-[90vh] w-full max-w-lg flex-col gap-4 overflow-y-auto rounded-sm border p-6"
              >
                <div class="flex items-start justify-between gap-4">
                  <h2 class="text-text text-[1.1rem] font-medium">{ml().name}</h2>
                  <button
                    type="button"
                    aria-label="Close"
                    onClick={closeModal}
                    class="text-text-muted hover:text-text shrink-0"
                  >
                    ✕
                  </button>
                </div>

                {/* Category chips */}
                <div class="flex flex-wrap gap-1">
                  <For each={ml().categories}>
                    {(cat) => (
                      <span class="bg-surface/60 text-text-muted rounded-full px-2 py-0.5 text-[0.72rem]">
                        {categoryLabel(cat)}
                      </span>
                    )}
                  </For>
                </div>

                <Show when={ml().locationText}>
                  <p class="text-text-muted text-[0.85rem]">{ml().locationText}</p>
                </Show>

                <Show when={ml().priceBand}>
                  <p class="text-text-muted text-[0.85rem]">
                    {ml().priceBand}
                    <Show when={ml().priceMinMinor != null || ml().priceMaxMinor != null}>
                      {" "}
                      <span class="text-text-muted text-[0.82rem]">
                        {ml().priceMinMinor != null
                          ? `from $${(ml().priceMinMinor! / 100).toFixed(0)}`
                          : ""}
                        {ml().priceMinMinor != null && ml().priceMaxMinor != null ? " – " : ""}
                        {ml().priceMaxMinor != null
                          ? `to $${(ml().priceMaxMinor! / 100).toFixed(0)}`
                          : ""}
                      </span>
                    </Show>
                  </p>
                </Show>

                <Show when={ml().description}>
                  <p class="text-text text-[0.88rem]">{ml().description}</p>
                </Show>

                {/* Contact details */}
                <div class="flex flex-col gap-1">
                  <Show when={safeHref(ml().website)}>
                    {(href) => (
                      <a
                        href={href()}
                        target="_blank"
                        rel="noopener noreferrer"
                        class="text-gold-dim hover:text-gold text-[0.82rem] underline-offset-2 hover:underline"
                      >
                        Website
                      </a>
                    )}
                  </Show>
                  <Show when={safeInstagramHref(ml().instagram)}>
                    {(href) => (
                      <a
                        href={href()}
                        target="_blank"
                        rel="noopener noreferrer"
                        class="text-gold-dim hover:text-gold text-[0.82rem] underline-offset-2 hover:underline"
                      >
                        Instagram
                      </a>
                    )}
                  </Show>
                  <Show when={ml().email}>
                    <span class="text-text-muted text-[0.82rem]">{ml().email}</span>
                  </Show>
                  <Show when={ml().phone}>
                    <span class="text-text-muted text-[0.82rem]">{ml().phone}</span>
                  </Show>
                </div>

                {/* Add CTA in modal */}
                <Show when={props.canEdit}>
                  <Show
                    when={!ml().inWedding}
                    fallback={
                      <button
                        type="button"
                        disabled
                        aria-label="Already added to this wedding"
                        class="text-text-muted text-[0.82rem] opacity-60"
                      >
                        Added ✓
                      </button>
                    }
                  >
                    <Show
                      when={pickerListingId() === ml().id}
                      fallback={
                        <Button
                          variant="primary"
                          class="self-start"
                          disabled={addingId() === ml().id}
                          onClick={() => handleAddClick(ml())}
                        >
                          {addingId() === ml().id ? "Adding…" : "Add to wedding"}
                        </Button>
                      }
                    >
                      <div class="flex flex-col gap-2">
                        <fieldset class="flex flex-wrap gap-2">
                          <legend class="text-gold-dim font-body sr-only text-[0.68rem] uppercase">
                            Pick a category
                          </legend>
                          <For each={ml().categories}>
                            {(cat) => (
                              <label class="flex items-center gap-1 text-[0.82rem]">
                                <input
                                  type="radio"
                                  name={`modal-add-cat-${ml().id}`}
                                  value={cat}
                                  checked={pickerCategory() === cat}
                                  onChange={() => setPickerCategory(cat)}
                                />
                                {categoryLabel(cat)}
                              </label>
                            )}
                          </For>
                        </fieldset>
                        <div class="flex gap-2">
                          <Button
                            variant="primary"
                            size="sm"
                            aria-label="Confirm add"
                            onClick={() => handlePickerConfirm(ml().id)}
                          >
                            Confirm
                          </Button>
                          <Button
                            variant="quiet"
                            size="sm"
                            aria-label="Cancel category selection"
                            onClick={() => {
                              setPickerListingId(null);
                              setPickerCategory("");
                            }}
                          >
                            Cancel
                          </Button>
                        </div>
                      </div>
                    </Show>
                  </Show>
                </Show>
              </div>
            </div>
          </Portal>
        )}
      </Show>

      {/* Enquire dialog — one instance at root, keyed by the active listing */}
      <Show when={enquireListing()}>
        {(listing) => (
          <EnquireDialog
            open={true}
            weddingId={props.weddingId}
            directoryVendorId={listing().id}
            category={listing().categories[0] ?? "other"}
            vendorName={listing().name}
            onClose={() => setEnquireListing(null)}
          />
        )}
      </Show>
    </div>
  );
}
