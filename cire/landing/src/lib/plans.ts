/**
 * The plans the pricing section publishes: the offer as the owner set it.
 *
 * What a wedding pays is a Stripe Price the deployment configures, read back
 * from Stripe at checkout (`cire/api/src/services/upgrade-catalogue.ts`). The
 * amounts here are the published offer, checked by hand against those Prices
 * before a release; nothing compares them automatically. The guest caps and the
 * list of tiers are compared: `tests/lib/plans.test.ts` holds them to
 * `TIERS` and `TIER_GUEST_CAP` in `cire/api/src/services/tiers.ts`.
 */

export interface Plan {
  /** The tier id cire-api stores on the wedding. */
  readonly id: "ivory" | "gold" | "crimson";
  readonly name: string;
  /** Australian dollars, paid once for the wedding; 0 is free. */
  readonly price: number;
  /** The most guests the tier lets a wedding hold. */
  readonly guestCap: number;
  readonly description: string;
  readonly inclusions: readonly string[];
}

export const PLANS: readonly Plan[] = [
  {
    id: "ivory",
    name: "Ivory",
    price: 0,
    guestCap: 100,
    description: "The invitation, and every reply to it.",
    inclusions: [
      "Classic and Gala designs",
      "Events, guest list and replies",
      "Guest import and household codes",
      "Co-hosts to plan with you",
    ],
  },
  {
    id: "gold",
    name: "Gold",
    price: 79,
    guestCap: 500,
    description: "For planning the day around it.",
    inclusions: [
      "Everything in Ivory",
      "Seating chart",
      "Run sheet for the day",
      "Budget and checklist",
      "Gift registry and gift log",
    ],
  },
  {
    id: "crimson",
    name: "Crimson",
    price: 149,
    guestCap: 1000,
    description: "For the whole wedding team.",
    inclusions: [
      "Everything in Gold",
      "Your vendors in one place",
      "Browse the vendor directory",
      "Send enquiries to vendors",
    ],
  },
];

/** What a wedding already on Gold pays to move to Crimson, in Australian dollars. */
export const GOLD_TO_CRIMSON_PRICE = 70;
