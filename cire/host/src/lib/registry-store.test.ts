import { beforeEach, describe, expect, it } from "vitest";

import {
  __resetRegistryCache,
  ensureRegistryLoaded,
  type GiftLogEntry,
  invalidateRegistry,
  peekCachedRegistry,
  registryAccessor,
  type RegistryItem,
  type RegistrySnapshot,
  stillWanted,
} from "./registry-store";

const item = (over: Partial<RegistryItem>): RegistryItem => ({
  id: "itm_1",
  weddingId: "wed_1",
  kind: "product",
  title: "Copper pan",
  description: null,
  imageKey: null,
  imageCrop: null,
  externalUrl: null,
  priceMinor: 12_000,
  quantityWanted: 1,
  quantityClaimed: 0,
  allowPartial: false,
  targetMinor: null,
  category: null,
  sortOrder: 0,
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

const gift = (over: Partial<GiftLogEntry>): GiftLogEntry => ({
  kind: "claim",
  id: "clm_1",
  itemId: "itm_1",
  itemTitle: "Copper pan",
  familyId: "fam_1",
  familyName: "The Nguyens",
  displayName: null,
  quantity: 1,
  status: "reserved",
  note: null,
  amountMinor: null,
  currency: null,
  primaryAmountMinor: null,
  primaryCurrency: null,
  fxRate: null,
  thankedAt: null,
  createdAt: 1,
  ...over,
});

const snapshot = (over: Partial<RegistrySnapshot> = {}): RegistrySnapshot => ({
  settings: {
    weddingId: "wed_1",
    published: false,
    headline: null,
    message: null,
    cashGiftsEnabled: false,
    shippingAddress: null,
    shippingVisibleFrom: null,
    stripeAccountId: null,
    stripeChargesEnabled: false,
    stripePayoutsEnabled: false,
    updatedAt: null,
  },
  items: [item({})],
  gifts: [gift({})],
  giftsHasMore: false,
  currency: "AUD",
  contributionsPrimaryMinor: 0,
  ...over,
});

beforeEach(() => __resetRegistryCache());

describe("registry-store", () => {
  it("loads once and reuses the cache", async () => {
    let calls = 0;
    const fetcher = async () => {
      calls += 1;
      return snapshot();
    };
    await ensureRegistryLoaded("wed_1", fetcher);
    await ensureRegistryLoaded("wed_1", fetcher);
    expect(calls).toBe(1);
    expect(registryAccessor("wed_1")()?.items.length).toBe(1);
  });

  it("caches the whole snapshot, not just the items", async () => {
    // The gift log, the settings and the currency arrive in the SAME response as
    // the items; caching only the item list would send the gifts sub-view back to
    // the network for data it already had.
    await ensureRegistryLoaded("wed_1", async () =>
      snapshot({ gifts: [gift({ id: "a" }), gift({ id: "b" })], giftsHasMore: true }),
    );
    const snap = peekCachedRegistry("wed_1")!;
    expect(snap.gifts.length).toBe(2);
    expect(snap.giftsHasMore).toBe(true);
    expect(snap.currency).toBe("AUD");
    expect(snap.settings.weddingId).toBe("wed_1");
  });

  it("invalidateRegistry clears the cache", async () => {
    await ensureRegistryLoaded("wed_1", async () => snapshot());
    expect(peekCachedRegistry("wed_1")).not.toBeNull();
    invalidateRegistry("wed_1");
    expect(peekCachedRegistry("wed_1")).toBeNull();
  });

  it("inflight deduplication: two concurrent calls fire the fetcher once", async () => {
    let calls = 0;
    const fetcher = async () => {
      calls += 1;
      return snapshot();
    };
    // Fire both before either resolves.
    const [p1, p2] = [
      ensureRegistryLoaded("wed_2", fetcher),
      ensureRegistryLoaded("wed_2", fetcher),
    ];
    await Promise.all([p1, p2]);
    expect(calls).toBe(1);
  });

  it("stillWanted floors at zero when claims overshoot", () => {
    expect(stillWanted(item({ quantityWanted: 3, quantityClaimed: 1 }))).toBe(2);
    // Claims race against each other, so one can land past the wanted count. A
    // negative "still wanted" would read as a fault.
    expect(stillWanted(item({ quantityWanted: 1, quantityClaimed: 2 }))).toBe(0);
  });
});
