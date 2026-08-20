// Budget lines + payments on the sample wedding. Consumed only by
// cire/db/seed/generate.ts.
//
// The Budget module shipped after this seed was first written, so a dev tier
// carried the whole surface with nothing in it: no categories, no totals, no
// payment schedule, and an Overview spend meter permanently at zero. Every read
// path below the list (category grouping, the estimate/quote/actual columns, the
// paid-vs-outstanding split, the over-budget tone on the meter) needs rows
// before it shows anything at all.
//
// All amounts are MINOR units of the wedding's currency (AUD — see
// wedding.ts). The estimates sum to A$99,450, just under the wedding's
// A$100,000 `budget_total_minor`, so the meter renders its normal state; nudge
// one line up if you want to exercise the `over` tone.
//
// `category` is a key from cire/api/src/lib/service-categories.ts — the closed
// set the Budget HTTP schema validates against. A key that is not on that list
// seeds fine and then fails every write the organiser attempts against the row.

export type SeedPayment = {
  readonly id: string;
  readonly label: string;
  readonly amountMinor: number;
  /** ISO date (YYYY-MM-DD) the payment is due, or null for one already settled. */
  readonly dueAt: string | null;
  /** Days before seed time this was paid; null while outstanding. */
  readonly paidDaysAgo: number | null;
};

export type SeedBudgetItem = {
  readonly id: string;
  readonly category: string;
  readonly name: string;
  readonly estimateMinor: number | null;
  readonly quotedMinor: number | null;
  readonly actualMinor: number | null;
  readonly notes: string | null;
  readonly payments: readonly SeedPayment[];
};

// Ids are fixed UUIDs in the shape the app writes, so dev links to a budget line
// survive a reseed.
const item = (n: number): string => `bud_e2a1c0d4-0000-4000-8000-${String(n).padStart(12, "0")}`;
const pay = (n: number): string => `pay_e2a1c0d4-0000-4000-8000-${String(n).padStart(12, "0")}`;

export const budgetItems = [
  {
    id: item(1),
    category: "venue",
    name: "Reception venue",
    estimateMinor: 3_200_000,
    quotedMinor: 3_450_000,
    actualMinor: null,
    notes: "Quote came in over the estimate — minimum spend on a Saturday.",
    payments: [
      { id: pay(1), label: "Deposit", amountMinor: 690_000, dueAt: null, paidDaysAgo: 120 },
      {
        id: pay(2),
        label: "Balance",
        amountMinor: 2_760_000,
        dueAt: "2026-10-25",
        paidDaysAgo: null,
      },
    ],
  },
  {
    id: item(2),
    category: "catering",
    name: "Dinner and canapés",
    estimateMinor: 2_800_000,
    quotedMinor: 2_940_000,
    actualMinor: null,
    notes: "Per head, 560 guests. Final numbers due with the balance.",
    payments: [
      { id: pay(3), label: "Deposit", amountMinor: 588_000, dueAt: null, paidDaysAgo: 90 },
      {
        id: pay(4),
        label: "Balance",
        amountMinor: 2_352_000,
        dueAt: "2026-11-10",
        paidDaysAgo: null,
      },
    ],
  },
  {
    id: item(3),
    category: "photography",
    name: "Photographer — full day",
    estimateMinor: 650_000,
    quotedMinor: 620_000,
    actualMinor: 620_000,
    notes: null,
    payments: [
      { id: pay(5), label: "Deposit", amountMinor: 200_000, dueAt: null, paidDaysAgo: 150 },
      { id: pay(6), label: "Balance", amountMinor: 420_000, dueAt: null, paidDaysAgo: 10 },
    ],
  },
  {
    id: item(4),
    category: "videography",
    name: "Videographer — ceremony and speeches",
    estimateMinor: 450_000,
    quotedMinor: null,
    actualMinor: null,
    notes: "Two quotes outstanding.",
    payments: [],
  },
  {
    id: item(5),
    category: "decor_styling",
    name: "Styling and lighting",
    estimateMinor: 420_000,
    quotedMinor: 445_000,
    actualMinor: null,
    notes: null,
    payments: [],
  },
  {
    id: item(6),
    category: "florals",
    name: "Mandap and table florals",
    estimateMinor: 380_000,
    quotedMinor: 412_000,
    actualMinor: null,
    notes: null,
    payments: [],
  },
  {
    id: item(7),
    category: "music_entertainment",
    name: "DJ and dhol players",
    estimateMinor: 300_000,
    quotedMinor: 285_000,
    actualMinor: 285_000,
    notes: null,
    payments: [
      { id: pay(7), label: "Full fee", amountMinor: 285_000, dueAt: null, paidDaysAgo: 30 },
    ],
  },
  {
    id: item(8),
    category: "celebrant",
    name: "Celebrant",
    estimateMinor: 90_000,
    quotedMinor: 90_000,
    actualMinor: null,
    notes: null,
    payments: [
      { id: pay(8), label: "Booking fee", amountMinor: 30_000, dueAt: null, paidDaysAgo: 200 },
      { id: pay(9), label: "Balance", amountMinor: 60_000, dueAt: "2026-11-20", paidDaysAgo: null },
    ],
  },
  {
    id: item(9),
    category: "cake",
    name: "Three-tier cake",
    estimateMinor: 120_000,
    quotedMinor: null,
    actualMinor: null,
    notes: null,
    payments: [],
  },
  {
    id: item(10),
    category: "stationery",
    name: "Invitations and signage",
    estimateMinor: 95_000,
    quotedMinor: 88_000,
    actualMinor: 88_000,
    notes: null,
    payments: [],
  },
  {
    id: item(11),
    category: "hair_makeup",
    name: "Hair and makeup, both sides",
    estimateMinor: 260_000,
    quotedMinor: 275_000,
    actualMinor: null,
    notes: null,
    payments: [{ id: pay(10), label: "Trial", amountMinor: 45_000, dueAt: null, paidDaysAgo: 20 }],
  },
  {
    id: item(12),
    category: "transport",
    name: "Guest coaches and the car",
    estimateMinor: 180_000,
    quotedMinor: null,
    actualMinor: null,
    notes: null,
    payments: [],
  },
  {
    id: item(13),
    category: "attire",
    name: "Outfits and jewellery",
    estimateMinor: 700_000,
    quotedMinor: null,
    actualMinor: 760_000,
    notes: "Came in over — the second outfit was not in the estimate.",
    payments: [],
  },
  {
    id: item(14),
    category: "other",
    name: "Contingency",
    estimateMinor: 300_000,
    quotedMinor: null,
    actualMinor: null,
    notes: null,
    payments: [],
  },
] as const satisfies readonly SeedBudgetItem[];
