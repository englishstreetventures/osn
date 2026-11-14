import { it, expect, describe } from "@effect/vitest";
import { handleHolds } from "@osn/db/schema";
import { Db } from "@osn/db/service";
import { type EmailService, makeLogEmailLive } from "@shared/email";
import { Cause, Effect, Exit, Layer } from "effect";
import { afterEach, beforeAll, vi } from "vitest";

import { makeHeldHandleDigest } from "../../src/lib/handle-hold";
import { createAuthService, type AuthConfig } from "../../src/services/auth";
import { createOrganisationService } from "../../src/services/organisation";
import { createProfileService } from "../../src/services/profile";
import { makeTestAuthConfig } from "../helpers/auth-config";
import { settle } from "../helpers/background";
import { createTestLayer } from "../helpers/db";
import { latestLinkTo } from "../helpers/registration";

let config: AuthConfig;

beforeAll(async () => {
  config = await makeTestAuthConfig();
});

afterEach(() => {
  vi.useRealTimers();
});

const nowSec = () => Math.floor(Date.now() / 1000);

describe("makeHeldHandleDigest", () => {
  // Each route factory builds its own auth service. With no pepper, a key
  // made per service would leave a hold written through the erasure routes
  // invisible to the registration, profile and organisation routes.
  it("gives every factory the same digest when no pepper is set", () => {
    expect(makeHeldHandleDigest(undefined)("someone")).toBe(
      makeHeldHandleDigest(undefined)("someone"),
    );
    expect(createAuthService(config).heldHandleDigest("someone")).toBe(
      createAuthService(config).heldHandleDigest("someone"),
    );
  });

  // Every deployed isolate has the pepper and no shared memory: the digest
  // has to come from the pepper alone, or a hold written in one isolate is
  // not seen in the next.
  it("keys the digest with the pepper when one is set", () => {
    const pepper = "p".repeat(32);
    const peppered = makeHeldHandleDigest(pepper)("someone");
    expect(peppered).toMatch(/^[0-9a-f]{64}$/);
    expect(makeHeldHandleDigest(pepper)("someone")).toBe(peppered);
    expect(
      createAuthService({ ...config, sessionIpPepper: pepper }).heldHandleDigest("someone"),
    ).toBe(peppered);
    expect(makeHeldHandleDigest(undefined)("someone")).not.toBe(peppered);
  });
});

/**
 * The four places a handle is taken or offered, each built as its own route
 * factory builds it, with its own auth service.
 */
function makeSites() {
  const email = makeLogEmailLive();
  const registration = createAuthService(config);
  const profiles = createProfileService(createAuthService(config));
  const orgs = createOrganisationService({
    heldHandleDigest: createAuthService(config).heldHandleDigest,
  });
  return {
    registration,
    profiles,
    orgs,
    recorded: () => email.recorded(),
    layer: Layer.merge(createTestLayer(), email.layer),
  };
}

type Sites = ReturnType<typeof makeSites>;

/** An account to create profiles and organisations under, on a free handle. */
const owner = (sites: Sites) => sites.registration.registerProfile("owner@example.com", "owner");

/** What a create answered: `admitted`, or the error's tag and message. */
const outcome = <A, E extends { readonly _tag: string; readonly message?: string }, R>(
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.as("admitted"),
    Effect.catch((e) => Effect.succeed(`${e._tag}: ${e.message ?? ""}`)),
  );

/**
 * Each site: what it answers for `handle`, what it answers for a handle a
 * profile already has, and what it answers for a free one.
 */
