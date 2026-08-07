import { Popover } from "@kobalte/core/popover";
import { createEffect, createSignal, For, Show } from "solid-js";

/**
 * A themed calendar date picker built on the Kobalte `Popover` primitive —
 * Kobalte 0.13 ships NO DatePicker, so this is a small self-contained month grid
 * rather than a new dependency. It mirrors `ColorPicker.tsx`'s shape (a trigger
 * button showing the current value + a popover panel holding the picker) and
 * reuses the portal's gold/bordered aesthetic (the same tokens SettingsPanel's
 * `inputClass` uses).
 *
 * Contract: the date round-trips as a `YYYY-MM-DD` string (or `null` when unset),
 * exactly what SettingsPanel + the settings API already speak — no change to
 * `buildBody()` / the PUT payload. `onChange` emits `YYYY-MM-DD` on a pick or
 * `null` when the organiser clears it.
 *
 * Accessibility: the grid is a `role="grid"` of `role="gridcell"` day buttons
 * with a `role="columnheader"` weekday row; arrow keys move day-by-day (a full
 * roving-focus month, wrapping across weeks + months), Enter/Space selects, Esc
 * closes (Kobalte's Popover handles Esc + focus return to the trigger). Focus
 * lands on the selected (or today's) day when the panel opens.
 *
 * Read-only mode (co-hosts, per SettingsPanel's owner-only gate): no popover —
 * just the formatted date (or an em-dash placeholder), so the same call-site can
 * render both without branching.
 */

const WEEKDAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"] as const;

/** Parse a `YYYY-MM-DD` string into a LOCAL calendar date, or null if malformed.
 *  Local (not UTC) so the grid + selection match the organiser's own calendar,
 *  the same choice Overview's countdown makes. */
function parseIso(value: string | null): Date | null {
  if (!value) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return null;
  const [, y, mo, d] = m;
  const date = new Date(Number(y), Number(mo) - 1, Number(d));
  return Number.isNaN(date.getTime()) ? null : date;
}

