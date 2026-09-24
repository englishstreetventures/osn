import Button from "@cire/ui/button";
import { useAuth } from "@shared/rp-auth/solid";
import { toast } from "@shared/toast";
import { Field } from "@shared/ui/ui/field";
import { Input } from "@shared/ui/ui/input";
import { Notice } from "@shared/ui/ui/notice";
import { Textarea } from "@shared/ui/ui/textarea";
import { createMemo, createSignal, For, onMount, Show } from "solid-js";

import { apiUrl, isAuthExpired, redirectToLogin } from "../lib/api";
import { downloadBlob } from "../lib/download";
import { haptic } from "../lib/haptics";
import { formatMinor, formatMinorPair, minorToInput, parseMinor } from "../lib/money";
import {
  ensureRegistryLoaded,
  type GiftLogEntry,
  invalidateRegistry,
  peekCachedRegistry,
  registryAccessor,
  type RegistryItem,
  type RegistrySnapshot,
  setCachedRegistry,
  stillWanted,
} from "../lib/registry-store";
import RegistryImageField from "./RegistryImageField";
interface RegistryViewProps {
  weddingId: string;
  /** Which sub-view this instance is: the gift list the couple authors, or the
   *  log of what guests have actually claimed and sent. Both read ONE snapshot,
   *  so switching between them costs no fetch. */
  view: "list" | "gifts";
  /** Owner/editor may add, edit, reorder and delete items, and mark a gift
   *  thanked. A viewer reads both sub-views and writes nothing. */
  canEdit?: boolean;
  /** The wedding's slug, used to name the downloaded gift-log CSV. Passed in
   *  rather than read from the snapshot so the filename is right on the first
   *  click, before the registry has loaded. */
  weddingSlug: string;
}

/** Quantity range the API's schema allows (`Quantity` in `schemas/registry.ts`). */
const MIN_QUANTITY = 1;
const MAX_QUANTITY = 99;

/**
 * Is this a link this view will put in an `href`?
 *
 * `https:` only, matching the API schema that accepts the field and the message
 * the form shows on a 400 — the shared `isHttpUrl` also passes `http:` and
 * treats blank as valid, which is right for the guest-detail forms it was
 * written for and wrong at a render site (S-L2). A stored row can predate the
 * schema or come from a fixture, so the check belongs here as well as at write
 * time (precedent CON-S-L2).
 */
function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * What a gift's status means, in the words the couple would use for it.
 *
 * The two tables behind the log share this column and do not share its values: a
 * CLAIM is `reserved` / `purchased` / `released`, a CONTRIBUTION is `pending` /
 * `succeeded` / `refunded`. Rendering the raw column made the couple read
 * "succeeded" about a wedding present.
 *
 * `failed` is handled for completeness only — the API's gift log leaves those
 * rows out, because money that never moved is not a gift.
 *
 * Module scope, not the component: it reads nothing but its argument, so keeping
 * it inside meant rebuilding the closure on every render of a view that renders
 * on every keystroke in the list's forms.
 */
function giftStatus(gift: GiftLogEntry) {
  if (gift.kind === "claim") {
    switch (gift.status) {
      case "reserved":
        return { label: "Promised", gone: false };
      case "purchased":
        return { label: "Bought", gone: false };
      case "released":
        return { label: "No longer coming", gone: true };
    }
  } else {
    switch (gift.status) {
      case "pending":
        return { label: "Not cleared yet", gone: false };
      case "succeeded":
        return { label: "Received", gone: false };
      case "refunded":
        return { label: "Refunded", gone: true };
      // Held, not ended: the guest's bank has the money while it decides. `gone`
      // keeps it out of the received total, which is the honest side to be on —
      // the couple does not have this money today.
      case "disputed":
        return { label: "Payment disputed", gone: true };
      case "failed":
        return { label: "Didn't go through", gone: true };
    }
  }
  // A value this build has no word for is a newer API than this build. Show it
  // as it came rather than swallowing the row's only state.
  return { label: gift.status, gone: false };
}

/**
 * The gift registry — the couple's list, and the log of gifts against it.
 *
 * Guest-authored text (`note`, `displayName`, and the household's `familyName`)
 * is rendered through Solid's `{expr}` interpolation ONLY, which builds a text
 * node (S-L3). No `innerHTML`, no markdown pass: a guest writes the note and the
 * couple reads it in an authenticated portal, so any HTML path here is stored
 * XSS against the account that owns the wedding.
 */
