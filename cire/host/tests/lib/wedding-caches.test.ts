import { beforeEach, describe, expect, it } from "vitest";

import * as budget from "../../src/lib/budget-store";
import * as enquiries from "../../src/lib/enquiries-store";
import * as events from "../../src/lib/events-store";
import * as guests from "../../src/lib/guests-store";
import * as households from "../../src/lib/households-store";
import * as registry from "../../src/lib/registry-store";
import * as tasks from "../../src/lib/tasks-store";
import * as upgrade from "../../src/lib/upgrade-store";
import * as vendors from "../../src/lib/vendors-store";
import { dropWeddingCaches, openWeddingCaches } from "../../src/lib/wedding-caches";
import { __resetWeddingScope } from "../../src/lib/wedding-scope";

/**
 * Every per-wedding store, driven through the same questions. The values are
 * opaque to the stores, so one placeholder row stands in for each shape.
 */
interface StoreSpec {
  name: string;
  accessor: (weddingId: string) => () => unknown;
  /** Absent where the store has no public setter (households fill only by loading). */
  set?: (weddingId: string) => void;
  /** Absent where the store has no loader (the upgrade catalogue). */
  ensure?: (weddingId: string, fetcher: () => Promise<never>) => Promise<boolean>;
  reset: () => void;
}

const ROW = [{ id: "row_1" }] as never;
const SNAPSHOT = { items: [], payments: [], budgetTotalMinor: null, currency: "AUD" } as never;

const stores: StoreSpec[] = [
  {
    name: "budget",
    accessor: budget.budgetAccessor,
    set: (id) => budget.setCachedBudget(id, SNAPSHOT),
    ensure: budget.ensureBudgetLoaded,
    reset: budget.__resetBudgetCache,
  },
  {
    name: "enquiries",
    accessor: enquiries.enquiriesAccessor,
    set: (id) => enquiries.setCachedEnquiries(id, ROW),
    ensure: enquiries.ensureEnquiriesLoaded,
    reset: enquiries.__resetEnquiriesCache,
  },
  {
    name: "events",
    accessor: events.eventsAccessor,
    set: (id) => events.setCachedEvents(id, ROW),
    ensure: events.ensureEventsLoaded,
    reset: events.__resetEventsCache,
  },
  {
    name: "guests",
    accessor: guests.guestsAccessor,
    set: (id) => guests.setCachedGuests(id, ROW),
    ensure: guests.ensureGuestsLoaded,
    reset: guests.__resetGuestsCache,
  },
  {
    name: "households",
    accessor: households.householdsAccessor,
    ensure: households.ensureHouseholdsLoaded,
    reset: households.__resetHouseholdsCache,
  },
  {
    name: "registry",
    accessor: registry.registryAccessor,
    set: (id) => registry.setCachedRegistry(id, SNAPSHOT),
    ensure: registry.ensureRegistryLoaded,
    reset: registry.__resetRegistryCache,
  },
  {
    name: "tasks",
    accessor: tasks.tasksAccessor,
    set: (id) => tasks.setCachedTasks(id, ROW),
    ensure: tasks.ensureTasksLoaded,
    reset: tasks.__resetTasksCache,
  },
  {
    name: "upgrade catalogue",
    accessor: upgrade.catalogueAccessor,
    set: (id) => upgrade.setCatalogue(id, ROW),
    reset: upgrade.__resetUpgradeStore,
  },
  {
    name: "vendors",
    accessor: vendors.vendorsAccessor,
    set: (id) => vendors.setCachedVendors(id, ROW),
    ensure: vendors.ensureVendorsLoaded,
    reset: vendors.__resetVendorsCache,
  },
];

/** Put a value in the store for this wedding, by whichever door it has. */
async function fill(store: StoreSpec, weddingId: string): Promise<void> {
  if (store.set) store.set(weddingId);
  else await store.ensure!(weddingId, async () => ROW);
}

/** A load the test settles by hand. */
function heldLoad() {
  let settle: (value: never) => void = () => {};
  const fetcher = () => new Promise<never>((resolve) => (settle = resolve));
  return { fetcher, settle: () => settle(ROW as unknown as never) };
}

beforeEach(() => {
  __resetWeddingScope();
  for (const store of stores) store.reset();
});

describe.each(stores)("dropWeddingCaches — $name", (store) => {
  it("releases the dropped wedding's rows, even through an accessor taken before", async () => {
    await fill(store, "wed_a");
    await fill(store, "wed_b");
    const heldAccessor = store.accessor("wed_a");
    expect(heldAccessor()).not.toBeNull();

    dropWeddingCaches("wed_a");

    expect(heldAccessor()).toBeNull();
    expect(store.accessor("wed_a")()).toBeNull();
    expect(store.accessor("wed_b")()).not.toBeNull();
  });

  it.runIf(store.set !== undefined)("ignores a write for a dropped wedding", () => {
    dropWeddingCaches("wed_a");
    store.set!("wed_a");
    expect(store.accessor("wed_a")()).toBeNull();
  });

  it.runIf(store.ensure !== undefined)(
    "neither loads nor caches a dropped wedding until it is opened again",
    async () => {
      dropWeddingCaches("wed_a");
      let calls = 0;
      const fetcher = async () => {
        calls += 1;
        return ROW;
      };

      expect(await store.ensure!("wed_a", fetcher)).toBe(false);
      expect(calls).toBe(0);
      expect(store.accessor("wed_a")()).toBeNull();

      openWeddingCaches("wed_a");
      expect(await store.ensure!("wed_a", fetcher)).toBe(true);
      expect(calls).toBe(1);
      expect(store.accessor("wed_a")()).not.toBeNull();
    },
  );

  it.runIf(store.ensure !== undefined)(
    "discards a load that was in flight when the wedding was dropped",
    async () => {
      const load = heldLoad();
      const pending = store.ensure!("wed_a", load.fetcher);

      dropWeddingCaches("wed_a");
      load.settle();

      expect(await pending).toBe(false);
      expect(store.accessor("wed_a")()).toBeNull();
    },
  );

  it.runIf(store.ensure !== undefined)(
    "discards it even when the wedding is opened again before it lands",
    async () => {
      // The load was asked under the authorisation the organiser had before
      // leaving; reopening the wedding does not vouch for what it fetched.
      const load = heldLoad();
      const pending = store.ensure!("wed_a", load.fetcher);

      dropWeddingCaches("wed_a");
      openWeddingCaches("wed_a");
      load.settle();

      expect(await pending).toBe(false);
      expect(store.accessor("wed_a")()).toBeNull();
    },
  );
});
