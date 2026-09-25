import Button from "@cire/ui/button";
import { useAuth } from "@shared/rp-auth/solid";
import {
  closestCenter,
  createSortable,
  createSortableList,
  DragDropProvider,
  DragDropSensors,
  maybeTransformStyle,
  SortableProvider,
  useDragDropContext,
} from "@shared/sortable";
import { Field } from "@shared/ui/ui/field";
import { Input } from "@shared/ui/ui/input";
import { Notice } from "@shared/ui/ui/notice";
import { Select } from "@shared/ui/ui/select";
import { createMemo, createSignal, For, onMount, Show, untrack } from "solid-js";

import { apiUrl, isAuthExpired, redirectToLogin } from "../lib/api";
import {
  type BudgetItemRow,
  type BudgetSnapshot,
  budgetAccessor,
  ensureBudgetLoaded,
  invalidateBudget,
  itemSpend,
  type PaymentRow,
  peekCachedBudget,
  setCachedBudget,
} from "../lib/budget-store";
import { haptic } from "../lib/haptics";
import { formatMinor } from "../lib/money";
import { categoryLabel, SERVICE_CATEGORIES, type ServiceCategory } from "../lib/service-categories";
import ReorderControls from "./ReorderControls";
interface BudgetViewProps {
  weddingId: string;
  /** Owner/editor may add/edit items + payments and reorder. */
  canEdit?: boolean;
  /** Owner-only: edit the overall budget cap. */
  canManage?: boolean;
}

/** Format minor units as major with the wedding currency, e.g. 1250000 → "$12,500.00".
 *  Delegates to the shared `lib/money` formatter: it memoises the `Intl` instance
 *  (this one built a fresh formatter per cell, inside a `<For>`) and it knows the
 *  currency's real minor-unit exponent, which a fixed `/ 100` gets wrong for JPY
 *  and the three-decimal currencies. */
const fmtMinor = (minor: number, currency: string): string => formatMinor(minor, currency);

/** A category with nothing in it. One shared array, so `sameRows` sees an empty
 *  category as unchanged from one write to the next. */
const NO_ITEMS: BudgetItemRow[] = [];

/** Same rows, same order, same objects: a write elsewhere in the budget left this
 *  category alone, so nothing that reads it needs to run again. */
const sameRows = <T,>(a: readonly T[], b: readonly T[]): boolean =>
  a.length === b.length && a.every((row, k) => row === b[k]);