export default function RegistryView(props: RegistryViewProps) {
  const { authFetch } = useAuth();
  const snapshot = registryAccessor(props.weddingId);
  const [error, setError] = createSignal<string | null>(null);
  const [loadingMore, setLoadingMore] = createSignal(false);
  const [exporting, setExporting] = createSignal(false);

  // Add-item form state.
  const [newTitle, setNewTitle] = createSignal("");
  const [newPrice, setNewPrice] = createSignal("");
  const [newQuantity, setNewQuantity] = createSignal("1");
  const [newUrl, setNewUrl] = createSignal("");
  // The picture, if the organiser gave one. Bytes are already in R2 by the time
  // this holds a key — `RegistryImageField` saves them the moment one is picked,
  // because the add form has no item id to hang an upload off. An abandoned form
  // therefore leaves an unreferenced object, which the R2 reconciler sweeps once
  // it is past the grace window (`services/asset-reconcile.ts`).
  const [newImageKey, setNewImageKey] = createSignal<string | null>(null);

  // Inline edit state — the item being edited, plus its draft fields.
  const [editingId, setEditingId] = createSignal<string | null>(null);
  const [editTitle, setEditTitle] = createSignal("");
  const [editDescription, setEditDescription] = createSignal("");
  const [editPrice, setEditPrice] = createSignal("");
  const [editQuantity, setEditQuantity] = createSignal("1");
  const [editCategory, setEditCategory] = createSignal("");
  const [editUrl, setEditUrl] = createSignal("");
  const [editImageKey, setEditImageKey] = createSignal<string | null>(null);

  // Ids are percent-encoded at every interpolation, the way `enquiries-api.ts`
  // does it. Today's ids are nanoid-shaped and can't carry a `/` or `?`, so this
  // changes no request that is actually made — it stops the day an id format
  // changes from turning a path segment into a new path or a query string
  // (S-L1).
  const wedding = () => encodeURIComponent(props.weddingId);
  const registryUrl = (giftsOffset?: number) =>
    apiUrl(
      `/api/organiser/weddings/${wedding()}/registry${
        giftsOffset ? `?giftsOffset=${giftsOffset}` : ""
      }`,
    );
  const itemsUrl = () => apiUrl(`/api/organiser/weddings/${wedding()}/registry/items`);
  const itemUrl = (itemId: string) => `${itemsUrl()}/${encodeURIComponent(itemId)}`;

  const load = async (): Promise<RegistrySnapshot> => {
    const res = await authFetch(registryUrl());
    if (res.status === 401) {
      redirectToLogin();
      throw new Error("unauthorised");
    }
    if (!res.ok) throw new Error(`Failed to load registry (${res.status})`);
    return (await res.json()) as RegistrySnapshot;
  };

  onMount(() => {
    ensureRegistryLoaded(props.weddingId, load).catch((err) => {
      if (isAuthExpired(err)) return redirectToLogin();
      setError("Couldn't load your registry. Refresh to try again.");
    });
  });

  const reload = async () => {
    invalidateRegistry(props.weddingId);
    try {
      await ensureRegistryLoaded(props.weddingId, load);
    } catch (err) {
      if (isAuthExpired(err)) return redirectToLogin();
      setError("Couldn't refresh your registry.");
    }
  };

  const patchSnap = (fn: (s: RegistrySnapshot) => RegistrySnapshot) => {
    const cur = peekCachedRegistry(props.weddingId);
    if (cur) setCachedRegistry(props.weddingId, fn(cur));
  };

  // The wedding's primary currency — what every AUTHORED figure is in. A gift
  // may have arrived in something else; those rows carry their own code.
  const currency = () => snapshot()?.currency ?? "AUD";

  // Declared below the accessors it reads: `createMemo` computes eagerly, so a
  // memo above its dependencies throws at component-init rather than on read.
  const items = createMemo(() =>
    (snapshot()?.items ?? []).toSorted((a, b) => a.sortOrder - b.sortOrder),
  );

  // The gift log, already ordered by the server. A memo rather than two
  // `snapshot()?.gifts ?? []` reads, so the empty-state `<Show>` and the `<For>`
  // resolve one array and `<For>` keeps its identity when the snapshot object is
  // replaced by an unrelated write (REG-P-I2).
  const gifts = createMemo(() => snapshot()?.gifts ?? []);

  // ── Add item ──────────────────────────────────────────────────────────────
  const addItem = async (e: Event) => {
    e.preventDefault();
    const title = newTitle().trim();
    if (!title) return;
    setError(null);

    const priceRaw = newPrice().trim();
    const priceMinor = priceRaw === "" ? null : parseMinor(priceRaw, currency());
    if (priceRaw !== "" && priceMinor === null) {
      haptic("reject");
      setError("Price must be a positive amount.");
      return;
    }
    const quantityWanted = Number(newQuantity());
    if (
      !Number.isInteger(quantityWanted) ||
      quantityWanted < MIN_QUANTITY ||
      quantityWanted > MAX_QUANTITY
    ) {
      haptic("reject");
      setError(`How many must be a whole number between ${MIN_QUANTITY} and ${MAX_QUANTITY}.`);
      return;
    }
    const externalUrl = newUrl().trim() || null;
    const imageKey = newImageKey();

    setNewTitle("");
    setNewPrice("");
    setNewQuantity("1");
    setNewUrl("");
    setNewImageKey(null);
    try {
      const res = await authFetch(itemsUrl(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, priceMinor, quantityWanted, externalUrl, imageKey }),
      });
      if (res.status === 401) return redirectToLogin();
      if (res.status === 409) {
        haptic("reject");
        setError("Your gift list is full — remove something before adding more.");
        return;
      }
      if (res.status === 400) {
        haptic("reject");
        setError("A link must be a full https:// address.");
        return;
      }
      if (!res.ok) throw new Error(`create ${res.status}`);
      const { item } = (await res.json()) as { item: RegistryItem };
      patchSnap((s) => ({ ...s, items: [...s.items, item] }));
      haptic("commit");
    } catch {
      haptic("reject");
      setError("Couldn't add that gift.");
      void reload();
    }
  };

  // ── Edit item ─────────────────────────────────────────────────────────────
  const openEdit = (item: RegistryItem) => {
    setEditingId(item.id);
    setEditTitle(item.title);
    setEditDescription(item.description ?? "");
    setEditPrice(item.priceMinor == null ? "" : minorToInput(item.priceMinor, currency()));
    setEditQuantity(String(item.quantityWanted));
    setEditCategory(item.category ?? "");
    setEditUrl(item.externalUrl ?? "");
    setEditImageKey(item.imageKey);
  };

  const closeEdit = () => setEditingId(null);

  const saveEdit = async (e: Event, item: RegistryItem) => {
    e.preventDefault();
    const title = editTitle().trim();
    if (!title) return;
    setError(null);

    const priceRaw = editPrice().trim();
    const priceMinor = priceRaw === "" ? null : parseMinor(priceRaw, currency());
    if (priceRaw !== "" && priceMinor === null) {
      haptic("reject");
      setError("Price must be a positive amount.");
      return;
    }
    const quantityWanted = Number(editQuantity());
    if (
      !Number.isInteger(quantityWanted) ||
      quantityWanted < MIN_QUANTITY ||
      quantityWanted > MAX_QUANTITY
    ) {
      haptic("reject");
      setError(`How many must be a whole number between ${MIN_QUANTITY} and ${MAX_QUANTITY}.`);
      return;
    }

    const patch = {
      title,
      description: editDescription().trim() || null,
      priceMinor,
      quantityWanted,
      category: editCategory().trim() || null,
      externalUrl: editUrl().trim() || null,
      imageKey: editImageKey(),
    };
    closeEdit();
    try {
      const res = await authFetch(itemUrl(item.id), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (res.status === 401) return redirectToLogin();
      if (res.status === 400) {
        haptic("reject");
        setError("A link must be a full https:// address.");
        void reload();
        return;
      }
      if (!res.ok) throw new Error(`patch ${res.status}`);
      const { item: updated } = (await res.json()) as { item: RegistryItem };
      patchSnap((s) => ({
        ...s,
        items: s.items.map((x) => (x.id === updated.id ? updated : x)),
      }));
      haptic("commit");
    } catch {
      haptic("reject");
      setError("Couldn't save that gift.");
      void reload();
    }
  };

  // ── Delete item ───────────────────────────────────────────────────────────
  const deleteItem = async (item: RegistryItem) => {
    patchSnap((s) => ({ ...s, items: s.items.filter((x) => x.id !== item.id) }));
    haptic("commit");
    try {
      const res = await authFetch(itemUrl(item.id), { method: "DELETE" });
      if (res.status === 401) return redirectToLogin();
      if (!res.ok) throw new Error(`delete ${res.status}`);
    } catch {
      haptic("reject");
      setError("Couldn't remove that gift.");
      void reload();
    }
  };

  // ── Reorder ───────────────────────────────────────────────────────────────
  // Arrow buttons, not drag: the same pattern `ChecklistView`/`BudgetView` use,
  // and the one that already works from a keyboard. Adopting drag here is now
  // cheap — `@shared/sortable`'s `createSortableList` supplies the whole keyboard
  // and screen-reader path — but it is a UX change, so it is its own issue.
  // sensor and no announcements, so adopting it here would mean re-supplying the
  // whole keyboard path by hand — see `wiki/shared/drag-and-drop.md`.
  const move = async (index: number, delta: -1 | 1) => {
    const ordered = items();
    const target = index + delta;
    if (target < 0 || target >= ordered.length) return;

    const reordered = [...ordered];
    const [moved] = reordered.splice(index, 1);
    reordered.splice(target, 0, moved!);
    const orderedIds = reordered.map((it) => it.id);
    const bySort = new Map(orderedIds.map((id, i) => [id, i]));
    // Rewrite ONLY the rows whose position actually changed, and hand every
    // other row back by reference. `<For>` reconciles by item identity, so a
    // blanket `{ ...it }` would tear down and rebuild all up-to-500 rows on
    // every arrow press — losing the inputs and the caret of an inline editor
    // left open below the moved row (REG-P-W1). `items()` re-sorts regardless.
    patchSnap((s) => ({
      ...s,
      items: s.items.map((it) => {
        const next = bySort.get(it.id) ?? it.sortOrder;
        return next === it.sortOrder ? it : { ...it, sortOrder: next };
      }),
    }));
    haptic("commit");
    try {
      const res = await authFetch(`${itemsUrl()}/reorder`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderedIds }),
      });
      if (res.status === 401) return redirectToLogin();
      if (!res.ok) throw new Error(`reorder ${res.status}`);
    } catch {
      haptic("reject");
      setError("Couldn't save the new order.");
      void reload();
    }
  };

  // ── Gift log ──────────────────────────────────────────────────────────────
  /** Who a gift is from. The guest's own `displayName` when they gave one, the
   *  household name otherwise — both guest-authored, both text nodes. */
  const giftFrom = (gift: GiftLogEntry): string => gift.displayName ?? gift.familyName;

  /**
   * The parting summary, or null while the gifts themselves are still here.
   *
   * Non-null is the signal that the retention sweep has run and the per-guest
   * detail is gone — which is also why the empty gift log below must not then
   * say "No gifts yet": after a sweep the log is empty because we deleted it,
   * not because nobody gave anything.
   */
  const giftSummary = createMemo(() => snapshot()?.giftSummary ?? null);

  /** "1 gift" / "3 gifts". */
  const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

  /**
   * A stored ISO day as a readable date.
   *
   * Parsed as UTC and printed as UTC, both ends pinned. The sweep writes a
   * calendar day, not an instant: a bare `2026-06-17` handed to `new Date` is
   * READ as UTC midnight but PRINTED in the reader's zone, which lands a day
   * earlier for everyone west of Greenwich — so the date on the record would
   * differ from the date in the record.
   */
  const summaryDate = (iso: string): string =>
    new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, {
      year: "numeric",
      month: "long",
      day: "numeric",
      timeZone: "UTC",
    });

  /** The two money lines a gift renders as. Foreign-currency gifts show the
   *  as-given amount as the headline with the primary equivalent underneath;
   *  a primary-currency gift shows one line. */
  const giftMoney = (gift: GiftLogEntry) =>
    formatMinorPair(
      { minor: gift.amountMinor ?? 0, currency: gift.currency ?? currency() },
      gift.primaryAmountMinor != null && gift.primaryCurrency != null
        ? { minor: gift.primaryAmountMinor, currency: gift.primaryCurrency }
        : null,
    );

  const toggleThanked = async (gift: GiftLogEntry) => {
    const thanked = gift.thankedAt == null;
    const at = thanked ? Date.now() : null;
    patchSnap((s) => ({
      ...s,
      gifts: s.gifts.map((g) =>
        g.kind === gift.kind && g.id === gift.id ? { ...g, thankedAt: at } : g,
      ),
    }));
    haptic("commit");
    try {
      const res = await authFetch(
        apiUrl(
          `/api/organiser/weddings/${wedding()}/registry/gifts/${encodeURIComponent(
            gift.kind,
          )}/${encodeURIComponent(gift.id)}/thanked`,
        ),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ thanked }),
        },
      );
      if (res.status === 401) return redirectToLogin();
      if (!res.ok) throw new Error(`thanked ${res.status}`);
    } catch {
      haptic("reject");
      setError("Couldn't save that thank-you.");
      void reload();
    }
  };

  /** Fetch the next page of the gift log and append it. The offset is the number
   *  of rows already held, so a page that arrives while a gift is being added
   *  can repeat a row rather than skip one — the lesser of the two errors. */
  const loadMoreGifts = async () => {
    const cur = peekCachedRegistry(props.weddingId);
    if (!cur || loadingMore()) return;
    setLoadingMore(true);
    try {
      const res = await authFetch(registryUrl(cur.gifts.length));
      if (res.status === 401) return redirectToLogin();
      if (!res.ok) throw new Error(`gifts ${res.status}`);
      const next = (await res.json()) as RegistrySnapshot;
      patchSnap((s) => ({
        ...s,
        gifts: [...s.gifts, ...next.gifts],
        giftsHasMore: next.giftsHasMore,
      }));
    } catch {
      haptic("reject");
      setError("Couldn't load more gifts.");
    } finally {
      setLoadingMore(false);
    }
  };

  // ── Export ────────────────────────────────────────────────────────────────
  // The couple's own copy of the gift log. The view above pages 50 at a time
  // and the whole log is deleted a year after the wedding (the summary band
  // says so), so a download is the only way they keep who gave what, in which
  // currency, and what the guest wrote.
  //
  // Reports outcome through toasts rather than the `error()` Notice above: that
  // Notice is for a view that failed to load and stays broken, and a download
  // that failed is a transient thing the couple retries — the same shape the
  // guest and RSVP exports already use in `GuestTable`.
  const exportGifts = async () => {
    if (exporting()) return;
    setExporting(true);
    try {
      const res = await authFetch(apiUrl(`/api/organiser/weddings/${wedding()}/gifts.csv`));
      if (res.status === 401) return redirectToLogin();
      if (!res.ok) throw new Error(`Export failed (${res.status})`);
      downloadBlob(`cire-gifts-${props.weddingSlug}.csv`, await res.blob());
      toast.success("Gift log downloaded");
    } catch (err) {
      if (isAuthExpired(err)) return redirectToLogin();
      haptic("reject");
      toast.error("Gift export failed. Try again.");
    } finally {
      setExporting(false);
    }
  };

  return (
    <div class="flex flex-col gap-6">
      <Show when={error()}>
        <Notice tone="danger" alert>
          {error()}
        </Notice>
      </Show>

      {/* ── The gift list ─────────────────────────────────────────────────── */}
      <Show when={props.view === "list"}>
        <Show when={props.canEdit}>
          <form
            onSubmit={addItem}
            class="border-border bg-surface/20 flex flex-wrap items-end gap-3 rounded-sm border p-4"
          >
            <Field label="Gift" class="min-w-48 flex-1">
              {(field) => (
                <Input
                  {...field}
                  value={newTitle()}
                  onInput={(e) => setNewTitle(e.currentTarget.value)}
                  placeholder="Copper pan, a good bottle of something…"
                />
              )}
            </Field>
            <Field label="Price (optional)" class="w-28">
              {(field) => (
                <Input
                  {...field}
                  type="number"
                  min="0"
                  // `any`, not `0.01`: how many decimals a price may carry is a
                  // property of the wedding's currency (KWD has three, JPY none),
                  // and a fixed hundredths step would reject a valid Kuwaiti
                  // price outright. `parseMinor` rounds to the right exponent.
                  step="any"
                  value={newPrice()}
                  onInput={(e) => setNewPrice(e.currentTarget.value)}
                  placeholder="0.00"
                />
              )}
            </Field>
            <Field label="How many" class="w-20">
              {(field) => (
                <Input
                  {...field}
                  type="number"
                  min={MIN_QUANTITY}
                  max={MAX_QUANTITY}
                  step="1"
                  value={newQuantity()}
                  onInput={(e) => setNewQuantity(e.currentTarget.value)}
                />
              )}
            </Field>
            <Field label="Link (optional)" class="w-56">
              {(field) => (
                <Input
                  {...field}
                  type="url"
                  value={newUrl()}
                  onInput={(e) => setNewUrl(e.currentTarget.value)}
                  placeholder="https://…"
                />
              )}
            </Field>
            <div class="w-full">
              <RegistryImageField
                weddingId={props.weddingId}
                imageKey={newImageKey()}
                onChange={setNewImageKey}
                idPrefix="registry-new"
              />
            </div>
            <Button type="submit" variant="primary">
              Add gift
            </Button>
          </form>
        </Show>

        <Show
          when={items().length > 0}
          fallback={<p class="text-text-muted text-ui-sm italic">No gifts on the list yet.</p>}
        >
          <ul class="flex flex-col gap-1">
            <For each={items()}>
              {(item, i) => (
                <li class="border-border bg-surface/10 flex flex-col gap-2 rounded-sm border px-3 py-2">
                  <div class="flex flex-wrap items-center gap-3">
                    <span class="text-text text-ui-base min-w-40 flex-1 font-medium">
                      {item.title}
                    </span>
                    <Show when={item.category}>
                      <span class="bg-surface/60 text-text-muted text-ui-xs rounded-full px-2 py-0.5">
                        {item.category}
                      </span>
                    </Show>
                    <Show when={item.priceMinor != null}>
                      <span class="text-text text-ui-sm">
                        {formatMinor(item.priceMinor!, currency())}
                      </span>
                    </Show>
                    {/* Claimed-vs-wanted, so the couple can see what is still
                        open without reading the gift log. */}
                    <span class="text-text-muted text-ui-sm">
                      {item.quantityClaimed} of {item.quantityWanted} claimed
                      {stillWanted(item) === 0 ? " · all taken" : ""}
                    </span>
                    {/* Scheme-checked at the render site, not merely at write
                        time (precedent CON-S-L2: `vendor.privacyUrl` reached an
                        `href` with no check). The API schema already refuses
                        anything but `https:`, but a row can also arrive from a
                        migration or a fixture, and a `javascript:` href here
                        runs in the organiser's own origin.

                        The `aria-label` names the item, because a screen-reader
                        user listing the page's links otherwise hears "Link,
                        link, link" with nothing to tell them apart (C-L2). */}
                    <Show when={item.externalUrl && isHttpsUrl(item.externalUrl)}>
                      <a
                        href={item.externalUrl!}
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-label={`Open the shop page for ${item.title}`}
                        class="text-gold-dim hover:text-gold text-ui-sm underline-offset-2 hover:underline"
                      >
                        Link
                      </a>
                    </Show>

                    <Show when={props.canEdit}>
                      <div class="flex items-center gap-2">
                        <Button
                          variant="bare"
                          type="button"
                          aria-label={`Move ${item.title} up`}
                          disabled={i() === 0}
                          onClick={() => move(i(), -1)}
                        >
                          ↑
                        </Button>
                        <Button
                          variant="bare"
                          type="button"
                          aria-label={`Move ${item.title} down`}
                          disabled={i() === items().length - 1}
                          onClick={() => move(i(), 1)}
                        >
                          ↓
                        </Button>
                        <Button
                          variant="link"
                          type="button"
                          aria-label={`Edit ${item.title}`}
                          onClick={() => (editingId() === item.id ? closeEdit() : openEdit(item))}
                        >
                          Edit
                        </Button>
                        <Button
                          variant="bareDanger"
                          type="button"
                          aria-label={`Remove ${item.title}`}
                          onClick={() => deleteItem(item)}
                        >
                          ✕
                        </Button>
                      </div>
                    </Show>
                  </div>

                  <Show when={item.description}>
                    <p class="text-text-muted text-ui-sm">{item.description}</p>
                  </Show>

                  {/* Inline editor */}
                  <Show when={editingId() === item.id}>
                    <form
                      onSubmit={(e) => saveEdit(e, item)}
                      class="border-border/60 ml-2 flex flex-wrap items-end gap-3 border-l pl-3"
                    >
                      <Field label="Gift" class="min-w-48 flex-1">
                        {(field) => (
                          <Input
                            {...field}
                            size="sm"
                            value={editTitle()}
                            onInput={(e) => setEditTitle(e.currentTarget.value)}
                          />
                        )}
                      </Field>
                      <Field label="Price" class="w-28">
                        {(field) => (
                          <Input
                            {...field}
                            size="sm"
                            type="number"
                            min="0"
                            step="any"
                            value={editPrice()}
                            onInput={(e) => setEditPrice(e.currentTarget.value)}
                          />
                        )}
                      </Field>
                      <Field label="How many" class="w-20">
                        {(field) => (
                          <Input
                            {...field}
                            size="sm"
                            type="number"
                            min={MIN_QUANTITY}
                            max={MAX_QUANTITY}
                            step="1"
                            value={editQuantity()}
                            onInput={(e) => setEditQuantity(e.currentTarget.value)}
                          />
                        )}
                      </Field>
                      <Field label="Category" class="w-32">
                        {(field) => (
                          <Input
                            {...field}
                            size="sm"
                            value={editCategory()}
                            onInput={(e) => setEditCategory(e.currentTarget.value)}
                            placeholder="Kitchen"
                          />
                        )}
                      </Field>
                      <Field label="Link" class="w-56">
                        {(field) => (
                          <Input
                            {...field}
                            size="sm"
                            type="url"
                            value={editUrl()}
                            onInput={(e) => setEditUrl(e.currentTarget.value)}
                            placeholder="https://…"
                          />
                        )}
                      </Field>
                      <Field label="Description" class="min-w-56 flex-1">
                        {(field) => (
                          <Textarea
                            {...field}
                            size="sm"
                            rows={2}
                            value={editDescription()}
                            onInput={(e) => setEditDescription(e.currentTarget.value)}
                          />
                        )}
                      </Field>
                      <div class="w-full">
                        <RegistryImageField
                          weddingId={props.weddingId}
                          imageKey={editImageKey()}
                          onChange={setEditImageKey}
                          idPrefix={`registry-edit-${item.id}`}
                        />
                      </div>
                      <div class="flex items-end gap-2">
                        <Button type="submit" variant="primary" size="sm">
                          Save
                        </Button>
                        <Button variant="quiet" size="sm" onClick={closeEdit}>
                          Cancel
                        </Button>
                      </div>
                    </form>
                  </Show>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </Show>

      {/* ── Gifts received ────────────────────────────────────────────────── */}
      <Show when={props.view === "gifts"}>
        {/* The record that outlives the detail. Written by the retention sweep a
            year after the last event, in the same pass that deletes the
            households every gift hangs off — so this is not a summary OF the log
            below, it is what stands INSTEAD of it. The copy has to say that
            outright, or a couple reads an empty log as an empty guest list.
            Rendered ONLY when a summary exists, i.e. only after the sweep. */}
        <Show when={giftSummary()}>
          {(summary) => (
            <div class="border-border bg-surface/20 flex flex-col gap-2 rounded-sm border p-4">
              <span class="text-gold-dim font-body text-ui-xs tracking-ui-widest uppercase">
                Your record of gifts
              </span>
              <p class="text-text-muted text-ui-sm">
                On {summaryDate(summary().sweptOn)}, a year after your wedding, we deleted your
                guests' details — and the gifts went with them. Who gave what, and the notes they
                wrote, are gone. These totals are what we kept.
              </p>
              <Show when={summary().claims.reserved + summary().claims.purchased > 0}>
                <span class="text-text text-ui-md">
                  {plural(summary().claims.reserved + summary().claims.purchased, "gift", "gifts")}{" "}
                  from your list
                  <span class="text-text-muted text-ui-sm">
                    {" "}
                    · {summary().claims.purchased} marked bought
                  </span>
                </span>
              </Show>
              <Show when={summary().contributions.count > 0}>
                {/* Per currency, side by side, never added together: a total
                    that re-values itself is not a record of anything, and
                    there is nothing left here to re-derive a rate from. */}
                <span class="text-text text-ui-md">
                  {summary()
                    .contributions.totals.map((total) =>
                      formatMinor(total.amountMinor, total.currency),
                    )
                    .join(" · ")}
                  <span class="text-text-muted text-ui-sm">
                    {" "}
                    · {plural(summary().contributions.count, "cash gift", "cash gifts")}
                  </span>
                </span>
              </Show>
              <span class="text-text-muted text-ui-sm">
                Gifts arrived between {summaryDate(summary().firstGiftOn)} and{" "}
                {summaryDate(summary().lastGiftOn)}. Each currency is totalled as it was given.
              </span>
            </div>
          )}
        </Show>
        <Show when={snapshot()}>
          {(snap) => (
            <Show
              when={
                snap().contributionsPrimaryMinor > 0 || snap().contributionsOtherCurrencyCount > 0
              }
            >
              <div class="border-border bg-surface/20 flex flex-col gap-1 rounded-sm border p-4">
                <span class="text-gold-dim font-body text-ui-xs tracking-ui-widest uppercase">
                  Cash gifts
                </span>
                <span class="text-text text-ui-md">
                  {formatMinor(snap().contributionsPrimaryMinor, snap().currency)}
                </span>
                {/* A gift converted to the couple's currency was converted at the
                    rate on the day it arrived, so this is a sum of historical
                    conversions, not a live valuation. Labelled, never exact. */}
                <span class="text-text-muted text-ui-sm">
                  Approximate — a gift given in another currency is counted at the rate on the day
                  it arrived.
                </span>
                {/* Adding two currencies together gives a number that is not an
                    amount of anything, so gifts left in their own currency are
                    counted here instead of being folded into the figure above. */}
                <Show when={snap().contributionsOtherCurrencyCount > 0}>
                  <span class="text-text-muted text-ui-sm">
                    {snap().contributionsOtherCurrencyCount === 1
                      ? "One more gift is held in another currency and is not in this total."
                      : `${snap().contributionsOtherCurrencyCount} more gifts are held in other currencies and are not in this total.`}{" "}
                    The gift log below shows each one as it was given.
                  </span>
                </Show>
              </div>
            </Show>
          )}
        </Show>

        {/* Shown only when there is a log to download — after the retention
            sweep the list is empty and an export would hand back a header row.
            `Button` rather than the raw classes `GuestTable` uses, to match the
            "Load more gifts" control below it. */}
        <Show when={gifts().length > 0}>
          <Button
            variant="quiet"
            size="sm"
            class="self-start"
            disabled={exporting()}
            onClick={() => void exportGifts()}
          >
            {exporting() ? "Exporting…" : "Download gifts (CSV)"}
          </Button>
        </Show>

        <Show
          when={gifts().length > 0}
          fallback={
            // After a sweep the log is empty because we deleted it — the band
            // above has just said so, and "No gifts yet." underneath it would
            // flatly contradict it.
            <Show when={!giftSummary()}>
              <p class="text-text-muted text-ui-sm italic">No gifts yet.</p>
            </Show>
          }
        >
          <ul class="flex flex-col gap-1">
            <For each={gifts()}>
              {(gift) => {
                // One formatting pass per row: `formatMinorPair` was called
                // three times in the markup below, and it is the only
                // non-trivial work a gift row does (REG-P-I1).
                const money = giftMoney(gift);
                const status = giftStatus(gift);
                return (
                  <li class="border-border bg-surface/10 flex flex-col gap-1 rounded-sm border px-3 py-2">
                    <div class="flex flex-wrap items-center gap-3">
                      {/* Guest-authored — a text node, never markup (S-L3). */}
                      <span class="text-text text-ui-base min-w-40 flex-1 font-medium">
                        {giftFrom(gift)}
                      </span>
                      <span class="text-text-muted text-ui-sm">
                        {gift.itemTitle ?? "Cash gift"}
                      </span>
                      <Show when={(gift.quantity ?? 1) > 1}>
                        <span class="text-text-muted text-ui-sm">×{gift.quantity}</span>
                      </Show>
                      <Show when={gift.amountMinor != null}>
                        <span class="flex flex-col items-end">
                          <span class="text-text text-ui-sm">{money.given}</span>
                          <Show when={money.primary}>
                            <span class="text-text-muted text-ui-xs">≈ {money.primary}</span>
                          </Show>
                        </span>
                      </Show>
                      <span
                        class={
                          status.gone
                            ? "bg-error/10 text-error text-ui-xs rounded-full px-2 py-0.5"
                            : "bg-surface/60 text-text-muted text-ui-xs rounded-full px-2 py-0.5"
                        }
                      >
                        {status.label}
                      </span>
                      <Show
                        when={props.canEdit}
                        fallback={
                          <Show when={gift.thankedAt != null}>
                            <span class="text-text-muted text-ui-sm">Thanked</span>
                          </Show>
                        }
                      >
                        <Button
                          variant="link"
                          type="button"
                          aria-pressed={gift.thankedAt != null}
                          aria-label={`Mark thanked: ${giftFrom(gift)}`}
                          onClick={() => toggleThanked(gift)}
                        >
                          {gift.thankedAt != null ? "Thanked" : "Mark thanked"}
                        </Button>
                      </Show>
                    </div>
                    {/* A refunded gift stays in the log and stays out of the
                        total, which is two facts a one-word pill cannot carry. */}
                    <Show when={gift.kind === "contribution" && gift.status === "refunded"}>
                      <p class="text-text-muted text-ui-sm">
                        This one went back to the guest, so it is not counted in the total above.
                      </p>
                    </Show>
                    <Show when={gift.note}>
                      {/* Guest-authored — a text node, never markup (S-L3). */}
                      <p class="text-text-muted text-ui-sm italic">{gift.note}</p>
                    </Show>
                  </li>
                );
              }}
            </For>
          </ul>
        </Show>

        <Show when={snapshot()?.giftsHasMore}>
          <Button
            variant="quiet"
            size="sm"
            class="self-start"
            disabled={loadingMore()}
            onClick={() => void loadMoreGifts()}
          >
            {loadingMore() ? "Loading…" : "Load more gifts"}
          </Button>
        </Show>
      </Show>
    </div>
  );
}
