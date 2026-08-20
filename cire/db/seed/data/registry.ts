// The gift registry on the sample wedding — settings, items, claims. Consumed
// only by cire/db/seed/generate.ts.
//
// The registry is the one module gated by an entitlement no production wedding
// holds (see entitlements.ts), so the dev tier is the ONLY place it can be
// exercised end to end. It shipped with no seed data, which left the unlocked
// module as empty as the locked one: no list, no gift log, no claimed/purchased
// states, and a guest-side registry that 404s because `published` was never set.
//
// Prices are MINOR units of the wedding's currency (AUD — see wedding.ts).
//
// `image_key` is NULL on every item on purpose. It is an R2 object key, not a
// URL, so a key with no bytes behind it renders a broken image on both the
// organiser list and the guest site; the images that DO exist on a dev bucket
// are the invite assets uploaded by `assets:seed:dev`, and none of them is a
// gift. The link-preview path fills this column in normally when an organiser
// pastes a URL.
//
// `external_url` points at example.com rather than a real retailer: the column
// is rendered into an `<a href>` on the guest site, and seeding live third-party
// links would put URLs in front of testers that rot, redirect, or track. The
// hrefs are stored in the same normal form the write path produces (URL.href).

export type SeedRegistrySettings = {
  readonly published: boolean;
  readonly headline: string;
  readonly message: string;
  readonly cashGiftsEnabled: boolean;
  readonly shippingAddress: string;
  /** ISO date (YYYY-MM-DD) before which the address stays hidden; null ⇒ visible. */
  readonly shippingVisibleFrom: string | null;
};

export type SeedRegistryItem = {
  readonly id: string;
  readonly title: string;
  readonly description: string | null;
  readonly externalUrl: string | null;
  readonly priceMinor: number | null;
  readonly quantityWanted: number;
  readonly category: string | null;
  readonly sortOrder: number;
};

export type SeedRegistryClaim = {
  readonly id: string;
  readonly itemId: string;
  /** A canonical seeded household — see guests.ts. */
  readonly familyId: string;
  readonly quantity: number;
  readonly status: "reserved" | "purchased";
  readonly note: string | null;
  readonly displayName: string | null;
  /** Days before seed time the couple sent thanks; null ⇒ not thanked yet. */
  readonly thankedDaysAgo: number | null;
  /** Days before seed time the claim was made. */
  readonly daysAgo: number;
};

// `published` is on so the guest-side registry actually answers on dev. It is a
// second, independent gate from the entitlement: both must hold, so leaving this
// off would 404 the guest page on a wedding that holds the comp.
export const registrySettings = {
  published: true,
  headline: "Our registry",
  message:
    "Your being there is the gift — but if you'd like to mark the day with something, here is our list.",
  cashGiftsEnabled: false,
  shippingAddress: "12 Wharf Road, Birchgrove NSW 2041",
  shippingVisibleFrom: null,
} as const satisfies SeedRegistrySettings;

const item = (n: number): string => `reg_c4b8a2f1-0000-4000-8000-${String(n).padStart(12, "0")}`;

export const registryItems = [
  {
    id: item(1),
    title: "Cast-iron casserole, 26cm",
    description: "Anything oven-to-table. Blue if there's a choice.",
    externalUrl: "https://example.com/kitchen/cast-iron-casserole",
    priceMinor: 45_000,
    quantityWanted: 1,
    category: "Kitchen",
    sortOrder: 0,
  },
  {
    id: item(2),
    title: "Stand mixer",
    description: null,
    externalUrl: "https://example.com/kitchen/stand-mixer",
    priceMinor: 79_900,
    quantityWanted: 1,
    category: "Kitchen",
    sortOrder: 1,
  },
  {
    id: item(3),
    title: "Espresso machine",
    description: "The one gift that gets used every single morning.",
    externalUrl: "https://example.com/kitchen/espresso-machine",
    priceMinor: 129_900,
    quantityWanted: 1,
    category: "Kitchen",
    sortOrder: 2,
  },
  {
    id: item(4),
    title: "Wine glasses, set of six",
    description: "Two sets would not go astray.",
    externalUrl: "https://example.com/table/wine-glasses",
    priceMinor: 12_000,
    quantityWanted: 2,
    category: "Table",
    sortOrder: 3,
  },
  {
    id: item(5),
    title: "Cutlery set, 24 piece",
    description: null,
    externalUrl: "https://example.com/table/cutlery-set",
    priceMinor: 34_900,
    quantityWanted: 1,
    category: "Table",
    sortOrder: 4,
  },
  {
    id: item(6),
    title: "Hand-thrown serving platter",
    description: "Made in Bowral, so no two are the same.",
    externalUrl: "https://example.com/table/serving-platter",
    priceMinor: 18_000,
    quantityWanted: 1,
    category: "Table",
    sortOrder: 5,
  },
  {
    id: item(7),
    title: "Linen bedding set, queen",
    description: null,
    externalUrl: "https://example.com/home/linen-bedding",
    priceMinor: 39_900,
    quantityWanted: 1,
    category: "Home",
    sortOrder: 6,
  },
  {
    id: item(8),
    title: "Wool throw",
    description: null,
    externalUrl: "https://example.com/home/wool-throw",
    priceMinor: 24_900,
    quantityWanted: 2,
    category: "Home",
    sortOrder: 7,
  },
  {
    id: item(9),
    title: "Picnic hamper",
    description: "For the drive up the coast afterwards.",
    externalUrl: "https://example.com/outdoors/picnic-hamper",
    priceMinor: 15_900,
    quantityWanted: 1,
    category: "Outdoors",
    sortOrder: 8,
  },
  {
    // Deliberately price-free: the column is nullable and the list, the guest
    // page and the gift log all have to render a line with no number on it.
    id: item(10),
    title: "A recipe you actually cook",
    description: "Written out, in your handwriting. That's the whole gift.",
    externalUrl: null,
    priceMinor: null,
    quantityWanted: 1,
    category: null,
    sortOrder: 9,
  },
] as const satisfies readonly SeedRegistryItem[];

// Three claims across the canonical households (guests.ts), covering every
// state the gift log branches on: purchased-and-thanked, purchased-not-yet-
// thanked, and a reservation that is still just a reservation. The two-wanted
// items are claimed once, so the "1 of 2 left" arithmetic has something to show.
export const registryClaims = [
  {
    id: "rgc_c4b8a2f1-0000-4000-8000-000000000001",
    itemId: item(3),
    familyId: "a0000000-0000-4000-8000-000000000001",
    quantity: 1,
    status: "purchased",
    note: "Ordered — it should land the week before.",
    displayName: "The Testfamilys",
    thankedDaysAgo: 3,
    daysAgo: 21,
  },
  {
    id: "rgc_c4b8a2f1-0000-4000-8000-000000000002",
    itemId: item(4),
    familyId: "a0000000-0000-4000-8000-000000000002",
    quantity: 1,
    status: "purchased",
    note: null,
    displayName: null,
    thankedDaysAgo: null,
    daysAgo: 14,
  },
  {
    id: "rgc_c4b8a2f1-0000-4000-8000-000000000003",
    itemId: item(8),
    familyId: "a0000000-0000-4000-8000-000000000003",
    quantity: 1,
    status: "reserved",
    note: "Hope the colour's right.",
    displayName: "Auntie Ros",
    thankedDaysAgo: null,
    daysAgo: 6,
  },
] as const satisfies readonly SeedRegistryClaim[];
