# cire Overview v2 — Richer Widgets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the cire organiser Overview into a richer home — a full-width "What's next" timeline merging events + payments + tasks, plus progress bars and a per-event RSVP breakdown on the existing cards.

**Architecture:** Frontend-only, entirely within `cire/organiser`. One new pure helper module (`overview-agenda.ts`) builds the merged timeline; `Overview.tsx` gains a timeline band + card visual upgrades; `tasks-store.ts` gains one selector. All data is already fetched by the Overview's existing `createResource` and the shared stores — no API, DB, migration, or new network call.

**Tech Stack:** SolidJS + Astro islands, TypeScript, Tailwind v4, Vitest + @solidjs/testing-library (happy-dom), oxlint/oxfmt.

## Global Constraints

- **No backend/API/DB/migration changes.** Every data source is already client-side.
- **Effect is never imported in `cire/organiser`** — plain Solid primitives + pure functions only.
- **`@cire/*` packages are version-less/ignored** — the changeset is EMPTY (frontmatter `---\n---` + body, NO package lines). Never add package lines.
- **Soft-fail model:** a missing/failed data source contributes an empty slice; the band and cards render from whatever is present, and never throw or blank the page.
- **Local-calendar dates:** events carry a full ISO `startAt`; tasks/payments carry `YYYY-MM-DD`. All comparisons are by local calendar date so the agenda never disagrees with the Countdown by a day across timezones.
- **Defaults (locked):** horizon = 90 days; show ≤ 6 upcoming items + ALL overdue; per-event RSVP list shows first 5 events then "+k more"; no synthetic wedding-day row.
- **Icons:** event = 📅, payment = 💰, task = ✓.
- **Tie-break order (determinism):** same date → `event` < `payment` < `task` → then label ascending.

---

### Task 1: `overview-agenda.ts` — pure merge/sort helper

**Files:**
- Create: `cire/organiser/src/lib/overview-agenda.ts`
- Test: `cire/organiser/src/lib/overview-agenda.test.ts`

**Interfaces:**
- Consumes: nothing (pure; `now` injected as ms-epoch).
- Produces:
  - `type AgendaKind = "event" | "payment" | "task"`
  - `interface AgendaItem { key: string; kind: AgendaKind; date: string; label: string; detail: string | null; sourceId: string; overdue: boolean }`
  - `interface AgendaInput { events: {id;name;startAt}[]; payments: {id;label;amountMinor;dueAt;paidAt}[]; tasks: {id;title;dueAt;status}[]; now: number; currency: string; horizonDays: number; limit: number }`
  - `function buildAgenda(input: AgendaInput): AgendaItem[]`
  - `function toLocalDateKey(value: string | number): string | null`

- [ ] **Step 1: Write the failing test**