export default function BudgetView(props: BudgetViewProps) {
  const { authFetch } = useAuth();
  const snapshot = budgetAccessor(props.weddingId);
  const [error, setError] = createSignal<string | null>(null);
  const [newCategory, setNewCategory] = createSignal<ServiceCategory>(SERVICE_CATEGORIES[0]!.key);
  const [newName, setNewName] = createSignal("");
  const [newEstimate, setNewEstimate] = createSignal("");
  const [expanded, setExpanded] = createSignal<string | null>(null);

  const budgetUrl = () => apiUrl(`/api/organiser/weddings/${props.weddingId}/budget`);
  const currency = () => snapshot()?.currency ?? "AUD";

  const load = async (): Promise<BudgetSnapshot> => {
    const res = await authFetch(budgetUrl());
    if (res.status === 401) {
      redirectToLogin();
      return { items: [], payments: [], budgetTotalMinor: null, currency: "AUD" };
    }
    if (!res.ok) throw new Error(`Failed to load budget (${res.status})`);
    return (await res.json()) as BudgetSnapshot;
  };

  onMount(() => {
    ensureBudgetLoaded(props.weddingId, load).catch((err) => {
      if (isAuthExpired(err)) return redirectToLogin();
      setError("Couldn't load your budget. Refresh to try again.");
    });
  });

  const reload = async () => {
    invalidateBudget(props.weddingId);
    try {
      await ensureBudgetLoaded(props.weddingId, load);
    } catch (err) {
      if (isAuthExpired(err)) return redirectToLogin();
      setError("Couldn't refresh your budget.");
    }
  };

  // Convenience: mutate the cached snapshot with a producer.
  const patchSnap = (fn: (s: BudgetSnapshot) => BudgetSnapshot) => {
    const cur = peekCachedBudget(props.weddingId);
    if (cur) setCachedBudget(props.weddingId, fn(cur));
  };

  // Each category's items in order. A map of fresh arrays holding the SAME item
  // objects, so a category's `<For>` keeps every row whose item did not change.
  const itemsByCategory = createMemo(() => {
    const byCategory = new Map<string, BudgetItemRow[]>();
    for (const item of snapshot()?.items ?? []) {
      const category = byCategory.get(item.category);
      if (category) category.push(item);
      else byCategory.set(item.category, [item]);
    }
    for (const category of byCategory.values()) category.sort((a, b) => a.sortOrder - b.sortOrder);
    return byCategory;
  });
  /** Whether any item sits in a category this view shows. */
  const hasItems = createMemo(() =>
    SERVICE_CATEGORIES.some((c) => (itemsByCategory().get(c.key)?.length ?? 0) > 0),
  );

  const paymentsFor = (itemId: string): PaymentRow[] =>
    (snapshot()?.payments ?? []).filter((p) => p.budgetItemId === itemId);

  const spent = createMemo(() => {
    const items = snapshot()?.items ?? [];
    return items.reduce((sum, it) => sum + itemSpend(it), 0);
  });

  // ── Item writes ──────────────────────────────────────────────────────────
  const addItem = async (e: Event) => {
    e.preventDefault();
    const name = newName().trim();
    if (!name) return;
    setError(null);
    const estMinor = newEstimate().trim() === "" ? null : Math.round(Number(newEstimate()) * 100);
    if (estMinor !== null && (!Number.isFinite(estMinor) || estMinor < 0)) {
      haptic("reject");
      setError("Estimate must be a positive amount.");
      return;
    }
    const body = { category: newCategory(), name, estimateMinor: estMinor };
    setNewName("");
    setNewEstimate("");
    try {
      const res = await authFetch(
        apiUrl(`/api/organiser/weddings/${props.weddingId}/budget/items`),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      if (res.status === 401) return redirectToLogin();
      if (!res.ok) throw new Error(`create ${res.status}`);
      const { item } = (await res.json()) as { item: BudgetItemRow };
      patchSnap((s) => ({ ...s, items: [...s.items, item] }));
      haptic("commit");
    } catch {
      haptic("reject");
      setError("Couldn't add that item.");
      void reload();
    }
  };

  const patchItemMoney = async (
    item: BudgetItemRow,
    field: "estimateMinor" | "quotedMinor" | "actualMinor",
    raw: string,
  ) => {
    const minor = raw.trim() === "" ? null : Math.round(Number(raw) * 100);
    if (minor !== null && (!Number.isFinite(minor) || minor < 0)) {
      haptic("reject");
      setError("Amounts must be positive.");
      return;
    }
    // Optimistic.
    patchSnap((s) => ({
      ...s,
      items: s.items.map((it) => (it.id === item.id ? { ...it, [field]: minor } : it)),
    }));
    haptic("commit");
    try {
      const res = await authFetch(
        apiUrl(`/api/organiser/weddings/${props.weddingId}/budget/items/${item.id}`),
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ [field]: minor }),
        },
      );
      if (res.status === 401) return redirectToLogin();
      if (!res.ok) throw new Error(`patch ${res.status}`);
      const { item: updated } = (await res.json()) as { item: BudgetItemRow };
      patchSnap((s) => ({
        ...s,
        items: s.items.map((it) => (it.id === updated.id ? updated : it)),
      }));
    } catch {
      haptic("reject");
      setError("Couldn't save that amount.");
      void reload();
    }
  };

  const deleteItem = async (item: BudgetItemRow) => {
    patchSnap((s) => ({
      ...s,
      items: s.items.filter((it) => it.id !== item.id),
      payments: s.payments.filter((p) => p.budgetItemId !== item.id),
    }));
    haptic("commit");
    try {
      const res = await authFetch(
        apiUrl(`/api/organiser/weddings/${props.weddingId}/budget/items/${item.id}`),
        { method: "DELETE" },
      );
      if (res.status === 401) return redirectToLogin();
      if (!res.ok) throw new Error(`delete ${res.status}`);
    } catch {
      haptic("reject");
      setError("Couldn't delete that item.");
      void reload();
    }
  };

  /**
   * Move an item within its category, then save the category's new order. A drag
   * can move it several places at once. Only items whose stored `sortOrder`
   * changes get a new object, so every other row — an open payments panel
   * included — keeps its DOM. `onFailure` withdraws the move's announcement, since the reload that
   * follows puts the old order back.
   */
  const move = async (
    category: ServiceCategory,
    from: number,
    to: number,
    onFailure: () => void,
  ) => {
    const items = itemsByCategory().get(category) ?? [];
    if (from === to || to < 0 || to >= items.length) return;
    const reordered = [...items];
    const [moved] = reordered.splice(from, 1);
    reordered.splice(to, 0, moved!);
    const orderedIds = reordered.map((it) => it.id);
    const bySort = new Map(orderedIds.map((id, i) => [id, i]));
    patchSnap((s) => ({
      ...s,
      items: s.items.map((it) => {
        const next = it.category === category ? bySort.get(it.id) : undefined;
        return next === undefined || next === it.sortOrder ? it : { ...it, sortOrder: next };
      }),
    }));
    try {
      const res = await authFetch(
        apiUrl(`/api/organiser/weddings/${props.weddingId}/budget/items/reorder`),
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ category, orderedIds }),
        },
      );
      if (res.status === 401) return redirectToLogin();
      if (!res.ok) throw new Error(`reorder ${res.status}`);
    } catch {
      haptic("reject");
      setError("Couldn't save the new order.");
      onFailure();
      void reload();
    }
  };

  // ── Payment writes ───────────────────────────────────────────────────────
  const addPayment = async (
    item: BudgetItemRow,
    label: string,
    amountText: string,
    dueAt: string,
  ) => {
    const amount = Math.round(Number(amountText) * 100);
    if (!label.trim() || !Number.isFinite(amount) || amount < 0) {
      haptic("reject");
      setError("A payment needs a label and a positive amount.");
      return;
    }
    try {
      const res = await authFetch(
        apiUrl(`/api/organiser/weddings/${props.weddingId}/budget/items/${item.id}/payments`),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ label: label.trim(), amountMinor: amount, dueAt: dueAt || null }),
        },
      );
      if (res.status === 401) return redirectToLogin();
      if (!res.ok) throw new Error(`payment ${res.status}`);
      const { payment } = (await res.json()) as { payment: PaymentRow };
      patchSnap((s) => ({ ...s, payments: [...s.payments, payment] }));
      haptic("commit");
    } catch {
      haptic("reject");
      setError("Couldn't add that payment.");
      void reload();
    }
  };

  const togglePaid = async (item: BudgetItemRow, payment: PaymentRow) => {
    const paid = payment.paidAt == null;
    patchSnap((s) => ({
      ...s,
      payments: s.payments.map((p) =>
        p.id === payment.id ? { ...p, paidAt: paid ? Date.now() : null } : p,
      ),
    }));
    haptic("commit");
    try {
      const res = await authFetch(
        apiUrl(
          `/api/organiser/weddings/${props.weddingId}/budget/items/${item.id}/payments/${payment.id}`,
        ),
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ paid }),
        },
      );
      if (res.status === 401) return redirectToLogin();
      if (!res.ok) throw new Error(`patch payment ${res.status}`);
      const { payment: updated } = (await res.json()) as { payment: PaymentRow };
      patchSnap((s) => ({
        ...s,
        payments: s.payments.map((p) => (p.id === updated.id ? updated : p)),
      }));
    } catch {
      haptic("reject");
      setError("Couldn't update that payment.");
      void reload();
    }
  };

  const deletePayment = async (item: BudgetItemRow, payment: PaymentRow) => {
    patchSnap((s) => ({ ...s, payments: s.payments.filter((p) => p.id !== payment.id) }));
    haptic("commit");
    try {
      const res = await authFetch(
        apiUrl(
          `/api/organiser/weddings/${props.weddingId}/budget/items/${item.id}/payments/${payment.id}`,
        ),
        { method: "DELETE" },
      );
      if (res.status === 401) return redirectToLogin();
      if (!res.ok) throw new Error(`delete payment ${res.status}`);
    } catch {
      haptic("reject");
      setError("Couldn't delete that payment.");
      void reload();
    }
  };

  // ── Cap (owner only) ─────────────────────────────────────────────────────
  const [capDraft, setCapDraft] = createSignal<string | null>(null);
  const saveCap = async () => {
    const draft = capDraft();
    if (draft == null) return;
    const minor = draft.trim() === "" ? null : Math.round(Number(draft) * 100);
    if (minor !== null && (!Number.isFinite(minor) || minor < 0)) {
      haptic("reject");
      setError("Budget must be a positive amount.");
      return;
    }
    patchSnap((s) => ({ ...s, budgetTotalMinor: minor }));
    setCapDraft(null);
    try {
      const res = await authFetch(
        apiUrl(`/api/organiser/weddings/${props.weddingId}/budget/total`),
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ budgetTotalMinor: minor }),
        },
      );
      if (res.status === 401) return redirectToLogin();
      if (!res.ok) throw new Error(`cap ${res.status}`);
      haptic("commit");
    } catch {
      haptic("reject");
      setError("Couldn't save the budget total.");
      void reload();
    }
  };

  return (
    <div class="flex flex-col gap-6">
      <Show when={error()}>
        <Notice tone="danger" alert>
          {error()}
        </Notice>
      </Show>

      {/* Summary — spent vs cap, owner cap editor. */}
      <div class="border-border bg-surface/20 flex flex-wrap items-center justify-between gap-4 rounded-sm border p-4">
        <div class="flex flex-col gap-1">
          <span class="text-gold-dim font-body text-ui-xs tracking-ui-widest uppercase">
            Spent so far
          </span>
          <span class="text-text text-ui-lg font-semibold">
            {fmtMinor(spent(), currency())}
            <Show when={snapshot()?.budgetTotalMinor != null}>
              <span class="text-text-muted text-ui-base font-normal">
                {" "}
                of {fmtMinor(snapshot()!.budgetTotalMinor!, currency())}
              </span>
            </Show>
          </span>
          <Show
            when={
              snapshot()?.budgetTotalMinor != null && spent() > (snapshot()?.budgetTotalMinor ?? 0)
            }
          >
            <span class="text-error text-ui-sm">Over budget</span>
          </Show>
        </div>
        <Show when={props.canManage}>
          <Show
            when={capDraft() !== null}
            fallback={
              <Button
                variant="link"
                type="button"
                onClick={() =>
                  setCapDraft(
                    snapshot()?.budgetTotalMinor == null
                      ? ""
                      : (snapshot()!.budgetTotalMinor! / 100).toString(),
                  )
                }
              >
                {snapshot()?.budgetTotalMinor == null ? "Set a budget →" : "Edit budget"}
              </Button>
            }
          >
            <div class="flex items-end gap-2">
              <Field label={`Total budget (${currency()})`} class="w-32">
                {(field) => (
                  <Input
                    {...field}
                    type="number"
                    min="0"
                    step="0.01"
                    value={capDraft() ?? ""}
                    onInput={(e) => setCapDraft(e.currentTarget.value)}
                  />
                )}
              </Field>
              <Button variant="primary" onClick={saveCap}>
                Save
              </Button>
              <Button variant="quiet" onClick={() => setCapDraft(null)}>
                Cancel
              </Button>
            </div>
          </Show>
        </Show>
      </div>

      {/* Add item (editor). */}
      <Show when={props.canEdit}>
        <form
          onSubmit={addItem}
          class="border-border bg-surface/20 flex flex-wrap items-end gap-3 rounded-sm border p-4"
        >
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
          <Field label="Item" class="min-w-48 flex-1">
            {(field) => (
              <Input
                {...field}
                value={newName()}
                onInput={(e) => setNewName(e.currentTarget.value)}
                placeholder="Caterer, venue, band…"
              />
            )}
          </Field>
          <Field label="Estimate (optional)" class="w-32">
            {(field) => (
              <Input
                {...field}
                type="number"
                min="0"
                step="0.01"
                value={newEstimate()}
                onInput={(e) => setNewEstimate(e.currentTarget.value)}
              />
            )}
          </Field>
          <Button type="submit" variant="primary">
            Add item
          </Button>
        </form>
      </Show>

      <Show
        when={hasItems()}
        fallback={<p class="text-text-muted text-ui-sm italic">No budget items yet.</p>}
      >
        {/* Categories pair up on a wide panel. The minimum is generous (32rem)
            because a budget row carries a name plus three money cells and the
            payments toggle — below that it wraps and stops being a table-like
            row, so the grid keeps one column until two really fit.

            Over the fixed category list, not over a memo of groups: each
            category's sortable list holds its grips (focus goes back to one
            after a move) and its live region, so it has to outlive every write
            to the budget. An empty category renders nothing. */}
        <div class="auto-grid items-start [--auto-grid-gap:1.5rem] [--auto-grid-min:32rem]">
          <For each={SERVICE_CATEGORIES}>
            {(category) => {
              const categoryItems = createMemo(
                () => itemsByCategory().get(category.key) ?? NO_ITEMS,
                NO_ITEMS,
                { equals: sameRows },
              );
              const count = createMemo(() => categoryItems().length);
              const ids = createMemo(() => categoryItems().map((it) => it.id));
              // One list per category: an item only moves within its own
              // category, because moving it to another changes what it is.
              const reorder = createSortableList({
                ids,
                labelFor: (id) =>
                  untrack(() => categoryItems().find((it) => it.id === id)?.name) ?? "item",
                noun: "item",
                onMove: (from, to) => void move(category.key, from, to, reorder.clearAnnouncement),
                onPhase: (phase) => haptic(phase),
              });
              const subtotalEst = () =>
                categoryItems().reduce((s, it) => s + (it.estimateMinor ?? 0), 0);
              const subtotalActual = () => categoryItems().reduce((s, it) => s + itemSpend(it), 0);
              return (
                <Show when={categoryItems().length > 0}>
                  <section class="flex flex-col gap-2">
                    <div class="flex items-baseline justify-between">
                      <h3 class="text-gold-dim font-body text-ui-xs tracking-ui-widest uppercase">
                        {categoryLabel(category.key)}
                      </h3>
                      <span class="text-text-muted text-ui-sm">
                        est {fmtMinor(subtotalEst(), currency())} · spent{" "}
                        {fmtMinor(subtotalActual(), currency())}
                      </span>
                    </div>
                    <DragDropProvider {...reorder.dragHandlers} collisionDetector={closestCenter}>
                      <DragDropSensors />
                      <ul class="flex flex-col gap-1" data-testid={`budget-${category.key}`}>
                        <SortableProvider ids={ids()}>
                          <For each={categoryItems()}>
                            {(item, i) => {
                              const sortable = createSortable(item.id);
                              // Non-null: rendered inside the DragDropProvider above.
                              const [dndState] = useDragDropContext()!;
                              const sortableItem = reorder.item(item.id, i, count);
                              return (
                                <li
                                  ref={sortable.ref}
                                  style={maybeTransformStyle(sortable.transform())}
                                  class="border-border bg-surface/10 relative flex flex-col gap-2 rounded-sm border px-3 py-2"
                                  classList={{
                                    "border-gold/60 bg-surface/80 z-10 shadow-lg":
                                      sortable.isActiveDraggable(),
                                    "transition-transform":
                                      !!dndState.active().draggable &&
                                      !sortable.isActiveDraggable(),
                                  }}
                                >
                                  <div class="flex flex-wrap items-center gap-3">
                                    <Show when={props.canEdit}>
                                      <ReorderControls sortable={sortable} item={sortableItem} />
                                    </Show>
                                    <span class="text-text text-ui-base min-w-32 flex-1">
                                      {item.name}
                                    </span>
                                    <MoneyCell
                                      label="Est"
                                      minor={item.estimateMinor}
                                      currency={currency()}
                                      canEdit={props.canEdit}
                                      onCommit={(raw) => patchItemMoney(item, "estimateMinor", raw)}
                                    />
                                    <MoneyCell
                                      label="Quote"
                                      minor={item.quotedMinor}
                                      currency={currency()}
                                      canEdit={props.canEdit}
                                      onCommit={(raw) => patchItemMoney(item, "quotedMinor", raw)}
                                    />
                                    <MoneyCell
                                      label="Actual"
                                      minor={item.actualMinor}
                                      currency={currency()}
                                      canEdit={props.canEdit}
                                      onCommit={(raw) => patchItemMoney(item, "actualMinor", raw)}
                                    />
                                    <Button
                                      variant="bare"
                                      type="button"
                                      onClick={() =>
                                        setExpanded(expanded() === item.id ? null : item.id)
                                      }
                                    >
                                      payments ({paymentsFor(item.id).length})
                                    </Button>
                                    <Show when={props.canEdit}>
                                      <Button
                                        variant="bareDanger"
                                        type="button"
                                        aria-label="Delete item"
                                        onClick={() => deleteItem(item)}
                                      >
                                        ✕
                                      </Button>
                                    </Show>
                                  </div>
                                  <Show when={expanded() === item.id}>
                                    <PaymentPanel
                                      item={item}
                                      payments={paymentsFor(item.id)}
                                      currency={currency()}
                                      canEdit={props.canEdit}
                                      onAdd={addPayment}
                                      onTogglePaid={togglePaid}
                                      onDelete={deletePayment}
                                    />
                                  </Show>
                                </li>
                              );
                            }}
                          </For>
                        </SortableProvider>
                      </ul>
                    </DragDropProvider>
                    <Show when={props.canEdit}>
                      <p {...reorder.hintProps()}>{reorder.hintText}</p>
                      <p {...reorder.liveRegionProps()}>{reorder.announcement()}</p>
                    </Show>
                  </section>
                </Show>
              );
            }}
          </For>
        </div>
      </Show>
    </div>
  );
}

