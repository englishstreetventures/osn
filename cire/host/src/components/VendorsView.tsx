import { useAuth } from "@shared/rp-auth/solid";
import { createMemo, createSignal, For, onMount, Show } from "solid-js";

import { apiUrl, isAuthExpired, redirectToLogin } from "../lib/api";
import { haptic } from "../lib/haptics";
// The portal's single clipboard choke point — it carries the fallback path for
// non-secure contexts and the copy haptic, neither of which a bare
// `navigator.clipboard.writeText` gets.
import { copyToClipboard } from "../lib/invite-message";
import { formatMinor } from "../lib/money";
import { categoryLabel, SERVICE_CATEGORIES, type ServiceCategory } from "../lib/service-categories";
import {
  ensureVendorsLoaded,
  invalidateVendors,
  peekCachedVendors,
  setCachedVendors,
  type VendorRow,
  vendorsAccessor,
} from "../lib/vendors-store";
import EnquireDialog from "./EnquireDialog";
import Button from "./ui/Button";
import Field, { Input, Select } from "./ui/Field";
import Notice from "./ui/Notice";

/** Vendor pipeline stages in workflow order. */
const VENDOR_STATUSES = [
  { key: "researching", label: "Researching" },
  { key: "contacted", label: "Contacted" },
  { key: "quoted", label: "Quoted" },
  { key: "booked", label: "Booked" },
  { key: "declined", label: "Declined" },
] as const;

type VendorStatus = (typeof VENDOR_STATUSES)[number]["key"];

interface VendorsViewProps {
  weddingId: string;
  /** Currency code from the budget cache (e.g. "AUD"). Defaults to "AUD" when absent. */
  currency?: string;
  /** Owner/editor may add/edit/delete vendors and list in directory. */
  canEdit?: boolean;
  /** Owner-only operations (reserved; pass through canManage for parity). */
  canManage?: boolean;
}

/** Compact quote line (no cents). Delegates to the shared `lib/money` formatter —
 *  memoised `Intl` instead of one per `<For>` row, and the currency's real
 *  minor-unit exponent rather than a fixed `/ 100`. */
const fmtMinor = (minor: number, currency: string): string =>
  formatMinor(minor, currency, { wholeUnits: true });