Create `cire/organiser/src/lib/overview-agenda.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { buildAgenda, toLocalDateKey, type AgendaInput } from "./overview-agenda";

// A fixed "now": 2026-07-16 (local). All fixture dates are relative to this.
const NOW = new Date(2026, 6, 16, 9, 0, 0).getTime();

function input(over: Partial<AgendaInput>): AgendaInput {
  return {
    events: [],
    payments: [],
    tasks: [],
    now: NOW,
    currency: "AUD",
    horizonDays: 90,
    limit: 6,
    ...over,
  };
}

describe("toLocalDateKey", () => {
  it("normalises ISO datetime, YYYY-MM-DD, and ms-epoch to a local date key", () => {
    expect(toLocalDateKey("2026-08-03")).toBe("2026-08-03");
    // An ISO datetime at local midday stays on the same local day.
    expect(toLocalDateKey(new Date(2026, 7, 3, 12, 0, 0).toISOString())).toBe("2026-08-03");
    expect(toLocalDateKey(new Date(2026, 7, 3, 0, 0, 0).getTime())).toBe("2026-08-03");
  });

  it("returns null for garbage", () => {
    expect(toLocalDateKey("not-a-date")).toBeNull();
    expect(toLocalDateKey(Number.NaN)).toBeNull();
  });
});

describe("buildAgenda", () => {
  it("merges events, unpaid payments, and open tasks sorted ascending by date", () => {
    const a = buildAgenda(
      input({
        events: [{ id: "e1", name: "Rehearsal", startAt: new Date(2026, 7, 12, 18).toISOString() }],
        payments: [
          { id: "p1", label: "Venue balance", amountMinor: 800000, dueAt: "2026-08-03", paidAt: null },
        ],
        tasks: [{ id: "t1", title: "Confirm florist", dueAt: "2026-08-09", status: "open" }],
      }),
    );
    expect(a.map((i) => i.label)).toEqual(["Venue balance", "Confirm florist", "Rehearsal"]);
    expect(a.map((i) => i.kind)).toEqual(["payment", "task", "event"]);
    expect(a[0]!.detail).toBe(
      new Intl.NumberFormat(undefined, {
        style: "currency",
        currency: "AUD",
        maximumFractionDigits: 0,
      }).format(8000),
    );
    expect(a[0]!.key).toBe("payment:p1");
  });

  it("excludes past events, paid payments, done tasks, and undated payments/tasks", () => {
    const a = buildAgenda(
      input({
        events: [{ id: "e1", name: "Past party", startAt: new Date(2026, 5, 1).toISOString() }],
        payments: [
          { id: "p1", label: "Paid deposit", amountMinor: 1000, dueAt: "2026-08-01", paidAt: 123 },
          { id: "p2", label: "Undated", amountMinor: 1000, dueAt: null, paidAt: null },
        ],
        tasks: [
          { id: "t1", title: "Done task", dueAt: "2026-08-01", status: "done" },
          { id: "t2", title: "Undated task", dueAt: null, status: "open" },
        ],
      }),
    );
    expect(a).toEqual([]);
  });

  it("surfaces overdue payments/tasks first, oldest overdue at the top", () => {
    const a = buildAgenda(
      input({
        payments: [
          { id: "p1", label: "Overdue newer", amountMinor: 1, dueAt: "2026-07-10", paidAt: null },
          { id: "p2", label: "Overdue older", amountMinor: 1, dueAt: "2026-07-01", paidAt: null },
        ],
        tasks: [{ id: "t1", title: "Upcoming", dueAt: "2026-07-20", status: "open" }],
      }),
    );
    expect(a.map((i) => i.label)).toEqual(["Overdue older", "Overdue newer", "Upcoming"]);
    expect(a.map((i) => i.overdue)).toEqual([true, true, false]);
  });

  it("respects horizonDays (drops far-future upcoming) but keeps all overdue", () => {
    const a = buildAgenda(
      input({
        horizonDays: 30,
        payments: [
          { id: "p1", label: "Far future", amountMinor: 1, dueAt: "2026-12-01", paidAt: null },
          { id: "p2", label: "Overdue", amountMinor: 1, dueAt: "2026-06-01", paidAt: null },
        ],
      }),
    );
    expect(a.map((i) => i.label)).toEqual(["Overdue"]);
  });

  it("caps upcoming at limit but never caps overdue", () => {
    const a = buildAgenda(
      input({
        limit: 2,
        payments: [
          { id: "o1", label: "OD1", amountMinor: 1, dueAt: "2026-06-01", paidAt: null },
          { id: "o2", label: "OD2", amountMinor: 1, dueAt: "2026-06-02", paidAt: null },
          { id: "u1", label: "U1", amountMinor: 1, dueAt: "2026-07-20", paidAt: null },
          { id: "u2", label: "U2", amountMinor: 1, dueAt: "2026-07-21", paidAt: null },
          { id: "u3", label: "U3", amountMinor: 1, dueAt: "2026-07-22", paidAt: null },
        ],
      }),
    );
    // Both overdue kept + only 2 upcoming.
    expect(a.map((i) => i.label)).toEqual(["OD1", "OD2", "U1", "U2"]);
  });

  it("breaks same-date ties by kind (event<payment<task) then label", () => {
    const day = "2026-08-05";
    const a = buildAgenda(
      input({
        events: [{ id: "e1", name: "Zeta event", startAt: new Date(2026, 7, 5, 10).toISOString() }],
        payments: [{ id: "p1", label: "Alpha payment", amountMinor: 1, dueAt: day, paidAt: null }],
        tasks: [{ id: "t1", title: "Beta task", dueAt: day, status: "open" }],
      }),
    );
    expect(a.map((i) => i.kind)).toEqual(["event", "payment", "task"]);
  });

  it("returns [] for empty input", () => {
    expect(buildAgenda(input({}))).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run --cwd cire/organiser test:run overview-agenda`
Expected: FAIL — `Cannot find module './overview-agenda'`.

- [ ] **Step 3: Write minimal implementation**

Create `cire/organiser/src/lib/overview-agenda.ts`:

```ts
/**
 * Pure builder for the Overview "What's next" timeline: merges upcoming schedule
 * events, unpaid budget payments, and open checklist tasks into one
 * chronological agenda. No Solid primitives, no fetch — `now` is injected — so
 * every rule here is exhaustively unit-testable and never disagrees with the
 * Countdown card by a day across timezones.
 */

export type AgendaKind = "event" | "payment" | "task";

export interface AgendaItem {
  /** Stable key `${kind}:${sourceId}` for keyed rendering + navigation. */
  key: string;
  kind: AgendaKind;
  /** Local calendar date this item sits on, `YYYY-MM-DD`. */
  date: string;
  /** Primary label (event name / payment label / task title). */
  label: string;
  /** Trailing detail — formatted amount for payments, else null. */
  detail: string | null;
  /** Source row id (for navigation). */
  sourceId: string;
  /** Date strictly before today. Only payments/tasks can be overdue; past
   *  events are excluded entirely. */
  overdue: boolean;
}

export interface AgendaInput {
  events: { id: string; name: string; startAt: string }[];
  payments: { id: string; label: string; amountMinor: number; dueAt: string | null; paidAt: number | null }[];
  tasks: { id: string; title: string; dueAt: string | null; status: "open" | "done" }[];
  /** Injected clock, ms epoch. */
  now: number;
  /** Currency for formatting payment amounts. */
  currency: string;
  /** Upcoming items more than this many days ahead are dropped. */
  horizonDays: number;
  /** Max UPCOMING items to keep; overdue items are always kept. */
  limit: number;
}

const KIND_ORDER: Record<AgendaKind, number> = { event: 0, payment: 1, task: 2 };

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Normalise an ISO datetime, a `YYYY-MM-DD` string, or an ms-epoch number to a
 *  local `YYYY-MM-DD` key (or null if unparseable). A bare date string is read
 *  as local midnight (not UTC) so it lands on the organiser's calendar day. */
export function toLocalDateKey(value: string | number): string | null {
  let d: Date;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    d = new Date(value);
  } else {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    d = m
      ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
      : new Date(value);
  }
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const da = String(d.getDate()).padStart(2, "0");
  return `${y}-${mo}-${da}`;
}

function fmtAmount(minor: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      maximumFractionDigits: 0,
    }).format(minor / 100);
  } catch {
    return (minor / 100).toFixed(0);
  }
}

export function buildAgenda(input: AgendaInput): AgendaItem[] {
  const todayKey = toLocalDateKey(input.now)!;
  const horizonKey = toLocalDateKey(input.now + input.horizonDays * MS_PER_DAY)!;

  const items: AgendaItem[] = [];

  for (const e of input.events) {
    const date = toLocalDateKey(e.startAt);
    if (date == null || date < todayKey) continue; // past events happened — drop
    items.push({
      key: `event:${e.id}`,
      kind: "event",
      date,
      label: e.name,
      detail: null,
      sourceId: e.id,
      overdue: false,
    });
  }

  for (const p of input.payments) {
    if (p.paidAt != null || p.dueAt == null) continue;
    const date = toLocalDateKey(p.dueAt);
    if (date == null) continue;
    items.push({
      key: `payment:${p.id}`,
      kind: "payment",
      date,
      label: p.label,
      detail: fmtAmount(p.amountMinor, input.currency),
      sourceId: p.id,
      overdue: date < todayKey,
    });
  }

  for (const t of input.tasks) {
    if (t.status !== "open" || t.dueAt == null) continue;
    const date = toLocalDateKey(t.dueAt);
    if (date == null) continue;
    items.push({
      key: `task:${t.id}`,
      kind: "task",
      date,
      label: t.title,
      detail: null,
      sourceId: t.id,
      overdue: date < todayKey,
    });
  }

  const cmp = (a: AgendaItem, b: AgendaItem): number => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    if (KIND_ORDER[a.kind] !== KIND_ORDER[b.kind]) return KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
    return a.label < b.label ? -1 : a.label > b.label ? 1 : 0;
  };

  const overdue = items.filter((i) => i.overdue).toSorted(cmp);
  const upcoming = items
    .filter((i) => !i.overdue && i.date <= horizonKey)
    .toSorted(cmp)
    .slice(0, input.limit);

  return [...overdue, ...upcoming];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run --cwd cire/organiser test:run overview-agenda`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add cire/organiser/src/lib/overview-agenda.ts cire/organiser/src/lib/overview-agenda.test.ts
git commit -m "feat(cire/organiser): overview-agenda merge helper"
```

---

### Task 2: "What's next" timeline band in the Overview

**Files:**
- Modify: `cire/organiser/src/components/Overview.tsx`
- Test: `cire/organiser/src/components/Overview.agenda.test.tsx` (create)

**Interfaces:**
- Consumes: `buildAgenda`, `AgendaItem` from `../lib/overview-agenda`; `peekCachedBudget` from `../lib/budget-store`; `peekCachedTasks` from `../lib/tasks-store`; the existing `eventsAccessor`/resource `events`; existing `onNavigate`.
- Produces: a full-width band rendered above the stat grid (no exported symbols).

Context — the relevant region of `Overview.tsx` today: the render returns a `<div class="flex flex-col gap-8">` containing `<SectionIntro>`, a `<Show when={data.loading}>` skeleton grid, and a `<Show when={!data.loading}>` block whose `<Show when={!isFresh()}>` child is a single `<div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">…cards…</div>`. `budgetCurrency()` already exists. `props.onNavigate` accepts `("guests"|"schedule"|"checklist"|"budget"|"invite"|"settings", sub?)`.

- [ ] **Step 1: Write the failing test**

Create `cire/organiser/src/components/Overview.agenda.test.tsx`:

```tsx
// @vitest-environment happy-dom
import { fireEvent, render, screen } from "@solidjs/testing-library";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { __resetBudgetCache, setCachedBudget } from "../lib/budget-store";
import { setCachedEvents } from "../lib/events-store";
import { setCachedGuests } from "../lib/guests-store";
import { __resetTasksCache, setCachedTasks, type TaskRow } from "../lib/tasks-store";
import Overview from "./Overview";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const authFetch = vi.fn(async (url: string) => {
  if (url.endsWith("/settings"))
    return json({ wedding: { weddingDate: null, currency: "AUD", budgetTotalMinor: null } });
  if (url.endsWith("/rsvps")) return json({ events: [] });
  if (url.endsWith("/tasks")) return json({ tasks: [] });
  if (url.endsWith("/events")) return json([]);
  if (url.endsWith("/guests")) return json([]);
  if (url.endsWith("/budget"))
    return json({ items: [], payments: [], budgetTotalMinor: null, currency: "AUD" });
  return json({}, 404);
});
vi.mock("@osn/client/solid", () => ({ useAuth: () => ({ authFetch }) }));
vi.mock("../lib/api", () => ({
  apiUrl: (path: string) => `https://api.test${path}`,
  isAuthExpired: () => false,
  redirectToLogin: () => {},
}));
vi.mock("./GettingStarted", () => ({
  default: (p: { weddingId: string }) => <div data-testid="getting-started">{p.weddingId}</div>,
}));

