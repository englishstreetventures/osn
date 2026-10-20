// Checklist tasks on the sample wedding. Consumed only by
// cire/db/seed/generate.ts.
//
// Same gap as budget.ts and registry.ts: the Checklist module shipped after this
// seed was written, so a dev tier rendered eight empty lead-time buckets. The
// list is bucket-ordered and drag-reorderable within a bucket, and neither of
// those has anything to exercise it at zero rows.
//
// `timeframeBucket` is a key from cire/api/src/lib/checklist-buckets.ts — the
// closed set the tasks HTTP schema validates against. Buckets run furthest-out
// first (12m → day_of); `sortOrder` orders WITHIN a bucket and starts at 0 for
// each one, which is what the reorder endpoint rewrites.

export type SeedTask = {
  readonly id: string;
  readonly title: string;
  readonly notes: string | null;
  readonly timeframeBucket: "12m" | "9m" | "6m" | "3m" | "1m" | "2w" | "week_of" | "day_of";
  /** Optional ISO date (YYYY-MM-DD), independent of the bucket. */
  readonly dueAt: string | null;
  readonly status: "open" | "done";
  readonly sortOrder: number;
  /** Days before seed time it was ticked off; null while open. */
  readonly completedDaysAgo: number | null;
};

const task = (n: number): string => `tsk_f7d3b1e0-0000-4000-8000-${String(n).padStart(12, "0")}`;

export const tasks = [
  // 12+ months out — the early, mostly-done end of the list.
  {
    id: task(1),
    title: "Set the date and the guest-count ceiling",
    notes: null,
    timeframeBucket: "12m",
    dueAt: null,
    status: "done",
    sortOrder: 0,
    completedDaysAgo: 240,
  },
  {
    id: task(2),
    title: "Book the reception venue",
    notes: "Deposit paid — see the Venue line in Budget.",
    timeframeBucket: "12m",
    dueAt: null,
    status: "done",
    sortOrder: 1,
    completedDaysAgo: 210,
  },
  {
    id: task(3),
    title: "Book the celebrant",
    notes: null,
    timeframeBucket: "12m",
    dueAt: null,
    status: "done",
    sortOrder: 2,
    completedDaysAgo: 200,
  },
  // 9 months out
  {
    id: task(4),
    title: "Book the photographer",
    notes: null,
    timeframeBucket: "9m",
    dueAt: null,
    status: "done",
    sortOrder: 0,
    completedDaysAgo: 150,
  },
  {
    id: task(5),
    title: "Choose a videographer",
    notes: "Two quotes still outstanding.",
    timeframeBucket: "9m",
    dueAt: null,
    status: "open",
    sortOrder: 1,
    completedDaysAgo: null,
  },
  // 6 months out
  {
    id: task(6),
    title: "Send the invitations",
    notes: null,
    timeframeBucket: "6m",
    dueAt: "2026-08-30",
    status: "open",
    sortOrder: 0,
    completedDaysAgo: null,
  },
  {
    id: task(7),
    title: "Book hair and makeup trials",
    notes: null,
    timeframeBucket: "6m",
    dueAt: null,
    status: "done",
    sortOrder: 1,
    completedDaysAgo: 20,
  },
  {
    id: task(8),
    title: "Open the gift registry",
    notes: null,
    timeframeBucket: "6m",
    dueAt: null,
    status: "done",
    sortOrder: 2,
    completedDaysAgo: 28,
  },
  // 3 months out
  {
    id: task(9),
    title: "Confirm the catering menu",
    notes: "Final head count goes with the balance payment.",
    timeframeBucket: "3m",
    dueAt: "2026-09-15",
    status: "open",
    sortOrder: 0,
    completedDaysAgo: null,
  },
  {
    id: task(10),
    title: "Order the cake",
    notes: null,
    timeframeBucket: "3m",
    dueAt: null,
    status: "open",
    sortOrder: 1,
    completedDaysAgo: null,
  },
  // 1 month out
  {
    id: task(11),
    title: "Chase the households who haven't replied",
    notes: null,
    timeframeBucket: "1m",
    dueAt: "2026-10-25",
    status: "open",
    sortOrder: 0,
    completedDaysAgo: null,
  },
  {
    id: task(12),
    title: "Book the guest coaches",
    notes: null,
    timeframeBucket: "1m",
    dueAt: null,
    status: "open",
    sortOrder: 1,
    completedDaysAgo: null,
  },
  // 2 weeks out
  {
    id: task(13),
    title: "Send the run sheet to every supplier",
    notes: null,
    timeframeBucket: "2w",
    dueAt: "2026-11-11",
    status: "open",
    sortOrder: 0,
    completedDaysAgo: null,
  },
  {
    id: task(14),
    title: "Pay the outstanding balances",
    notes: "Venue, catering and the celebrant — all in Budget.",
    timeframeBucket: "2w",
    dueAt: "2026-11-10",
    status: "open",
    sortOrder: 1,
    completedDaysAgo: null,
  },
  // Week of
  {
    id: task(15),
    title: "Final head count to the caterer",
    notes: null,
    timeframeBucket: "week_of",
    dueAt: "2026-11-20",
    status: "open",
    sortOrder: 0,
    completedDaysAgo: null,
  },
  {
    id: task(16),
    title: "Print the seating chart and the signage",
    notes: null,
    timeframeBucket: "week_of",
    dueAt: null,
    status: "open",
    sortOrder: 1,
    completedDaysAgo: null,
  },
  // Day of
  {
    id: task(17),
    title: "Hand the rings to the best man",
    notes: null,
    timeframeBucket: "day_of",
    dueAt: null,
    status: "open",
    sortOrder: 0,
    completedDaysAgo: null,
  },
  {
    id: task(18),
    title: "Pack the emergency kit",
    notes: "Safety pins, plasters, a phone charger, painkillers.",
    timeframeBucket: "day_of",
    dueAt: null,
    status: "open",
    sortOrder: 1,
    completedDaysAgo: null,
  },
] as const satisfies readonly SeedTask[];