const SITES: ReadonlyArray<{
  readonly site: string;
  readonly attempt: (
    sites: Sites,
    handle: string,
  ) => Effect.Effect<string, unknown, Db | EmailService>;
  readonly taken: string;
  readonly free: string;
}> = [
  {
    site: "registerProfile",
    attempt: (sites, handle) =>
      outcome(sites.registration.registerProfile("new@example.com", handle)),
    taken: "AuthError: Handle already taken",
    free: "admitted",
  },
  {
    // Begin answers a taken handle as it answers a free one, and mails nothing.
    site: "beginRegistration",
    attempt: (sites, handle) =>
      Effect.gen(function* () {
        const begun = yield* settle(
          sites.registration.beginRegistration("new@example.com", handle, "1990-01-01"),
        );
        const mailed = latestLinkTo(sites.recorded(), "new@example.com") !== null;
        return `${begun.requestId.startsWith("signup_") ? "answered" : "refused"}, ${mailed ? "mailed" : "not mailed"}`;
      }),
    taken: "answered, not mailed",
    free: "answered, mailed",
  },
  {
    site: "checkHandle",
    attempt: (sites, handle) =>
      sites.registration
        .checkHandle(handle)
        .pipe(Effect.map(({ available }) => `available: ${available}`)),
    taken: "available: false",
    free: "available: true",
  },
  {
    site: "createProfile",
    attempt: (sites, handle) =>
      Effect.gen(function* () {
        const { accountId } = yield* owner(sites);
        return yield* outcome(sites.profiles.createProfile(accountId, handle));
      }),
    taken: "AuthError: Handle already taken",
    free: "admitted",
  },
  {
    site: "createOrganisation",
    attempt: (sites, handle) =>
      Effect.gen(function* () {
        const { id } = yield* owner(sites);
        return yield* outcome(sites.orgs.createOrganisation(id, handle, "Someone"));
      }),
    taken: "OrgError: Handle unavailable",
    free: "admitted",
  },
];

/**
 * Writes a hold on `handle` under the no-pepper digest made apart from every
 * site above, as the erasure routes' own factory makes it.
 */
const holdHandle = (
  handle: string,
  hold: { readonly accountId: string | null; readonly releaseAt: number | null },
) =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    yield* Effect.promise(() =>
      db.insert(handleHolds).values({
        handle: makeHeldHandleDigest(undefined)(handle),
        accountId: hold.accountId,
        releaseAt: hold.releaseAt,
        createdAt: nowSec(),
      }),
    );
  });

describe.each(SITES)("a held handle at $site", ({ attempt, taken, free }) => {
  // Pins `taken` to what the site says for a handle a profile has, so the
  // tests below prove a hold gets that answer and no other.
  it.effect("answers a handle a profile has with the taken answer", () => {
    const sites = makeSites();
    return Effect.gen(function* () {
      yield* sites.registration.registerProfile("holder@example.com", "someone");
      expect(yield* attempt(sites, "someone")).toBe(taken);
    }).pipe(Effect.provide(sites.layer));
  });

  it.effect("is refused while the deletion that holds it is pending", () => {
    const sites = makeSites();
    return Effect.gen(function* () {
      const holder = yield* sites.registration.registerProfile("holder@example.com", "holder");
      yield* holdHandle("someone", { accountId: holder.accountId, releaseAt: null });
      expect(yield* attempt(sites, "someone")).toBe(taken);
    }).pipe(Effect.provide(sites.layer));
  });

  it.effect("is refused after the hard delete until its release", () => {
    const sites = makeSites();
    return Effect.gen(function* () {
      yield* holdHandle("someone", { accountId: null, releaseAt: nowSec() + 86_400 });
      expect(yield* attempt(sites, "someone")).toBe(taken);
    }).pipe(Effect.provide(sites.layer));
  });

  it.effect("is admitted from the second of its release", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2030-06-01T10:00:00.000Z"));
    const sites = makeSites();
    return Effect.gen(function* () {
      yield* holdHandle("someone", { accountId: null, releaseAt: nowSec() });
      expect(yield* attempt(sites, "someone")).toBe(free);
    }).pipe(Effect.provide(sites.layer));
  });
});

describe("createOrganisationService without the held-handle digest", () => {
  // The option is optional because the internal organisation routes never
  // create. A factory built without it must not create an organisation on a
  // held handle by skipping the check.
  it.effect("refuses to create, as a defect", () => {
    const sites = makeSites();
    return Effect.gen(function* () {
      const { id } = yield* owner(sites);
      const exit = yield* Effect.exit(
        createOrganisationService().createOrganisation(id, "someone", "Someone"),
      );
      expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true);
    }).pipe(Effect.provide(sites.layer));
  });
});