/** A local Date → `YYYY-MM-DD` (no timezone shift — `toISOString` would). */
function toIso(date: Date): string {
  const y = String(date.getFullYear()).padStart(4, "0");
  const mo = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${mo}-${d}`;
}

/** Human-readable long form for the trigger + read-only view. */
function formatLong(date: Date): string {
  return new Intl.DateTimeFormat("en-AU", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(date);
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/** The Sunday-anchored grid of dates covering the month `cursor` sits in — a
 *  leading run of trailing-previous-month days, the month itself, then enough
 *  next-month days to fill the final week (a 6×7 = 42-cell grid, so the panel
 *  height never jumps between months). */
function monthGrid(cursor: Date): Date[] {
  const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
  const start = new Date(first);
  start.setDate(first.getDate() - first.getDay());
  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    return d;
  });
}

export default function DatePicker(props: {
  label: string;
  value: string | null;
  onChange: (v: string | null) => void;
  /** Co-hosts see the date read-only (SettingsPanel's owner-only gate). */
  readOnly?: boolean;
  /** Disable the trigger while a save is in flight (mirrors SettingsPanel). */
  disabled?: boolean;
}) {
  const selected = () => parseIso(props.value);

  // The month the grid is showing. Seeded from the value (or today), and
  // re-seeded when the popover opens so a cleared/changed value lands the grid on
  // the right month. `focusedIso` drives roving focus within the open grid.
  const [cursor, setCursor] = createSignal(selected() ?? startOfDay(new Date()));
  const [open, setOpen] = createSignal(false);
  const [focusedIso, setFocusedIso] = createSignal<string | null>(null);
  let gridRef: HTMLDivElement | undefined;

  // When the panel opens, land the cursor + roving focus on the selected day
  // (or today), then move DOM focus onto that cell so arrow keys work at once.
  createEffect(() => {
    if (!open()) return;
    const anchor = selected() ?? startOfDay(new Date());
    setCursor(anchor);
    setFocusedIso(toIso(anchor));
    queueMicrotask(() => {
      const cell = gridRef?.querySelector<HTMLButtonElement>('[data-focused="true"]');
      cell?.focus();
    });
  });

  const monthLabel = () =>
    new Intl.DateTimeFormat("en-AU", { month: "long", year: "numeric" }).format(cursor());

  const shiftMonth = (delta: number) => {
    const next = new Date(cursor().getFullYear(), cursor().getMonth() + delta, 1);
    setCursor(next);
  };

  const commit = (date: Date) => {
    props.onChange(toIso(date));
    setOpen(false);
  };

  /** Move roving focus by `deltaDays`, following into the next/previous month if
   *  the target day falls outside the visible one. */
  const moveFocus = (deltaDays: number) => {
    const base = parseIso(focusedIso()) ?? cursor();
    const next = new Date(base);
    next.setDate(base.getDate() + deltaDays);
    if (next.getMonth() !== cursor().getMonth() || next.getFullYear() !== cursor().getFullYear()) {
      setCursor(new Date(next.getFullYear(), next.getMonth(), 1));
    }
    setFocusedIso(toIso(next));
    queueMicrotask(() => {
      gridRef?.querySelector<HTMLButtonElement>('[data-focused="true"]')?.focus();
    });
  };

  const onGridKeyDown = (e: KeyboardEvent) => {
    switch (e.key) {
      case "ArrowLeft":
        e.preventDefault();
        moveFocus(-1);
        break;
      case "ArrowRight":
        e.preventDefault();
        moveFocus(1);
        break;
      case "ArrowUp":
        e.preventDefault();
        moveFocus(-7);
        break;
      case "ArrowDown":
        e.preventDefault();
        moveFocus(7);
        break;
      case "Home":
        e.preventDefault();
        moveFocus(-(parseIso(focusedIso()) ?? cursor()).getDay());
        break;
      case "End":
        e.preventDefault();
        moveFocus(6 - (parseIso(focusedIso()) ?? cursor()).getDay());
        break;
      case "PageUp":
        e.preventDefault();
        shiftMonth(-1);
        break;
      case "PageDown":
        e.preventDefault();
        shiftMonth(1);
        break;
      case "Enter":
      case " ": {
        e.preventDefault();
        const focused = parseIso(focusedIso());
        if (focused) commit(focused);
        break;
      }
    }
  };

  // ── Read-only: co-hosts just see the formatted date, no popover. ──────────
  if (props.readOnly) {
    return (
      <div class="flex flex-col gap-1.5">
        <span class="font-body text-text-muted text-[0.72rem] tracking-[0.1em] uppercase">
          {props.label}
        </span>
        <p class="font-body text-text border-border bg-bg/50 rounded-sm border px-3 py-2 text-[0.95rem] opacity-70">
          <Show when={selected()} fallback={<span class="opacity-60">No date set</span>}>
            {(d) => formatLong(d())}
          </Show>
        </p>
      </div>
    );
  }

  return (
    <div class="flex flex-col gap-1.5">
      <span class="font-body text-text-muted text-[0.72rem] tracking-[0.1em] uppercase">
        {props.label}
      </span>
      <Popover open={open()} onOpenChange={setOpen} gutter={8} placement="bottom-start">
        <Popover.Trigger
          aria-label={`${props.label}${selected() ? `: ${formatLong(selected()!)}` : ", no date set"}`}
          disabled={props.disabled}
          class="border-border bg-bg font-body text-text hover:border-gold focus-visible:border-gold focus-visible:ring-gold/40 flex items-center justify-between gap-2 rounded-sm border px-3 py-2 text-left text-[0.95rem] transition-colors outline-none focus-visible:ring-2 disabled:opacity-40"
        >
          <Show
            when={selected()}
            fallback={<span class="text-text-muted italic opacity-60">Pick a date…</span>}
          >
            {(d) => <span>{formatLong(d())}</span>}
          </Show>
          <svg
            class="text-gold-dim h-4 w-4 shrink-0"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.6"
            aria-hidden="true"
          >
            <rect x="3" y="4.5" width="18" height="16" rx="2" />
            <path d="M3 9h18M8 2.5v4M16 2.5v4" stroke-linecap="round" />
          </svg>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content class="border-border bg-surface-raised z-50 flex w-64 flex-col gap-3 rounded-sm border p-3 shadow-lg outline-none">
            {/* ── Month header: prev / label / next ─────────────────────── */}
            <div class="flex items-center justify-between gap-2">
              <button
                type="button"
                aria-label="Previous month"
                onClick={() => shiftMonth(-1)}
                class="border-border text-text-muted hover:border-gold hover:text-gold flex h-7 w-7 items-center justify-center rounded-sm border transition-colors"
              >
                <svg
                  class="h-4 w-4"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.8"
                  aria-hidden="true"
                >
                  <path d="M15 6l-6 6 6 6" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
              </button>
              <span class="font-body text-text text-[0.85rem] tracking-[0.04em]">
                {monthLabel()}
              </span>
              <button
                type="button"
                aria-label="Next month"
                onClick={() => shiftMonth(1)}
                class="border-border text-text-muted hover:border-gold hover:text-gold flex h-7 w-7 items-center justify-center rounded-sm border transition-colors"
              >
                <svg
                  class="h-4 w-4"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.8"
                  aria-hidden="true"
                >
                  <path d="M9 6l6 6-6 6" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
              </button>
            </div>

            {/* ── Weekday header row ────────────────────────────────────── */}
            <div
              role="grid"
              tabindex={-1}
              aria-label={monthLabel()}
              class="flex flex-col gap-1 outline-none"
              ref={gridRef}
              onKeyDown={onGridKeyDown}
            >
              <div role="row" class="grid grid-cols-7 gap-1">
                <For each={WEEKDAYS}>
                  {(wd) => (
                    <span
                      role="columnheader"
                      class="font-body text-text-muted flex h-6 items-center justify-center text-[0.62rem] tracking-[0.08em] uppercase"
                    >
                      {wd}
                    </span>
                  )}
                </For>
              </div>

              {/* ── Day cells (6 weeks × 7) ─────────────────────────────── */}
              <For each={Array.from({ length: 6 }, (_, w) => w)}>
                {(week) => (
                  <div role="row" class="grid grid-cols-7 gap-1">
                    <For each={monthGrid(cursor()).slice(week * 7, week * 7 + 7)}>
                      {(day) => {
                        const iso = toIso(day);
                        const inMonth = () => day.getMonth() === cursor().getMonth();
                        const isSelected = () => {
                          const s = selected();
                          return s ? sameDay(s, day) : false;
                        };
                        const isToday = () => sameDay(startOfDay(new Date()), day);
                        const isFocused = () => focusedIso() === iso;
                        return (
                          <button
                            type="button"
                            role="gridcell"
                            data-focused={isFocused() ? "true" : undefined}
                            aria-label={formatLong(day)}
                            aria-selected={isSelected()}
                            aria-current={isToday() ? "date" : undefined}
                            tabindex={isFocused() ? 0 : -1}
                            onClick={() => commit(day)}
                            classList={{
                              "flex h-8 w-8 items-center justify-center rounded-sm text-[0.8rem] tabular-nums outline-none transition-colors focus-visible:ring-2 focus-visible:ring-gold/50": true,
                              "bg-gold text-bg font-medium": isSelected(),
                              "text-text hover:bg-gold/15": !isSelected() && inMonth(),
                              "text-text-muted opacity-40 hover:opacity-70":
                                !isSelected() && !inMonth(),
                              "ring-1 ring-gold/40": isToday() && !isSelected(),
                            }}
                          >
                            {day.getDate()}
                          </button>
                        );
                      }}
                    </For>
                  </div>
                )}
              </For>
            </div>

            {/* ── Clear / today shortcuts ───────────────────────────────── */}
            <div class="flex items-center justify-between gap-2 pt-0.5">
              <button
                type="button"
                onClick={() => commit(startOfDay(new Date()))}
                class="font-body text-gold-dim hover:text-gold text-[0.72rem] underline-offset-4 transition-colors hover:underline"
              >
                Today
              </button>
              <Show when={selected()}>
                <button
                  type="button"
                  onClick={() => {
                    props.onChange(null);
                    setOpen(false);
                  }}
                  class="font-body text-text-muted hover:text-text text-[0.72rem] underline-offset-4 transition-colors hover:underline"
                >
                  Clear date
                </button>
              </Show>
            </div>
          </Popover.Content>
        </Popover.Portal>
      </Popover>
    </div>
  );
}