const task = (over: Partial<TaskRow>): TaskRow => ({
  id: "t",
  weddingId: "wed_1",
  title: "T",
  notes: null,
  timeframeBucket: "6m",
  dueAt: null,
  status: "open",
  sortOrder: 0,
  createdAt: 1,
  completedAt: null,
  ...over,
});

// Dates relative to real now so the 90-day horizon always includes them.
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000);
const dateKey = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

beforeEach(() => {
  __resetBudgetCache();
  __resetTasksCache();
  authFetch.mockClear();
  // Non-fresh wedding: at least one event + household.
  setCachedGuests("wed_1", [{ familyId: "fam_a", firstName: "Al" } as never]);
});

describe("Overview what's-next band", () => {
  it("renders merged agenda rows and navigates on click", async () => {
    setCachedEvents("wed_1", [
      { id: "e1", name: "Ceremony rehearsal", startAt: inDays(12).toISOString() } as never,
    ]);
    setCachedTasks("wed_1", [task({ id: "t1", title: "Confirm florist", status: "open", dueAt: dateKey(inDays(9)) })]);
    setCachedBudget("wed_1", {
      items: [],
      payments: [
        { id: "p1", budgetItemId: "b1", label: "Venue balance", amountMinor: 800000, dueAt: dateKey(inDays(3)), paidAt: null, createdAt: 1 },
      ],
      budgetTotalMinor: null,
      currency: "AUD",
    });

    const onNavigate = vi.fn();
    render(() => <Overview weddingId="wed_1" onNavigate={onNavigate} />);

    // The three labels appear under the "What's next" heading.
    const payment = await screen.findByText("Venue balance");
    expect(screen.getByText("Confirm florist")).toBeInTheDocument();
    expect(screen.getByText("Ceremony rehearsal")).toBeInTheDocument();

    // Clicking the payment row jumps to the Budget module.
    fireEvent.click(payment.closest("button")!);
    expect(onNavigate).toHaveBeenCalledWith("budget");
  });

  it("shows the empty-state line when there is nothing scheduled", async () => {
    setCachedEvents("wed_1", [{ id: "e1", name: "Ceremony" } as never]); // no startAt/date → not on agenda
    render(() => <Overview weddingId="wed_1" onNavigate={() => {}} />);
    expect(await screen.findByText(/nothing scheduled yet/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run --cwd cire/organiser test:run Overview.agenda`
Expected: FAIL — the "What's next" band/text doesn't exist yet.

- [ ] **Step 3: Add the imports + agenda memo + band**

In `cire/organiser/src/components/Overview.tsx`:

3a. Extend the budget-store import to add `peekCachedTasks` from tasks-store and the agenda helper. Add these imports near the existing store imports:

```tsx
import { buildAgenda, type AgendaItem } from "../lib/overview-agenda";
```

and add `peekCachedTasks` to the existing `../lib/tasks-store` import list (which currently imports `ensureTasksLoaded, openTaskCount, type TaskRow`):

```tsx
import { ensureTasksLoaded, openTaskCount, peekCachedTasks, type TaskRow } from "../lib/tasks-store";
```

3b. Add two small module-scope helpers (place them beside `fmtBudget`, above the `Overview` component):

```tsx
const AGENDA_ICON: Record<AgendaItem["kind"], string> = {
  event: "📅",
  payment: "💰",
  task: "✓",
};

/** "Aug 3" style pill label from a `YYYY-MM-DD` key. */
function fmtAgendaDate(dateKey: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey);
  if (!m) return dateKey;
  return new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "short" }).format(
    new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])),
  );
}
```

3c. Inside the `Overview` component, after the `budgetCurrency` definition, add the agenda memo:

```tsx
  const agenda = createMemo(() =>
    buildAgenda({
      events: (data()?.events ?? []).map((e) => ({ id: e.id, name: e.name, startAt: e.startAt })),
      payments: peekCachedBudget(props.weddingId)?.payments ?? [],
      tasks: peekCachedTasks(props.weddingId) ?? [],
      now: Date.now(),
      currency: budgetCurrency(),
      horizonDays: 90,
      limit: 6,
    }),
  );
