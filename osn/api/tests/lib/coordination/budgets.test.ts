import { describe, expect, it, vi } from "vitest";

import type { CoordinationStores } from "../../../src/lib/coordination";
import { createDurableCoordination } from "../../../src/lib/coordination/durable";
import { createInMemoryCoordination } from "../../../src/lib/coordination/memory";
import {
  AUTH_RATE_LIMITS,
  OSN_RATE_LIMITS,
  type AuthRateLimiters,
  type RateLimitBudget,
} from "../../../src/routes/auth/limiters";
import { createFakeNamespace } from "../../helpers/coordination-namespace";

/**
 * Both builders hold every limiter to the one budget table: `maxRequests`
 * hits pass, the next is refused, the refusal lasts the budget's whole window
 * and no longer, and two limiters never share a counter.
 */

interface Slot {
  readonly label: string;
  readonly check: (key: string) => boolean | Promise<boolean>;
  readonly budget: RateLimitBudget;
}

function slots(bundle: CoordinationStores): Slot[] {
  const out: Slot[] = (Object.keys(AUTH_RATE_LIMITS) as (keyof AuthRateLimiters)[]).map((key) => ({
    label: `auth.${key}`,
    check: (k) => bundle.authRateLimiters[key].check(k),
    budget: AUTH_RATE_LIMITS[key],
  }));
  const add = (label: string, limiter: Slot["check"], budget: RateLimitBudget) =>
    out.push({ label, check: limiter, budget });
  add("graphWrite", (k) => bundle.graphRateLimiter.check(k), OSN_RATE_LIMITS.graphWrite);
  add("orgWrite", (k) => bundle.orgRateLimiter.check(k), OSN_RATE_LIMITS.orgWrite);
  add(
    "recommendationSuggest",
    (k) => bundle.recommendationRateLimiters.suggest.check(k),
    OSN_RATE_LIMITS.recommendationSuggest,
  );
  add(
    "recommendationSearch",
    (k) => bundle.recommendationRateLimiters.search.check(k),
    OSN_RATE_LIMITS.recommendationSearch,
  );
  add(
    "profileCreate",
    (k) => bundle.profileRateLimiters.profileCreate.check(k),
    OSN_RATE_LIMITS.profileCreate,
  );
  add(
    "profileDelete",
    (k) => bundle.profileRateLimiters.profileDelete.check(k),
    OSN_RATE_LIMITS.profileDelete,
  );
  add(
    "profileSetDefault",
    (k) => bundle.profileRateLimiters.profileSetDefault.check(k),
    OSN_RATE_LIMITS.profileSetDefault,
  );
  add(
    "healthCoordination",
    (k) => bundle.healthProbeLimiter.check(k),
    OSN_RATE_LIMITS.healthCoordination,
  );
  add("accountExport", (k) => bundle.accountExportLimiter.check(k), OSN_RATE_LIMITS.accountExport);
  add(
    "accountExportIp",
    (k) => bundle.accountExportIpLimiter.check(k),
    OSN_RATE_LIMITS.accountExportIp,
  );
  add(
    "accountDelete",
    (k) => bundle.accountErasureRateLimiters.accountDelete.check(k),
    OSN_RATE_LIMITS.accountDelete,
  );
  add(
    "accountRestore",
    (k) => bundle.accountErasureRateLimiters.accountRestore.check(k),
    OSN_RATE_LIMITS.accountRestore,
  );
  add(
    "accountDeletionStatus",
    (k) => bundle.accountErasureRateLimiters.accountDeletionStatus.check(k),
    OSN_RATE_LIMITS.accountDeletionStatus,
  );
  add(
    "profileSwitchCap",
    (k) => bundle.profileSwitchCap.check(k),
    OSN_RATE_LIMITS.profileSwitchCap,
  );
  add(
    "emailChangeBeginCap",
    (k) => bundle.emailChangeBeginCap.check(k),
    OSN_RATE_LIMITS.emailChangeBeginCap,
  );
  add(
    "recoveryEmailBeginCap",
    (k) => bundle.recoveryEmailBeginCap.check(k),
    OSN_RATE_LIMITS.recoveryEmailBeginCap,
  );
  return out;
}

const builders = {
  memory: () => createInMemoryCoordination(),
  durable_object: () => createDurableCoordination(createFakeNamespace().ns, vi.fn()),
} as const;

describe.each(Object.entries(builders))("%s bundle", (_name, build) => {
  it("lets each limiter's budget through and refuses the next hit", async () => {
    for (const slot of slots(build())) {
      for (let i = 0; i < slot.budget.maxRequests; i++) {
        // eslint-disable-next-line no-await-in-loop -- a window counts hits in order
        expect(await slot.check("key-1"), `${slot.label} hit ${i + 1}`).toBe(true);
      }
      // eslint-disable-next-line no-await-in-loop -- one slot at a time
      expect(await slot.check("key-1"), `${slot.label} over budget`).toBe(false);
      // Another key has its own window.
      // eslint-disable-next-line no-await-in-loop -- one slot at a time
      expect(await slot.check("key-2"), `${slot.label} other key`).toBe(true);
    }
  });

  it("refuses for the budget's whole window, then admits again", async () => {
    vi.useFakeTimers();
    try {
      const count = slots(build()).length;
      for (let i = 0; i < count; i++) {
        // A fresh bundle for each limiter, so its window starts at `start`.
        const slot = slots(build())[i]!;
        const { maxRequests, windowMs } = slot.budget;
        const start = Date.now();
        for (let hit = 0; hit < maxRequests; hit++) {
          // eslint-disable-next-line no-await-in-loop -- a window counts hits in order
          expect(await slot.check("key-1"), `${slot.label} hit ${hit + 1}`).toBe(true);
        }
        // eslint-disable-next-line no-await-in-loop -- one slot at a time
        expect(await slot.check("key-1"), `${slot.label} over budget`).toBe(false);

        // Still refused a moment before the window ends — for an hour or a day
        // budget, long after a one-minute window would have let it through —
        // and admitted a moment after.
        vi.setSystemTime(start + windowMs - 1);
        // eslint-disable-next-line no-await-in-loop -- one slot at a time
        expect(await slot.check("key-1"), `${slot.label} at the end of its window`).toBe(false);
        vi.setSystemTime(start + windowMs + 1);
        // eslint-disable-next-line no-await-in-loop -- one slot at a time
        expect(await slot.check("key-1"), `${slot.label} after its window`).toBe(true);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("never lets one limiter spend another's budget", async () => {
    const all = slots(build());
    // Exhaust every limiter on one shared key, then check none was spent early:
    // a shared counter would refuse before its own budget ran out.
    for (const slot of all) {
      for (let i = 0; i < slot.budget.maxRequests; i++) {
        // eslint-disable-next-line no-await-in-loop -- a window counts hits in order
        expect(await slot.check("shared"), `${slot.label} hit ${i + 1}`).toBe(true);
      }
    }
  });
});

describe("durable bundle store names", () => {
  it("puts every limiter on its own store", async () => {
    const fake = createFakeNamespace();
    const bundle = createDurableCoordination(fake.ns, vi.fn());
    for (const slot of slots(bundle)) {
      // eslint-disable-next-line no-await-in-loop -- one call each
      await slot.check("k");
    }
    const stores = fake.calls.map((call) => call.store);
    expect(new Set(stores).size).toBe(stores.length);
  });
});
