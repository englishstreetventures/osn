import { useAuth } from "@shared/rp-auth/solid";
import { createMemo, createSignal, For, onMount, Show } from "solid-js";

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
import { categoryLabel, SERVICE_CATEGORIES, type ServiceCategory } from "../lib/service-categories";
import Button from "./ui/Button";
import Field, { Input, Select } from "./ui/Field";
import Notice from "./ui/Notice";

interface BudgetViewProps {
  weddingId: string;
  /** Owner/editor may add/edit items + payments and reorder. */
  canEdit?: boolean;
  /** Owner-only: edit the overall budget cap. */
  canManage?: boolean;
}

/** Format minor units as major with the wedding currency, e.g. 1250000 → "$12,500.00".
 *  Uses Intl with the ISO currency; falls back to a plain number if unknown. */
function fmtMinor(minor: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(minor / 100);
  } catch {
    return (minor / 100).toFixed(2);
  }
}

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
      setCachedBudget(props.weddingId, await load());
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

  // Items grouped by category — only categories that have items, in enum order.
  const grouped = createMemo(() => {
    const items = snapshot()?.items ?? [];
    return SERVICE_CATEGORIES.map((c) => ({
      category: c,
      items: items.filter((it) => it.category === c.key).sort((a, b) => a.sortOrder - b.sortOrder),
    })).filter((g) => g.items.length > 0);
  });

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

  const move = async (category: ServiceCategory, index: number, delta: -1 | 1) => {
    const items = (peekCachedBudget(props.weddingId)?.items ?? [])
      .filter((it) => it.category === category)
      .sort((a, b) => a.sortOrder - b.sortOrder);
    const target = index + delta;
    if (target < 0 || target >= items.length) return;
    const reordered = [...items];
    const [moved] = reordered.splice(index, 1);
    reordered.splice(target, 0, moved!);
    const orderedIds = reordered.map((it) => it.id);
    const bySort = new Map(orderedIds.map((id, i) => [id, i]));
    patchSnap((s) => ({
      ...s,
      items: s.items.map((it) =>
        it.category === category ? { ...it, sortOrder: bySort.get(it.id) ?? it.sortOrder } : it,
      ),
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
        <Notice tone="error" alert>
          {error()}
        </Notice>
      </Show>

      {/* Summary — spent vs cap, owner cap editor. */}
      <div class="border-border bg-surface/20 flex flex-wrap items-center justify-between gap-4 rounded-sm border p-4">
        <div class="flex flex-col gap-1">
          <span class="text-gold-dim font-body text-[0.68rem] tracking-[0.16em] uppercase">
            Spent so far
          </span>
          <span class="text-text text-[1.2rem] font-semibold">
            {fmtMinor(spent(), currency())}
            <Show when={snapshot()?.budgetTotalMinor != null}>
              <span class="text-text-muted text-[0.9rem] font-normal">
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
            <span class="text-error text-[0.75rem]">Over budget</span>
          </Show>
        </div>
        <Show when={props.canManage}>
          <Show
            when={capDraft() !== null}
            fallback={
              <button
                type="button"
                onClick={() =>
                  setCapDraft(
                    snapshot()?.budgetTotalMinor == null
                      ? ""
                      : (snapshot()!.budgetTotalMinor! / 100).toString(),
                  )
                }
                class="text-gold-dim hover:text-gold text-[0.78rem] underline-offset-4 hover:underline"
              >
                {snapshot()?.budgetTotalMinor == null ? "Set a budget →" : "Edit budget"}
              </button>
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
          <Field label="Item" class="min-w-[12rem] flex-1">
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
        when={grouped().length > 0}
        fallback={<p class="text-text-muted text-[0.85rem] italic">No budget items yet.</p>}
      >
        {/* Categories pair up on a wide panel. The minimum is generous (32rem)
            because a budget row carries a name plus three money cells and the
            payments toggle — below that it wraps and stops being a table-like
            row, so the grid keeps one column until two really fit. */}
        <div class="auto-grid items-start [--auto-grid-gap:1.5rem] [--auto-grid-min:32rem]">
          <For each={grouped()}>
            {(group) => {
              const subtotalEst = () =>
                group.items.reduce((s, it) => s + (it.estimateMinor ?? 0), 0);
              const subtotalActual = () => group.items.reduce((s, it) => s + itemSpend(it), 0);
              return (
                <section class="flex flex-col gap-2">
                  <div class="flex items-baseline justify-between">
                    <h3 class="text-gold-dim font-body text-[0.7rem] tracking-[0.18em] uppercase">
                      {categoryLabel(group.category.key)}
                    </h3>
                    <span class="text-text-muted text-[0.75rem]">
                      est {fmtMinor(subtotalEst(), currency())} · spent{" "}
                      {fmtMinor(subtotalActual(), currency())}
                    </span>
                  </div>
                  <ul class="flex flex-col gap-1">
                    <For each={group.items}>
                      {(item, i) => (
                        <li class="border-border bg-surface/10 flex flex-col gap-2 rounded-sm border px-3 py-2">
                          <div class="flex flex-wrap items-center gap-3">
                            <span class="text-text min-w-[8rem] flex-1 text-[0.9rem]">
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
                            <button
                              type="button"
                              onClick={() => setExpanded(expanded() === item.id ? null : item.id)}
                              class="text-text-muted hover:text-text px-1 text-[0.78rem]"
                            >
                              payments ({paymentsFor(item.id).length})
                            </button>
                            <Show when={props.canEdit}>
                              <div class="flex items-center gap-1">
                                <button
                                  type="button"
                                  aria-label="Move up"
                                  disabled={i() === 0}
                                  onClick={() => move(group.category.key, i(), -1)}
                                  class="text-text-muted hover:text-text px-1 disabled:opacity-30"
                                >
                                  ↑
                                </button>
                                <button
                                  type="button"
                                  aria-label="Move down"
                                  disabled={i() === group.items.length - 1}
                                  onClick={() => move(group.category.key, i(), 1)}
                                  class="text-text-muted hover:text-text px-1 disabled:opacity-30"
                                >
                                  ↓
                                </button>
                                <button
                                  type="button"
                                  aria-label="Delete item"
                                  onClick={() => deleteItem(item)}
                                  class="text-text-muted hover:text-error px-1"
                                >
                                  ✕
                                </button>
                              </div>
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
                      )}
                    </For>
                  </ul>
                </section>
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
      <span class="text-gold-dim font-body text-[0.58rem] tracking-[0.14em] uppercase">
        {props.label}
      </span>
      <Show
        when={props.canEdit}
        fallback={
          <span class="text-text text-[0.85rem]">
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
          <div class="flex flex-wrap items-center gap-2 text-[0.82rem]">
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
              <button
                type="button"
                aria-label="Delete payment"
                onClick={() => props.onDelete(props.item, p)}
                class="text-text-muted hover:text-error px-1"
              >
                ✕
              </button>
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
