import { describe, expect, it, vi } from "vitest";

import type { CoordinationStores } from "../../../src/lib/coordination";
import { createDurableCoordination } from "../../../src/lib/coordination/durable";
import { createInMemoryCoordination } from "../../../src/lib/coordination/memory";
import {
  RECOVERY_LOCKOUT_MS,
  RECOVERY_LOCKOUT_THRESHOLD,
  type RecoveryLockoutStore,
} from "../../../src/lib/recovery-lockout-store";
import {
  AUTH_RATE_LIMITS,
  OSN_RATE_LIMITS,
  type AuthRateLimiters,
  type RateLimitBudget,
} from "../../../src/routes/auth/limiters";
import {
  REGISTRATION_LINK_LOCKOUT_MS,
  REGISTRATION_LINK_LOCKOUT_THRESHOLD,
  TOTP_LOCKOUT_MS,
  TOTP_LOCKOUT_THRESHOLD,
} from "../../../src/services/auth/constants";
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

/**
 * How each non-auth limiter is reached on a bundle. Keyed by every
 * `OSN_RATE_LIMITS` entry, so the type checker refuses a limiter left out.
 */
const OSN_LIMITERS: Record<keyof typeof OSN_RATE_LIMITS, (b: CoordinationStores) => Slot["check"]> =
  {
    graphWrite: (b) => (k) => b.graphRateLimiter.check(k),
    orgWrite: (b) => (k) => b.orgRateLimiter.check(k),
    recommendationSuggest: (b) => (k) => b.recommendationRateLimiters.suggest.check(k),
    recommendationSearch: (b) => (k) => b.recommendationRateLimiters.search.check(k),
    profileCreate: (b) => (k) => b.profileRateLimiters.profileCreate.check(k),
    profileDelete: (b) => (k) => b.profileRateLimiters.profileDelete.check(k),
    profileSetDefault: (b) => (k) => b.profileRateLimiters.profileSetDefault.check(k),
    healthCoordination: (b) => (k) => b.healthProbeLimiter.check(k),
    accountExport: (b) => (k) => b.accountExportLimiter.check(k),
    accountExportIp: (b) => (k) => b.accountExportIpLimiter.check(k),
    arcJwksIp: (b) => (k) => b.arcJwksRateLimiters.minute.check(k),
    arcJwksIpHour: (b) => (k) => b.arcJwksRateLimiters.hour.check(k),
    accountDelete: (b) => (k) => b.accountErasureRateLimiters.accountDelete.check(k),
    accountRestore: (b) => (k) => b.accountErasureRateLimiters.accountRestore.check(k),
    accountDeletionStatus: (b) => (k) =>
      b.accountErasureRateLimiters.accountDeletionStatus.check(k),
    accountDataLink: (b) => (k) => b.accountErasureRateLimiters.accountDataLink.check(k),
    profileSwitchCap: (b) => (k) => b.profileSwitchCap.check(k),
    emailChangeBeginCap: (b) => (k) => b.emailChangeBeginCap.check(k),
    recoveryLinkAddressCap: (b) => (k) => b.recoveryLinkAddressCap.check(k),
    recoveryResendCap: (b) => (k) => b.recoveryResendCap.check(k),
    recoveryLinkCeiling: (b) => (k) => b.recoveryLinkCeiling.check(k),
    registrationSendCap: (b) => (k) => b.registrationSendCap.check(k),
    registrationFirstLinkCap: (b) => (k) => b.registrationFirstLinkCap.check(k),
    stepUpLinkCeiling: (b) => (k) => b.stepUpLinkCeiling.check(k),
    linkResendCap: (b) => (k) => b.linkResendCap.check(k),
  };

function slots(bundle: CoordinationStores): Slot[] {
  const auth: Slot[] = (Object.keys(AUTH_RATE_LIMITS) as (keyof AuthRateLimiters)[]).map((key) => ({
    label: `auth.${key}`,
    check: (k) => bundle.authRateLimiters[key].check(k),
    budget: AUTH_RATE_LIMITS[key],
  }));
  const osn: Slot[] = (Object.keys(OSN_RATE_LIMITS) as (keyof typeof OSN_RATE_LIMITS)[]).map(
    (key) => ({
      label: key,
      check: OSN_LIMITERS[key](bundle),
      budget: OSN_RATE_LIMITS[key],
    }),
  );
  return [...auth, ...osn];
}

/** Every field of the bundle that holds a lockout store. */
type LockoutField = {
  [K in keyof CoordinationStores]: CoordinationStores[K] extends RecoveryLockoutStore ? K : never;
}[keyof CoordinationStores];

/**
 * Each lockout's threshold and window. Keyed by every lockout field of the
 * bundle, so the type checker refuses a lockout left out.
 */
const LOCKOUTS: Record<LockoutField, readonly [threshold: number, lockoutMs: number]> = {
  recoveryLockoutStore: [RECOVERY_LOCKOUT_THRESHOLD, RECOVERY_LOCKOUT_MS],
  recoveryOtpLockoutStore: [RECOVERY_LOCKOUT_THRESHOLD, RECOVERY_LOCKOUT_MS],
  totpLockoutStore: [TOTP_LOCKOUT_THRESHOLD, TOTP_LOCKOUT_MS],
  registrationLinkLockoutStore: [REGISTRATION_LINK_LOCKOUT_THRESHOLD, REGISTRATION_LINK_LOCKOUT_MS],
  stepUpLinkLockoutStore: [RECOVERY_LOCKOUT_THRESHOLD, RECOVERY_LOCKOUT_MS],
};

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

  it("holds each lockout for its whole window, then opens", async () => {
    const lockouts = Object.entries(LOCKOUTS) as [
      LockoutField,
      readonly [threshold: number, lockoutMs: number],
    ][];
    vi.useFakeTimers();
    try {
      for (const [name, [threshold, lockoutMs]] of lockouts) {
        const store = build()[name];
        const start = Date.now();
        for (let i = 0; i < threshold; i++) {
          // eslint-disable-next-line no-await-in-loop -- failures count in order
          await store.recordFailure("acc_1");
        }
        vi.setSystemTime(start + lockoutMs - 1);
        // eslint-disable-next-line no-await-in-loop -- one store at a time
        expect(await store.status("acc_1"), `${name} at the end of its window`).toMatchObject({
          status: "locked",
        });
        vi.setSystemTime(start + lockoutMs + 1);
        // eslint-disable-next-line no-await-in-loop -- one store at a time
        expect(await store.status("acc_1"), `${name} after its window`).toEqual({
          status: "open",
          failures: 0,
        });
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