```

3d. Add a local band component just above the `return (` of `Overview` (it closes over `agenda` and `props.onNavigate`):

```tsx
  const WhatsNext = () => (
    <div class="border-border bg-surface/20 flex flex-col gap-3 rounded-sm border p-5">
      <p class="font-body text-gold text-[0.7rem] tracking-[0.18em] uppercase">What&rsquo;s next</p>
      <Show
        when={agenda().length > 0}
        fallback={
          <p class="font-body text-text-muted text-[0.85rem] leading-relaxed">
            Nothing scheduled yet — add events, payment due dates, or task deadlines.
          </p>
        }
      >
        <ul class="divide-border/40 flex flex-col divide-y">
          <For each={agenda()}>
            {(item) => (
              <li>
                <button
                  type="button"
                  onClick={() =>
                    props.onNavigate(
                      item.kind === "event"
                        ? "schedule"
                        : item.kind === "payment"
                          ? "budget"
                          : "checklist",
                    )
                  }
                  class="hover:bg-surface/40 flex w-full items-center gap-3 py-2 text-left transition-colors"
                >
                  <span class="font-mono text-text-muted w-14 shrink-0 text-[0.76rem] tabular-nums">
                    {fmtAgendaDate(item.date)}
                  </span>
                  <span aria-hidden="true" class="w-4 shrink-0 text-center text-[0.85rem]">
                    {AGENDA_ICON[item.kind]}
                  </span>
                  <span class="text-text grow truncate text-[0.88rem]">{item.label}</span>
                  <Show when={item.overdue}>
                    <span class="font-body shrink-0 text-[0.68rem] tracking-wide text-red-400 uppercase">
                      overdue
                    </span>
                  </Show>
                  <Show when={item.detail}>
                    <span class="text-text-muted shrink-0 font-mono text-[0.8rem] tabular-nums">
                      {item.detail}
                    </span>
                  </Show>
                </button>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </div>
  );
```

3e. Render the band above the grid. Change the `<Show when={!isFresh()}>` child from a single grid `<div>` to a fragment holding the band + grid. Find:

```tsx
        <Show when={!isFresh()}>
          <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
```

and wrap so it reads:

```tsx
        <Show when={!isFresh()}>
          <div class="flex flex-col gap-4">
            <WhatsNext />
            <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
```

Then close the extra wrapper `</div>` after the grid's closing `</div>` (before `</Show>`). The grid block currently ends:

```tsx
          </div>
        </Show>
      </Show>
    </div>
  );
```

becomes:

```tsx
            </div>
          </div>
        </Show>
      </Show>
    </div>
  );
```

3f. Add a full-width skeleton bar to the loading state. Find the loading Show:

```tsx
      <Show when={data.loading}>
        <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <For each={[1, 2, 3]}>
            {() => <div class="bg-surface h-[130px] animate-pulse rounded-sm" />}
          </For>
        </div>
      </Show>
```

and prepend a band skeleton inside a flex wrapper:

```tsx
      <Show when={data.loading}>
        <div class="flex flex-col gap-4">
          <div class="bg-surface h-[120px] animate-pulse rounded-sm" />
          <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <For each={[1, 2, 3]}>
              {() => <div class="bg-surface h-[130px] animate-pulse rounded-sm" />}
            </For>
          </div>
        </div>
      </Show>
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run --cwd cire/organiser test:run Overview.agenda`
Expected: PASS (both cases). Then run the full Overview suite to confirm no regression:
Run: `bun run --cwd cire/organiser test:run Overview`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cire/organiser/src/components/Overview.tsx cire/organiser/src/components/Overview.agenda.test.tsx
git commit -m "feat(cire/organiser): what's-next timeline band on Overview"
```

---

### Task 3: `taskCounts` selector + progress bars on Budget & Checklist cards

**Files:**
- Modify: `cire/organiser/src/lib/tasks-store.ts`
- Modify: `cire/organiser/src/lib/tasks-store.test.ts`
- Modify: `cire/organiser/src/components/Overview.tsx`
- Test: `cire/organiser/src/components/Overview.budget.test.tsx` (extend) + `cire/organiser/src/components/Overview.checklist.test.tsx` (extend)

**Interfaces:**
- Produces: `function taskCounts(weddingId: string): { open: number; done: number; total: number } | null` in tasks-store; a local `ProgressBar` component in Overview.tsx.
- Consumes (Overview): existing `spentSoFar`, `peekCachedBudget`, `data()?.profile?.budgetTotalMinor`, `budgetCurrency()`, new `taskCounts`.

- [ ] **Step 1: Write the failing store test**

Add to `cire/organiser/src/lib/tasks-store.test.ts` (inside the existing `describe("tasks-store", …)`), and add `taskCounts` to the import list at the top of the file:

```ts
  it("taskCounts returns open/done/total, null before load", async () => {
    expect(taskCounts("wed_none")).toBeNull();
    await ensureTasksLoaded("wed_1", async () => [
      row({ id: "a", status: "open" }),
      row({ id: "b", status: "done" }),
      row({ id: "c", status: "open" }),
    ]);
    expect(taskCounts("wed_1")).toEqual({ open: 2, done: 1, total: 3 });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run --cwd cire/organiser test:run tasks-store`
Expected: FAIL — `taskCounts is not a function` / not exported.

- [ ] **Step 3: Implement `taskCounts`**

In `cire/organiser/src/lib/tasks-store.ts`, add directly below `openTaskCount`:

```ts
/** Reactive open/done/total counts for the Overview completion bar: `null` until
 *  first load. Reads without allocating a dangling signal for a never-loaded
 *  weddingId (mirrors {@link openTaskCount}). */
export function taskCounts(
  weddingId: string,
): { open: number; done: number; total: number } | null {
  const rows = cache.get(weddingId)?.tasks() ?? null;
  if (rows == null) return null;
  let open = 0;
  let done = 0;
  for (const t of rows) {
    if (t.status === "open") open += 1;
    else if (t.status === "done") done += 1;
  }
  return { open, done, total: rows.length };
}
```

- [ ] **Step 4: Run the store test to verify it passes**

Run: `bun run --cwd cire/organiser test:run tasks-store`
Expected: PASS.

- [ ] **Step 5: Add the `ProgressBar` helper + wire both bars**

5a. In `Overview.tsx`, add `taskCounts` to the tasks-store import:

```tsx
import {
  ensureTasksLoaded,
  openTaskCount,
  peekCachedTasks,
  taskCounts,
  type TaskRow,
} from "../lib/tasks-store";
```

5b. Add a module-scope `ProgressBar` (beside the other helpers, above `Overview`):

```tsx
/** A thin meter used by the RSVP / Budget / Checklist cards. `over` renders in a
 *  warning tone and is used when a value exceeds its max (e.g. over-budget). */
function ProgressBar(props: { value: number; max: number; tone?: "gold" | "over" }) {
  const pct = () => (props.max <= 0 ? 0 : Math.min(100, Math.max(0, (props.value / props.max) * 100)));
  return (
    <div
      class="bg-surface/60 h-1.5 w-full overflow-hidden rounded-full"
      role="progressbar"
      aria-valuenow={Math.round(pct())}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div
        class={`h-full rounded-full ${props.tone === "over" ? "bg-red-500/80" : "bg-gold"}`}
        style={{ width: `${pct()}%` }}
      />
    </div>
  );
}
```

5c. **Budget card** — add the spend-vs-cap bar. In the Budget button, inside the inner `<Show>` whose `when` proves a cap exists (the branch that renders "of {cap}"), insert the bar directly below the `<p>` that shows spend-of-cap. Use the same cap resolution the surrounding code uses:

```tsx
                  {(() => {
                    const cap =
                      peekCachedBudget(props.weddingId)?.budgetTotalMinor ??
                      data()?.profile?.budgetTotalMinor;
                    const spent = spentSoFar(props.weddingId) ?? 0;
                    return (
                      <Show when={cap != null}>
                        <ProgressBar value={spent} max={cap!} tone={spent > cap! ? "over" : "gold"} />
                        <Show when={spent > cap!}>
                          <p class="text-[0.72rem] text-red-400">Over budget</p>
                        </Show>
                      </Show>
                    );
                  })()}
```

5d. **Checklist card** — add the completion bar. In the Checklist button, inside the branch that proves `(openTaskCount(...) ?? 0) > 0`, below the "N open tasks" `<p>`, add:

```tsx
                <Show when={taskCounts(props.weddingId)}>
                  {(tc) => (
                    <>
                      <p class="text-text-muted text-[0.76rem]">
                        {tc().done} of {tc().total} done
                      </p>
                      <ProgressBar value={tc().done} max={tc().total} />
                    </>
                  )}
                </Show>
```

- [ ] **Step 6: Write the failing card tests**

6a. Extend `cire/organiser/src/components/Overview.budget.test.tsx` with an over-budget assertion (mirror its existing seeding; seed a budget whose spend exceeds the cap):

```tsx
  it("shows the over-budget tone + note when spend exceeds the cap", async () => {
    setCachedBudget("wed_1", {
      items: [{ id: "b1", weddingId: "wed_1", category: "venue", name: "Venue", estimateMinor: null, quotedMinor: null, actualMinor: 5000000, notes: null, sortOrder: 0, createdAt: 1, updatedAt: 1 }],
      payments: [],
      budgetTotalMinor: 4000000,
      currency: "AUD",
    });
    render(() => <Overview weddingId="wed_1" onNavigate={() => {}} />);
    expect(await screen.findByText(/over budget/i)).toBeInTheDocument();
  });
```

(If `Overview.budget.test.tsx` does not already import `setCachedBudget`, add it to the `../lib/budget-store` import.)

6b. Extend `cire/organiser/src/components/Overview.checklist.test.tsx`:

```tsx
  it("shows the N-of-M completion line", async () => {
    setCachedTasks("wed_1", [
      row({ id: "a", status: "open" }),
      row({ id: "b", status: "done" }),
    ]);
    render(() => <Overview weddingId="wed_1" onNavigate={() => {}} />);
    expect(await screen.findByText(/1 of 2 done/i)).toBeInTheDocument();
  });
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `bun run --cwd cire/organiser test:run Overview.budget Overview.checklist tasks-store`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add cire/organiser/src/lib/tasks-store.ts cire/organiser/src/lib/tasks-store.test.ts cire/organiser/src/components/Overview.tsx cire/organiser/src/components/Overview.budget.test.tsx cire/organiser/src/components/Overview.checklist.test.tsx
git commit -m "feat(cire/organiser): spend + completion progress bars on Overview cards"
```

---

### Task 4: RSVP progress bar + per-event attending breakdown

**Files:**
- Modify: `cire/organiser/src/components/Overview.tsx`
- Test: `cire/organiser/src/components/Overview.test.tsx` (extend — the RSVP-focused suite)

**Interfaces:**
- Consumes: the existing `/rsvps` fetch response (`{ events: RsvpViewEvent[] }`, each carrying `{ id, name, invited, attending, declined, maybe, responded, noResponse }`).
- Produces: retains a per-event array on `OverviewData` and renders it. No new exports.

Context — today the resource reduces `body.events` into `RsvpTotals` and discards the array; the local `RsvpEventTally` interface omits `id`/`name`. This task keeps the totals AND retains a slim per-event array.

- [ ] **Step 1: Write the failing test**

Add to `cire/organiser/src/components/Overview.test.tsx` (mirror its existing harness; the `/rsvps` mock must return per-event objects with `id`/`name`). Add a case:

```tsx
  it("renders the RSVP progress bar and per-event attending breakdown", async () => {
    authFetch.mockImplementation(async (url: string) => {
      if (url.endsWith("/settings"))
        return json({ wedding: { weddingDate: null, currency: "AUD", budgetTotalMinor: null } });
      if (url.endsWith("/rsvps"))
        return json({
          events: [
            { id: "e1", name: "Ceremony", invited: 50, attending: 42, declined: 3, maybe: 1, responded: 46, noResponse: 4 },
            { id: "e2", name: "Reception", invited: 60, attending: 48, declined: 2, maybe: 0, responded: 50, noResponse: 10 },
          ],
        });
      if (url.endsWith("/tasks")) return json({ tasks: [] });
      if (url.endsWith("/events")) return json([]);
      if (url.endsWith("/guests")) return json([]);
      if (url.endsWith("/budget"))
        return json({ items: [], payments: [], budgetTotalMinor: null, currency: "AUD" });
      return json({}, 404);
    });
    setCachedGuests("wed_1", [{ familyId: "fam_a", firstName: "Al" } as never]);
    render(() => <Overview weddingId="wed_1" onNavigate={() => {}} />);

    // Per-event line for the Ceremony shows its attending count.
    const ceremony = await screen.findByText("Ceremony");
    expect(ceremony.closest("div,li,p")?.textContent).toMatch(/42/);
    expect(screen.getByText("Reception")).toBeInTheDocument();
    // The RSVP progress bar is present.
    expect(screen.getAllByRole("progressbar").length).toBeGreaterThan(0);
  });
```

(Ensure the test file imports `setCachedGuests` from `../lib/guests-store` and resets caches in `beforeEach`; follow the file's existing conventions.)

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run --cwd cire/organiser test:run Overview.test`
Expected: FAIL — no per-event lines / no progressbar in the RSVP card.

- [ ] **Step 3: Retain the per-event array on the resource**

3a. Extend the local `RsvpEventTally` interface to include `id` + `name`:

```tsx
interface RsvpEventTally {
  id: string;
  name: string;
  invited: number;
  attending: number;
  declined: number;
  maybe: number;
  responded: number;
  noResponse: number;
}
```

3b. Add a slim breakdown type + field on `OverviewData`:

```tsx
interface RsvpEventBreakdown {
  id: string;
  name: string;
  attending: number;
}
```

and add `rsvpEvents: RsvpEventBreakdown[];` to the `OverviewData` interface.

3c. In the resource, where `body.events` is reduced, also map the array. After computing `rsvps` (the totals), build the breakdown:

```tsx
      let rsvps: RsvpTotals | null = null;
      let rsvpEvents: RsvpEventBreakdown[] = [];
      if (rsvpsRes.ok) {
        const body = (await rsvpsRes.json()) as { events: RsvpEventTally[] };
        rsvpEvents = body.events.map((e) => ({ id: e.id, name: e.name, attending: e.attending }));
        rsvps = body.events.reduce<RsvpTotals>(
          // …unchanged reducer…
        );
      }
```

and add `rsvpEvents` to BOTH `return` objects (the success return and the catch's soft-fail return, where it is `[]`):

```tsx
      return { profile, rsvps, rsvpEvents, events: eventsAccessor(props.weddingId)() ?? [], guests: guestsAccessor(props.weddingId)() ?? [] };
```

```tsx
      return { profile: null, rsvps: null, rsvpEvents: [], events: [], guests: [] };
```

- [ ] **Step 4: Render the bar + breakdown in the RSVP card**

Inside the RSVP card's populated branch (the IIFE that renders when `data()?.rsvps && eventCount > 0`), directly under the "attending across N events" headline block, add the progress bar; and after the existing `<dl>` tally grid, add the per-event breakdown (capped at 5):

```tsx
                      <ProgressBar value={r.responded} max={r.invited} />
```

(place immediately after the `<div class="flex items-baseline gap-2">…</div>` headline)

and the breakdown, after the `<dl>`:

```tsx
                      <Show when={data()!.rsvpEvents.length > 0}>
                        <ul class="font-body text-text-muted flex flex-col gap-0.5 text-[0.78rem]">
                          <For each={data()!.rsvpEvents.slice(0, 5)}>
                            {(e) => (
                              <li class="flex justify-between gap-2">
                                <span class="truncate">{e.name}</span>
                                <span class="text-text font-mono tabular-nums">{e.attending} attending</span>
                              </li>
                            )}
                          </For>
                          <Show when={data()!.rsvpEvents.length > 5}>
                            <li class="text-text-muted/70">+{data()!.rsvpEvents.length - 5} more</li>
                          </Show>
                        </ul>
                      </Show>
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun run --cwd cire/organiser test:run Overview`
Expected: PASS (the new RSVP case + all existing Overview suites).

- [ ] **Step 6: Commit**

```bash
git add cire/organiser/src/components/Overview.tsx cire/organiser/src/components/Overview.test.tsx
git commit -m "feat(cire/organiser): RSVP progress bar + per-event attending breakdown"
```

---

### Task 5: Docs — wiki system page, TODO tick, changeset

**Files:**
- Create: `cire/wiki/systems/overview.md`
- Modify: `cire/wiki/todo/platform.md`
- Create: `.changeset/cire-overview-widgets.md`

- [ ] **Step 1: Write the wiki system page**

Create `cire/wiki/systems/overview.md`:

```markdown
---
title: Organiser Overview
tags: [systems, cire, organiser]
related: [checklist-tasks, budget]
last-reviewed: 2026-07-16
---

# Organiser Overview

The Overview (`cire/organiser/src/components/Overview.tsx`) is the module shell's
landing view: "how's the wedding tracking?" at a glance. For a brand-new wedding
(no events, no households) it shows `GettingStarted` instead.

## Widgets

- **What's next** (full-width band) — one chronological agenda merging upcoming
  schedule events, unpaid budget payments with a due date, and open checklist
  tasks with a due date. Built by the pure `lib/overview-agenda.ts`
  (`buildAgenda`). Overdue payments/tasks surface at the top; past events are
  excluded. Horizon 90 days, ≤ 6 upcoming items + all overdue. Each row links to
  its module (event → Schedule, payment → Budget, task → Checklist).
- **Countdown** — days to the wedding date.
- **RSVPs** — rolled-up totals + a responded/invited progress bar + a per-event
  attending breakdown (first 5 events). Data from `/rsvps` (already per-event).
- **Guests & schedule** — household + event counts, guest estimate.
- **Checklist** — open-task count + an N-of-M completion bar (`taskCounts`).
- **Budget** — spend vs cap with a bar (red when over) + the next payment.

## Data

No dedicated Overview endpoint. Everything is read from the shared weddingId-keyed
stores (events, guests, tasks, budget) plus light `/settings` + `/rsvps` reads,
all fired in parallel by one `createResource`. Any source that fails to load
simply contributes nothing to its widget (soft-fail) — the page never blanks.

## Agenda merge rules (`overview-agenda.ts`)

Pure + unit-tested. `now` is injected. All dates normalised to a local
`YYYY-MM-DD` key via `toLocalDateKey` (accepts ISO datetime / date string /
ms-epoch) so the agenda never disagrees with the Countdown across timezones.
Excludes: past events, paid payments, done tasks, undated payments/tasks.
Deterministic tie-break: same date → event < payment < task → label.
```

- [ ] **Step 2: Tick the TODO**

In `cire/wiki/todo/platform.md`, find the Overview-widgets line under Phase 1 and mark it shipped. If the line reads something like `- [ ] Richer Overview widgets`, change it to:

```markdown
- [x] Richer Overview widgets (SHIPPED 2026-07-16) — what's-next timeline (events+payments+tasks), RSVP/budget/checklist progress bars, per-event RSVP breakdown; pure `overview-agenda.ts`. See [[systems/overview]].
```

(If no such line exists, add it under the Phase 1 section.)

- [ ] **Step 3: Write the EMPTY changeset**

Create `.changeset/cire-overview-widgets.md` — because `@cire/*` are version-less/ignored, the changeset has NO package lines:

```markdown
---
---

cire organiser: richer Overview — a "What's next" timeline merging events,
payments, and tasks; RSVP/budget/checklist progress bars; and a per-event
attending breakdown. Frontend-only (`cire/organiser`), no API/DB changes.
```

- [ ] **Step 4: Validate the changeset**

Run: `bash scripts/validate-changesets.sh`
Expected: passes (no mixing of ignored + versioned packages).

- [ ] **Step 5: Commit**

```bash
git add cire/wiki/systems/overview.md cire/wiki/todo/platform.md .changeset/cire-overview-widgets.md
git commit -m "docs(cire): Overview v2 system page + changeset"
```

---

## Final Verification (after all tasks)

- [ ] `bun run --cwd cire/organiser test:run` — all organiser tests green.
- [ ] `bun run --cwd cire/organiser check` (or repo `bun run check`) — type-check clean.
- [ ] `bun run lint` — no new errors (warnings acceptable per repo baseline).
- [ ] `bash scripts/validate-changesets.sh` — passes.
- [ ] Whole-branch review (superpowers:requesting-code-review) on the most capable model.
- [ ] superpowers:finishing-a-development-branch → push + open PR to main (normal merge — no prod migration, no migration authorization needed).