export default function VendorsView(props: VendorsViewProps) {
  const { authFetch } = useAuth();
  const vendors = vendorsAccessor(props.weddingId);
  const [error, setError] = createSignal<string | null>(null);

  // Add-vendor form state.
  const [newName, setNewName] = createSignal("");
  const [newCategory, setNewCategory] = createSignal<ServiceCategory>(SERVICE_CATEGORIES[0]!.key);
  const [newStatus, setNewStatus] = createSignal<VendorStatus>("researching");
  const [newContact, setNewContact] = createSignal("");
  const [newEmail, setNewEmail] = createSignal("");
  const [newPhone, setNewPhone] = createSignal("");
  const [newQuoted, setNewQuoted] = createSignal("");

  // Enquire flow state — holds the vendor being enquired.
  const [enquireVendor, setEnquireVendor] = createSignal<VendorRow | null>(null);

  // Listing-in-directory state — keyed by vendorId being listed.
  const [listingId, setListingId] = createSignal<string | null>(null);
  const [listEmail, setListEmail] = createSignal("");
  const [listCategories, setListCategories] = createSignal<string[]>([]);
  const [claimUrl, setClaimUrl] = createSignal<string | null>(null);
  const [listingLoading, setListingLoading] = createSignal(false);

  const vendorsUrl = () => apiUrl(`/api/organiser/weddings/${props.weddingId}/vendors`);

  const load = async (): Promise<VendorRow[]> => {
    const res = await authFetch(vendorsUrl());
    if (res.status === 401) {
      redirectToLogin();
      return [];
    }
    if (!res.ok) throw new Error(`Failed to load vendors (${res.status})`);
    return ((await res.json()) as { vendors: VendorRow[] }).vendors;
  };

  onMount(() => {
    ensureVendorsLoaded(props.weddingId, load).catch((err) => {
      if (isAuthExpired(err)) return redirectToLogin();
      setError("Couldn't load your vendors. Refresh to try again.");
    });
  });

  const reload = async () => {
    invalidateVendors(props.weddingId);
    try {
      setCachedVendors(props.weddingId, await load());
    } catch (err) {
      if (isAuthExpired(err)) return redirectToLogin();
      setError("Couldn't refresh your vendors.");
    }
  };

  const patchVendors = (fn: (vs: VendorRow[]) => VendorRow[]) => {
    const cur = peekCachedVendors(props.weddingId);
    if (cur) setCachedVendors(props.weddingId, fn(cur));
  };

  // Vendors grouped by status in pipeline order (memoised — O(n×statuses) work).
  const grouped = createMemo(() => {
    const rows = vendors() ?? [];
    return VENDOR_STATUSES.map((s) => ({
      status: s,
      vendors: rows.filter((v) => v.status === s.key).toSorted((a, b) => a.sortOrder - b.sortOrder),
    })).filter((g) => g.vendors.length > 0);
  });

  // ── Add vendor ────────────────────────────────────────────────────────────
  const addVendor = async (e: Event) => {
    e.preventDefault();
    const name = newName().trim();
    if (!name) return;
    setError(null);
    const quotedRaw = newQuoted().trim();
    const quotedMinor = quotedRaw === "" ? null : Math.round(Number(quotedRaw) * 100);
    if (quotedMinor !== null && (!Number.isFinite(quotedMinor) || quotedMinor < 0)) {
      haptic("reject");
      setError("Quote must be a positive amount.");
      return;
    }
    const body = {
      name,
      category: newCategory(),
      status: newStatus(),
      contactName: newContact().trim() || null,
      email: newEmail().trim() || null,
      phone: newPhone().trim() || null,
      notes: null,
      quotedMinor,
    };
    setNewName("");
    setNewContact("");
    setNewEmail("");
    setNewPhone("");
    setNewQuoted("");
    try {
      const res = await authFetch(vendorsUrl(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.status === 401) return redirectToLogin();
      if (!res.ok) throw new Error(`create ${res.status}`);
      const { vendor } = (await res.json()) as { vendor: VendorRow };
      patchVendors((vs) => [...vs, vendor]);
      haptic("commit");
    } catch {
      haptic("reject");
      setError("Couldn't add that vendor.");
      void reload();
    }
  };

  // ── Patch status ──────────────────────────────────────────────────────────
  const patchStatus = async (v: VendorRow, status: VendorStatus) => {
    patchVendors((vs) => vs.map((x) => (x.id === v.id ? { ...x, status } : x)));
    haptic("commit");
    try {
      const res = await authFetch(
        apiUrl(`/api/organiser/weddings/${props.weddingId}/vendors/${v.id}`),
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status }),
        },
      );
      if (res.status === 401) return redirectToLogin();
      if (!res.ok) throw new Error(`patch ${res.status}`);
      const { vendor: updated } = (await res.json()) as { vendor: VendorRow };
      patchVendors((vs) => vs.map((x) => (x.id === updated.id ? updated : x)));
    } catch {
      haptic("reject");
      setError("Couldn't update that vendor.");
      void reload();
    }
  };

  // ── Delete vendor ─────────────────────────────────────────────────────────
  const deleteVendor = async (v: VendorRow) => {
    patchVendors((vs) => vs.filter((x) => x.id !== v.id));
    haptic("commit");
    try {
      const res = await authFetch(
        apiUrl(`/api/organiser/weddings/${props.weddingId}/vendors/${v.id}`),
        { method: "DELETE" },
      );
      if (res.status === 401) return redirectToLogin();
      if (!res.ok) throw new Error(`delete ${res.status}`);
    } catch {
      haptic("reject");
      setError("Couldn't delete that vendor.");
      void reload();
    }
  };

  // ── List in directory + invite to claim ──────────────────────────────────
  const openListing = (v: VendorRow) => {
    setListingId(v.id);
    setListEmail(v.email ?? "");
    setListCategories([v.category]);
    setClaimUrl(null);
  };

  const closeListing = () => {
    setListingId(null);
    setListEmail("");
    setListCategories([]);
    setClaimUrl(null);
    setListingLoading(false);
  };

  const submitListing = async (e: Event, v: VendorRow) => {
    e.preventDefault();
    setListingLoading(true);
    setError(null);
    try {
      const res = await authFetch(
        apiUrl(`/api/organiser/weddings/${props.weddingId}/vendors/${v.id}/list-in-directory`),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: v.name,
            email: listEmail().trim() || null,
            categories: listCategories(),
          }),
        },
      );
      if (res.status === 401) return redirectToLogin();
      if (!res.ok) throw new Error(`list ${res.status}`);
      const data = (await res.json()) as { claimUrl: string };
      setClaimUrl(data.claimUrl);
      haptic("commit");
    } catch {
      haptic("reject");
      setError("Couldn't list that vendor in the directory.");
    } finally {
      setListingLoading(false);
    }
  };

  return (
    <div class="flex flex-col gap-6">
      <Show when={error()}>
        <Notice tone="error" alert>
          {error()}
        </Notice>
      </Show>

      {/* Add vendor (editor). */}
      <Show when={props.canEdit}>
        <form
          onSubmit={addVendor}
          class="border-border bg-surface/20 flex flex-wrap items-end gap-3 rounded-sm border p-4"
        >
          <Field label="Vendor name" class="min-w-[12rem] flex-1">
            {(field) => (
              <Input
                {...field}
                value={newName()}
                onInput={(e) => setNewName(e.currentTarget.value)}
                placeholder="Florist, photographer…"
              />
            )}
          </Field>
          <Field label="Category">
            {(field) => (
              <Select
                {...field}
                value={newCategory()}
                onChange={(e) => setNewCategory(e.currentTarget.value as ServiceCategory)}
              >
                <For each={SERVICE_CATEGORIES}>
                  {(c) => <option value={c.key}>{c.label}</option>}
                </For>
              </Select>
            )}
          </Field>
          <Field label="Status">
            {(field) => (
              <Select
                {...field}
                value={newStatus()}
                onChange={(e) => setNewStatus(e.currentTarget.value as VendorStatus)}
              >
                <For each={VENDOR_STATUSES}>{(s) => <option value={s.key}>{s.label}</option>}</For>
              </Select>
            )}
          </Field>
          <Field label="Contact" class="w-36">
            {(field) => (
              <Input
                {...field}
                value={newContact()}
                onInput={(e) => setNewContact(e.currentTarget.value)}
                placeholder="Jane Smith"
              />
            )}
          </Field>
          <Field label="Email" class="w-44">
            {(field) => (
              <Input
                {...field}
                type="email"
                value={newEmail()}
                onInput={(e) => setNewEmail(e.currentTarget.value)}
                placeholder="vendor@example.com"
              />
            )}
          </Field>
          <Field label="Quote (optional)" class="w-28">
            {(field) => (
              <Input
                {...field}
                type="number"
                min="0"
                step="0.01"
                value={newQuoted()}
                onInput={(e) => setNewQuoted(e.currentTarget.value)}
                placeholder="0.00"
              />
            )}
          </Field>
          <Button type="submit" variant="primary">
            Add vendor
          </Button>
        </form>
      </Show>

      <Show
        when={(vendors() ?? []).length > 0}
        fallback={<p class="text-text-muted text-[0.85rem] italic">No vendors yet.</p>}
      >
        <For each={grouped()}>
          {(group) => (
            <section class="flex flex-col gap-2">
              <h3 class="text-gold-dim font-body text-[0.7rem] tracking-[0.18em] uppercase">
                {group.status.label}
              </h3>
              <ul class="flex flex-col gap-1">
                <For each={group.vendors}>
                  {(v) => (
                    <li class="border-border bg-surface/10 flex flex-col gap-2 rounded-sm border px-3 py-2">
                      <div class="flex flex-wrap items-center gap-3">
                        <span class="text-text min-w-[10rem] flex-1 text-[0.9rem] font-medium">
                          {v.name}
                        </span>
                        {/* Category chip */}
                        <span class="bg-surface/60 text-text-muted rounded-full px-2 py-0.5 text-[0.72rem]">
                          {categoryLabel(v.category)}
                        </span>
                        <Show when={v.contactName ?? v.email ?? v.phone}>
                          <span class="text-text-muted text-[0.82rem]">
                            {v.contactName}
                            {v.contactName && (v.email || v.phone) ? " · " : ""}
                            {v.email}
                            {v.email && v.phone ? " · " : ""}
                            {v.phone}
                          </span>
                        </Show>
                        <Show when={v.quotedMinor != null}>
                          <span class="text-text text-[0.82rem]">
                            {fmtMinor(v.quotedMinor!, props.currency ?? "AUD")}
                          </span>
                        </Show>

                        <Show when={props.canEdit}>
                          <div class="flex items-center gap-2">
                            {/* Status picker */}
                            <Select
                              size="sm"
                              aria-label={`Status for ${v.name}`}
                              value={v.status}
                              onChange={(e) =>
                                patchStatus(v, e.currentTarget.value as VendorStatus)
                              }
                            >
                              <For each={VENDOR_STATUSES}>
                                {(s) => <option value={s.key}>{s.label}</option>}
                              </For>
                            </Select>
                            {/* List in directory */}
                            <button
                              type="button"
                              aria-label={`List ${v.name} in directory`}
                              onClick={() => openListing(v)}
                              class="text-gold-dim hover:text-gold text-[0.78rem] underline-offset-2 hover:underline"
                            >
                              List in directory
                            </button>
                            {/* Enquire — only available when linked to a directory vendor */}
                            <Show when={v.directoryVendorId}>
                              <button
                                type="button"
                                aria-label={`Enquire with ${v.name}`}
                                onClick={() => setEnquireVendor(v)}
                                class="text-gold-dim hover:text-gold text-[0.78rem] underline-offset-2 hover:underline"
                              >
                                Enquire
                              </button>
                            </Show>
                            {/* Delete */}
                            <button
                              type="button"
                              aria-label={`Delete ${v.name}`}
                              onClick={() => deleteVendor(v)}
                              class="text-text-muted hover:text-error px-1"
                            >
                              ✕
                            </button>
                          </div>
                        </Show>
                      </div>

                      {/* Directory listing form */}
                      <Show when={listingId() === v.id}>
                        <div class="border-border/60 ml-2 flex flex-col gap-3 border-l pl-3">
                          <Show
                            when={claimUrl()}
                            fallback={
                              <form
                                onSubmit={(e) => submitListing(e, v)}
                                class="flex flex-wrap items-end gap-3"
                              >
                                <Field label="Vendor email (for claim invite)" class="w-56">
                                  {(field) => (
                                    <Input
                                      {...field}
                                      size="sm"
                                      type="email"
                                      value={listEmail()}
                                      onInput={(e) => setListEmail(e.currentTarget.value)}
                                      placeholder="vendor@example.com"
                                    />
                                  )}
                                </Field>
                                <div class="flex items-end gap-2">
                                  <Button
                                    type="submit"
                                    variant="primary"
                                    size="sm"
                                    disabled={listingLoading()}
                                  >
                                    {listingLoading() ? "Listing…" : "List + invite"}
                                  </Button>
                                  <Button variant="quiet" size="sm" onClick={closeListing}>
                                    Cancel
                                  </Button>
                                </div>
                              </form>
                            }
                          >
                            <div class="flex flex-col gap-2">
                              <p class="text-text text-[0.85rem]">
                                Listed! Share this claim link with {v.name}:
                              </p>
                              <div class="border-border bg-bg flex items-center gap-2 rounded-sm border px-3 py-2">
                                <span class="text-text-muted grow truncate font-mono text-[0.78rem]">
                                  {claimUrl()}
                                </span>
                                <button
                                  type="button"
                                  onClick={() => void copyToClipboard(claimUrl()!)}
                                  class="text-gold-dim hover:text-gold shrink-0 text-[0.76rem] underline-offset-2 hover:underline"
                                >
                                  Copy
                                </button>
                              </div>
                              <Button
                                variant="quiet"
                                size="sm"
                                class="self-start"
                                onClick={closeListing}
                              >
                                Done
                              </Button>
                            </div>
                          </Show>
                        </div>
                      </Show>
                    </li>
                  )}
                </For>
              </ul>
            </section>
          )}
        </For>
      </Show>

      {/* Enquire dialog — one instance at root */}
      <Show when={enquireVendor()}>
        {(v) => (
          <EnquireDialog
            open={true}
            weddingId={props.weddingId}
            directoryVendorId={v().directoryVendorId!}
            category={v().category}
            vendorName={v().name}
            onClose={() => setEnquireVendor(null)}
          />
        )}
      </Show>
    </div>
  );
}