/** One editable money figure. Read-only shows the formatted value or "—";
 *  editable renders a number input committing on change. */
function MoneyCell(props: {
  label: string;
  minor: number | null;
  currency: string;
  canEdit?: boolean;
  onCommit: (raw: string) => void;
}) {
  return (
    <label class="flex w-24 flex-col gap-0.5">
      <span class="text-gold-dim font-body text-ui-xs tracking-ui-widest uppercase">
        {props.label}
      </span>
      <Show
        when={props.canEdit}
        fallback={
          <span class="text-text text-ui-sm">
            {props.minor == null ? "—" : fmtMinor(props.minor, props.currency)}
          </span>
        }
      >
        <Input
          size="sm"
          type="number"
          min="0"
          step="0.01"
          value={props.minor == null ? "" : (props.minor / 100).toString()}
          onChange={(e) => props.onCommit(e.currentTarget.value)}
        />
      </Show>
    </label>
  );
}

/** The expandable payment schedule for one item. */
function PaymentPanel(props: {
  item: BudgetItemRow;
  payments: PaymentRow[];
  currency: string;
  canEdit?: boolean;
  onAdd: (item: BudgetItemRow, label: string, amount: string, dueAt: string) => void;
  onTogglePaid: (item: BudgetItemRow, payment: PaymentRow) => void;
  onDelete: (item: BudgetItemRow, payment: PaymentRow) => void;
}) {
  const [label, setLabel] = createSignal("");
  const [amount, setAmount] = createSignal("");
  const [due, setDue] = createSignal("");
  const submit = (e: Event) => {
    e.preventDefault();
    props.onAdd(props.item, label(), amount(), due());
    setLabel("");
    setAmount("");
    setDue("");
  };
  return (
    <div class="border-border/60 ml-2 flex flex-col gap-2 border-l pl-3">
      <For each={props.payments}>
        {(p) => (
          <div class="text-ui-sm flex flex-wrap items-center gap-2">
            <input
              type="checkbox"
              aria-label={`${p.label} paid`}
              checked={p.paidAt != null}
              disabled={!props.canEdit}
              onChange={() => props.canEdit && props.onTogglePaid(props.item, p)}
            />
            <span class="text-text flex-1">
              {p.label} · {fmtMinor(p.amountMinor, props.currency)}
              <Show when={p.dueAt}>
                <span class="text-text-muted"> · due {p.dueAt}</span>
              </Show>
              <Show when={p.paidAt != null}>
                <span class="text-gold-dim"> · paid</span>
              </Show>
            </span>
            <Show when={props.canEdit}>
              <Button
                variant="bareDanger"
                type="button"
                aria-label="Delete payment"
                onClick={() => props.onDelete(props.item, p)}
              >
                ✕
              </Button>
            </Show>
          </div>
        )}
      </For>
      <Show when={props.canEdit}>
        <form onSubmit={submit} class="flex flex-wrap items-end gap-2">
          <Field label="Payment label" labelHidden class="w-28">
            {(field) => (
              <Input
                {...field}
                size="sm"
                value={label()}
                onInput={(e) => setLabel(e.currentTarget.value)}
                placeholder="Deposit"
              />
            )}
          </Field>
          <Field label="Amount" labelHidden class="w-24">
            {(field) => (
              <Input
                {...field}
                size="sm"
                type="number"
                min="0"
                step="0.01"
                value={amount()}
                onInput={(e) => setAmount(e.currentTarget.value)}
                placeholder="Amount"
              />
            )}
          </Field>
          <Field label="Due date" labelHidden>
            {(field) => (
              <Input
                {...field}
                size="sm"
                type="date"
                value={due()}
                onInput={(e) => setDue(e.currentTarget.value)}
              />
            )}
          </Field>
          <Button type="submit" variant="outline" size="sm">
            Add payment
          </Button>
        </form>
      </Show>
    </div>
  );
}
