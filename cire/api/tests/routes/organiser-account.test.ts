import { beforeAll, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";

import {
  directoryVendors,
  guestAccountLinks,
  organiserSessions,
  ownerNoticeBudget,
  registrySettings,
  weddingHosts,
  weddings,
} from "@cire/db";
import {
  type DeletionRecord,
  type DeletionRecordStore,
  DeletionRecordWriteError,
  memoryDeletionRecordStore,
  missingDeletionRecordStore,
} from "@shared/db-utils/deletion-records";
import { makeLogEmailLive } from "@shared/email";
import { createRateLimiter } from "@shared/rate-limit";
import type { HubNamespace } from "@shared/realtime/server";
import { and, eq, inArray, sql } from "drizzle-orm";
import { Effect } from "effect";

import type { AppOptions } from "../../src/app";
import { createApp } from "../../src/app";
import { createDb } from "../../src/db/setup";
import type { TestDb } from "../../src/db/setup";
import { CIRE_METRICS } from "../../src/metrics";
import {
  MAX_LOWER_SEATS_PER_CALL,
  MAX_OWNED_WEDDINGS_PER_CALL,
} from "../../src/services/account-erasure";
import type { OsnRemovalBridge } from "../../src/services/osn-bridge";
import {
  appRequest,
  beforeStatement,
  failStatements,
  jsonBody,
  recordStatements,
} from "../test-helpers";
import { captureLogs } from "../test-helpers/capture-logs";
import { captureSpans } from "../test-helpers/capture-spans";
import { fullWeddingStatements } from "../test-helpers/full-wedding";
import { counterValue } from "../test-helpers/metrics-harness";
import { seedOrganiserSession } from "../test-helpers/organiser-session";
import { makeOsnTestAuth } from "../test-helpers/osn-token";
import type { OsnTestAuth } from "../test-helpers/osn-token";
import { insertWedding } from "../test-helpers/wedding";

/**
 * A host removes their Cire data and keeps their Musubi account
 * (`routes/organiser-account.ts`). Read by whoever changes those routes, the
 * account erasure's `host` scope, or the step-up request they spend. Each
 * case names the failure it guards in `NEW-FEAT.md` (C1…C13), and every
 * destructive case seeds a second account whose weddings, seats and sessions
 * must come through untouched.
 */

const PORTAL = "https://host.example.test";
/** The person: two profiles of one account. */
const ACCOUNT = "acc_person";
const P = "usr_person";
const P2 = "usr_person_second";
/** Someone else, on another account. */
const OTHER_ACCOUNT = "acc_other";
const O = "usr_other";
const REQUEST = "req_0123456789abcdef";
const CODE = "code_0123456789abcdefghij";

const ACCOUNT_OF: Readonly<Record<string, string>> = {
  [P]: ACCOUNT,
  [P2]: ACCOUNT,
  [O]: OTHER_ACCOUNT,
};
const ADDRESSES: Readonly<Record<string, string>> = {
  [P]: "person@example.test",
  [P2]: "person-second@example.test",
  [O]: "other@example.test",
};

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

let auth: OsnTestAuth;
beforeAll(async () => {
  auth = await makeOsnTestAuth();
});

interface BridgeLog {
  begun: { profileId: string; binding: string; returnTo: string }[];
  verified: { profileId: string; requestId: string; binding: string; code: string }[];
}

/**
 * osn-api, as the removal sees it: a begin records the binding it was sent;
 * a verify holds when the request, binding and code are the ones begun and
 * confirmed, and the profile is of the person's account.
 */
function stubBridge(log: BridgeLog, overrides: Partial<OsnRemovalBridge> = {}): OsnRemovalBridge {
  return {
    begin: async (input) => {
      log.begun.push({ ...input });
      return { ok: true, requestId: REQUEST };
    },
    verify: async (input) => {
      log.verified.push({ ...input });
      const begun = log.begun.at(-1);
      if (
        !begun ||
        input.requestId !== REQUEST ||
        input.binding !== begun.binding ||
        input.code !== CODE ||
        ACCOUNT_OF[input.profileId] !== ACCOUNT
      ) {
        return { ok: false };
      }
      return { ok: true, accountId: ACCOUNT, profileIds: [P, P2] };
    },
    resolveAccount: async (profileId) =>
      ACCOUNT_OF[profileId]
        ? { ok: true, accountId: ACCOUNT_OF[profileId]! }
        : { ok: false, reason: "profile_not_found" },
    ...overrides,
  };
}

function seat(
  db: TestDb,
  weddingId: string,
  osnProfileId: string,
  role: "owner" | "editor" | "viewer" | "helper",
) {
  db.insert(weddingHosts)
    .values({
      id: `whost_${weddingId}_${osnProfileId}`,
      weddingId,
      osnProfileId,
      addedByOsnProfileId: osnProfileId,
      role,
      createdAt: new Date(Date.now() - 86_400_000),
    })
    .run();
}

/**
 * The person alone owns `w_alone`; their second profile alone owns
 * `w_sibling`; they share `w_shared` with someone else, and hold an editor's
 * seat on `w_theirs_edit`, which someone else owns. `w_theirs` is someone
 * else's alone.
 */
async function setup(
  overrides: Partial<AppOptions> & { bridgeOverrides?: Partial<OsnRemovalBridge> } = {},
) {
  // Every members-changed signal the removal sends: its wedding topic, and
  // the profiles whose sockets it closes.
  const signalled: { topic: string; revoked: readonly string[] }[] = [];
  const realtimeHub: HubNamespace = {
    getByName: (topic) => ({
      publish: async (_signal, targets) => {
        signalled.push({ topic, revoked: [...(targets?.revoke ?? [])].toSorted() });
        return 1;
      },
      fetch: async () => new Response(null, { status: 426 }),
    }),
  };
  const db = createDb(":memory:");
  const wedding = (id: string, owners: string[], name = id) =>
    insertWedding(db, {
      id,
      slug: `slug-${id}`,
      displayName: name,
      owners,
      createdAt: new Date(Date.now() - 2 * 86_400_000),
    });
  wedding("w_alone", [P], "Alone");
  wedding("w_sibling", [P2], "Sibling");
  wedding("w_shared", [P, O], "Shared");
  wedding("w_theirs", [O], "Theirs");
  wedding("w_theirs_edit", [O], "Theirs, edited");
  seat(db, "w_theirs_edit", P, "editor");
  const sessions = {
    person: await seedOrganiserSession(db, P),
    other: await seedOrganiserSession(db, O),
  };
  const log: BridgeLog = { begun: [], verified: [] };
  const mail = makeLogEmailLive();
  const { bridgeOverrides, ...appOverrides } = overrides;
  const app = createApp(db, {
    deletionRecords: memoryDeletionRecordStore(),
    osnTestKey: auth.key,
    organiserOrigin: PORTAL,
    accountRemovalLimiter: createRateLimiter({ maxRequests: 1000, windowMs: 60_000 }),
    accountRemovalBridge: stubBridge(log, bridgeOverrides),
    realtimeHub,
    emailLayer: mail.layer,
    organiserEmailLookup: async (ids) => ({
      answered: true,
      emails: new Map(ids.flatMap((id) => (ADDRESSES[id] ? [[id, ADDRESSES[id]] as const] : []))),
    }),
    resolveOsnProfileDisplays: async (ids) => {
      const known = new Map<string, { handle: string; displayName: string; avatarUrl: null }>([
        [P, { handle: "person", displayName: "Pat Person", avatarUrl: null }],
        [P2, { handle: "second", displayName: "Sam Second", avatarUrl: null }],
      ]);
      return new Map([...known].filter(([id]) => ids.includes(id)));
    },
    ...appOverrides,
  });
  return { db, app, sessions, log, mail, signalled };
}

type Setup = Awaited<ReturnType<typeof setup>>;

const call = (
  h: Setup,
  method: string,
  path: string,
  opts: { session?: string | null; removal?: string | null; body?: unknown; origin?: string } = {},
) => {
  const cookies = [
    opts.session === null ? null : `cire_org_session=${opts.session ?? h.sessions.person}`,
    opts.removal ? opts.removal : null,
  ].filter((c): c is string => c !== null);
  const headers: Record<string, string> = {};
  if (cookies.length > 0) headers.cookie = cookies.join("; ");
  if (opts.origin) headers.origin = opts.origin;
  const init: RequestInit = { method, headers };
  if (opts.body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(opts.body);
  }
  return appRequest(h.app, `/api/organiser${path}`, init);
};

/** Asks for a confirmation, as the portal does; answers the cookie the browser keeps. */
async function confirmation(h: Setup): Promise<string> {
  const res = await call(h, "POST", "/account/removal/confirmation");
  expect(res.status).toBe(200);
  const set = res.headers.get("set-cookie") ?? "";
  return set.split(";")[0]!;
}

const remove = (h: Setup, removal: string | null, body: Record<string, unknown>) =>
  call(h, "DELETE", "/account", { removal, body: { code: CODE, ...body } });

const ANSWERS = {
  choices: { "cire:wedding:w_alone": "delete", "cire:wedding:w_sibling": "delete" },
};

const seatsOf = (db: TestDb, weddingId: string) =>
  db
    .select({ profile: weddingHosts.osnProfileId, role: weddingHosts.role })
    .from(weddingHosts)
    .where(eq(weddingHosts.weddingId, weddingId))
    .all()
    .toSorted((a, b) => a.profile.localeCompare(b.profile));

const deletedAt = (db: TestDb, weddingId: string) =>
  db.select({ at: weddings.deletedAt }).from(weddings).where(eq(weddings.id, weddingId)).get()?.at;

type Removal = Extract<DeletionRecord, { kind: "organiser_data_removed" }>;

const bySeat = (a: { weddingId: string; profileId: string }, b: typeof a) =>
  `${a.weddingId} ${a.profileId}`.localeCompare(`${b.weddingId} ${b.profileId}`);

/** A removal record's outcome, its lists in a fixed order. */
const outcomeOf = (record: DeletionRecord | undefined) => {
  const outcome = (record as Removal | undefined)?.outcome;
  return (
    outcome && {
      ...outcome,
      deletedWeddings: outcome.deletedWeddings.toSorted(),
      removedSeats: outcome.removedSeats.toSorted(bySeat),
    }
  );
};

/** Seats as an outcome lists them, in the order {@link outcomeOf} puts them. */
const seatsList = (...seats: [weddingId: string, profileId: string][]) =>
  seats.map(([weddingId, profileId]) => ({ weddingId, profileId })).toSorted(bySeat);

const sessionsOf = (db: TestDb, profileId: string) =>
  db
    .select({ id: organiserSessions.id })
    .from(organiserSessions)
    .where(eq(organiserSessions.osnProfileId, profileId))
    .all().length;

/** Nothing of the removal happened: every wedding live, every seat in place, every session. */
function untouched(db: TestDb) {
  for (const id of ["w_alone", "w_sibling", "w_shared", "w_theirs", "w_theirs_edit"]) {
    expect({ id, deletedAt: deletedAt(db, id) }).toEqual({ id, deletedAt: null });
  }
  expect(seatsOf(db, "w_shared")).toEqual([
    { profile: O, role: "owner" },
    { profile: P, role: "owner" },
  ]);
  expect(sessionsOf(db, P)).toBe(1);
  expect(sessionsOf(db, O)).toBe(1);
}

describe("a host's removal of their Cire data: refusals", () => {
  it("C1: no organiser session is refused on all three routes", async () => {
    const h = await setup();
    for (const [method, path] of [
      ["POST", "/account/removal/preview"],
      ["POST", "/account/removal/confirmation"],
      ["DELETE", "/account"],
    ] as const) {
      const res = await call(h, method, path, { session: null, body: {} });
      expect({ method, path, status: res.status }).toEqual({ method, path, status: 401 });
    }
    expect(h.log.begun).toEqual([]);
    untouched(h.db);
  });

  it("C2: no confirmation cookie, or one that is not this browser's shape, is refused before osn-api is asked", async () => {
    const h = await setup();
    const refusedBefore = await counterValue(CIRE_METRICS.accountRemovalRequests, {
      result: "confirmation_required",
    });
    for (const removal of [
      null,
      "cire_removal=not-a-pair",
      "cire_removal=a.b.c",
      `cire_removal=${REQUEST}.${"s".repeat(43)}.${"x".repeat(20)}`,
      `cire_removal=${REQUEST}.${"s".repeat(20)} ${"s".repeat(20)}`,
    ]) {
      const res = await remove(h, removal, ANSWERS);
      expect({ removal, status: res.status, body: await jsonBody(res) }).toEqual({
        removal,
        status: 403,
        body: { error: "confirmation_required" },
      });
    }
    expect(h.log.verified).toEqual([]);
    expect(
      await counterValue(CIRE_METRICS.accountRemovalRequests, { result: "confirmation_required" }),
    ).toBe(refusedBefore + 5);
    untouched(h.db);
  });

  it("C2b: a body outside the removal's or the preview's shape is refused 400 before osn-api is asked", async () => {
    const h = await setup();
    const cookie = await confirmation(h);
    for (const body of [
      undefined,
      {},
      { code: CODE, choices: { "cire:wedding:w_alone": "keep" } },
      { code: CODE, deleteEverything: "yes" },
    ]) {
      const res = await call(h, "DELETE", "/account", { removal: cookie, body });
      expect({ body, status: res.status, answer: await jsonBody(res) }).toEqual({
        body,
        status: 400,
        answer: { error: "invalid_body" },
      });
    }
    expect(h.log.verified).toEqual([]);
    for (const body of [{ code: 5 }, { code: "x".repeat(65) }]) {
      const res = await call(h, "POST", "/account/removal/preview", { removal: cookie, body });
      expect({ body, status: res.status, answer: await jsonBody(res) }).toEqual({
        body,
        status: 400,
        answer: { error: "invalid_body" },
      });
    }
    expect(h.log.verified).toEqual([]);
    untouched(h.db);
  });

  it("C3: a confirmation osn-api refuses is 403; osn-api unreachable, or no ARC key, is 503; nothing is written", async () => {
    const refused = await setup();
    const cookie = await confirmation(refused);
    const wrong = await call(refused, "DELETE", "/account", {
      removal: cookie,
      body: { code: "code_not_the_one_confirmed", ...ANSWERS },
    });
    expect(wrong.status).toBe(403);
    untouched(refused.db);

    const down = await setup({
      bridgeOverrides: {
        verify: async () => {
          throw new Error("osn-api unreachable");
        },
      },
    });
    const downCookie = await confirmation(down);
    expect((await remove(down, downCookie, ANSWERS)).status).toBe(503);
    untouched(down.db);

    const keyless = await setup({ accountRemovalBridge: undefined });
    expect((await call(keyless, "POST", "/account/removal/confirmation")).status).toBe(503);
    expect((await remove(keyless, `cire_removal=${REQUEST}.${CODE}`, ANSWERS)).status).toBe(503);
    untouched(keyless.db);
  });

  it("C4: a confirmed account that is not the signed-in profile's is refused", async () => {
    const h = await setup({
      bridgeOverrides: { resolveAccount: async () => ({ ok: true, accountId: OTHER_ACCOUNT }) },
    });
    const cookie = await confirmation(h);
    const res = await remove(h, cookie, ANSWERS);
    expect(res.status).toBe(403);
    untouched(h.db);
  });

  it("C5: a wedding the person's other profile alone owns needs its answer too, and is listed", async () => {
    const h = await setup();
    const cookie = await confirmation(h);
    const res = await remove(h, cookie, { choices: { "cire:wedding:w_alone": "delete" } });
    expect(res.status).toBe(409);
    const body = (await jsonBody(res)) as {
      error: string;
      openActions: { id: string; weddingId: string | null }[];
      weddings: { weddingId: string; soleOwner: boolean }[];
    };
    expect(body.error).toBe("open_actions");
    expect(body.openActions.map((a) => a.weddingId).toSorted()).toEqual(["w_alone", "w_sibling"]);
    expect(body.weddings.find((w) => w.weddingId === "w_sibling")?.soleOwner).toBe(true);
    expect(body.weddings.some((w) => w.weddingId === "w_theirs")).toBe(false);
    // No answers at all is the same refusal, never an error.
    expect((await remove(h, cookie, {})).status).toBe(409);
    untouched(h.db);
  });

  it("C14: the routes share one per-person limit, and a refused call asks osn-api nothing", async () => {
    const h = await setup({
      accountRemovalLimiter: createRateLimiter({ maxRequests: 1, windowMs: 60_000 }),
    });
    expect((await call(h, "POST", "/account/removal/preview", { body: {} })).status).toBe(200);
    expect((await call(h, "POST", "/account/removal/confirmation")).status).toBe(429);
    expect(h.log.begun).toEqual([]);
    expect(h.log.verified).toEqual([]);
  });

  it("C15: a database fault answers 500 on the preview and the removal, and removes nothing", async () => {
    const h = await setup();
    const cookie = await confirmation(h);
    const before = await counterValue(CIRE_METRICS.accountRemovalRequests, { result: "error" });
    h.db.run(sql`DROP TABLE host_rsvp_notices`);
    const preview = await call(h, "POST", "/account/removal/preview", { body: {} });
    expect(preview.status).toBe(200);
    const removal = await remove(h, cookie, ANSWERS);
    expect({ status: removal.status, body: await jsonBody(removal) }).toEqual({
      status: 500,
      body: { error: "Internal error" },
    });
    expect(await counterValue(CIRE_METRICS.accountRemovalRequests, { result: "error" })).toBe(
      before + 1,
    );
    h.db.run(sql`DROP TABLE wedding_hosts`);
    const broken = await call(h, "POST", "/account/removal/preview", { body: {} });
    expect({ status: broken.status, body: await jsonBody(broken) }).toEqual({
      status: 500,
      body: { error: "Internal error" },
    });
  });
});

/**
 * The person who connected a wedding's Stripe account holds it in their own
 * name. While they sit there as an owner beside another owner, removing their
 * Cire data would leave the couple's money gifts paid into the account of
 * someone who no longer runs the wedding, so the removal is refused until they
 * hand the account over or disconnect it. The owner weighed that this holds
 * up a request to erase data, and chose it.
 */
describe("a host's removal of their Cire data: the holder of a payout account", () => {
  /** `weddingId`'s settings name a Stripe account `profile` connected. */
  function holds(db: TestDb, weddingId: string, profile: string) {
    const now = new Date();
    db.insert(registrySettings)
      .values({
        weddingId,
        stripeAccountId: `acct_${weddingId}`,
        stripeConnectedByOsnProfileId: profile,
        createdAt: now,
        updatedAt: now,
      })
      .run();
  }

  const connectorOf = (db: TestDb, weddingId: string) =>
    db
      .select({ connector: registrySettings.stripeConnectedByOsnProfileId })
      .from(registrySettings)
      .where(eq(registrySettings.weddingId, weddingId))
      .get()?.connector;

  it("H1: refuses while the person holds a shared wedding's account as an owner, saying how to go on, and removes nothing", async () => {
    const h = await setup();
    holds(h.db, "w_shared", P);
    const cookie = await confirmation(h);
    const before = await counterValue(CIRE_METRICS.accountRemovalRequests, {
      result: "holds_payout_account",
    });
    let res: Response | undefined;
    const logs = await captureLogs(async () => {
      res = await remove(h, cookie, ANSWERS);
    });

    expect(res!.status).toBe(409);
    const body = (await jsonBody(res!)) as {
      error: string;
      message: string;
      weddings: { weddingId: string; name: string }[];
    };
    // Exactly these keys: the wedding by its id and name, which the person
    // sees as one of its owners, and nothing about anyone else.
    expect(Object.keys(body).toSorted()).toEqual(["error", "message", "weddings"]);
    expect(body.error).toBe("holds_payout_account");
    expect(body.weddings).toEqual([{ weddingId: "w_shared", name: "Shared" }]);
    expect(body.message).toContain("hand money gifts to another owner");
    expect(body.message).toContain("disconnect");
    expect(body.message).toContain("Money gifts");
    untouched(h.db);
    expect(connectorOf(h.db, "w_shared")).toBe(P);
    expect(seatsOf(h.db, "w_alone")).toEqual([{ profile: P, role: "owner" }]);

    expect(
      await counterValue(CIRE_METRICS.accountRemovalRequests, { result: "holds_payout_account" }),
    ).toBe(before + 1);
    expect(logs).toContain("account removal refused: holds payout account");
    for (const named of ["w_shared", "Shared", P, P2, O, ACCOUNT]) {
      expect(logs).not.toContain(named);
    }
  });

  it("H1b: refuses when the account's other profile holds it", async () => {
    const h = await setup();
    seat(h.db, "w_theirs", P2, "owner");
    holds(h.db, "w_theirs", P2);
    const cookie = await confirmation(h);
    const res = await remove(h, cookie, ANSWERS);
    expect(res.status).toBe(409);
    expect(((await jsonBody(res)) as { weddings: unknown }).weddings).toEqual([
      { weddingId: "w_theirs", name: "Theirs" },
    ]);
    untouched(h.db);
  });

  it("H1c: the preview marks the wedding whose account the person holds, as it marks one they alone own", async () => {
    const h = await setup();
    holds(h.db, "w_shared", P);
    holds(h.db, "w_theirs", O);
    const res = await call(h, "POST", "/account/removal/preview", { body: {} });
    expect(res.status).toBe(200);
    const listed = (
      (await jsonBody(res)) as {
        weddings: { weddingId: string; payoutHolder: boolean }[];
      }
    ).weddings;
    expect(Object.fromEntries(listed.map((w) => [w.weddingId, w.payoutHolder]))).toEqual({
      w_alone: false,
      w_shared: true,
      w_theirs_edit: false,
    });
  });

  it("H1d: an account connected after the route's read keeps the holder's seat; the portal's next call is refused", async () => {
    const store = memoryDeletionRecordStore();
    const h = await setup({ deletionRecords: store });
    // The account's other profile has a lower seat on the shared wedding,
    // which goes in that wedding's batch.
    seat(h.db, "w_shared", P2, "viewer");
    const cookie = await confirmation(h);
    // The route's read finds nothing held; the person connects the shared
    // wedding's account before its batch runs.
    beforeStatement(h.db, /^update "weddings" set "deleted_at"/i, () => holds(h.db, "w_shared", P));

    const first = await remove(h, cookie, ANSWERS);
    expect(first.status).toBe(202);
    expect(seatsOf(h.db, "w_shared")).toEqual([
      { profile: O, role: "owner" },
      { profile: P, role: "owner" },
    ]);
    expect(connectorOf(h.db, "w_shared")).toBe(P);
    // The shared wedding's tabs re-read its members, and the holder, who
    // keeps a seat there, keeps listening.
    expect(h.signalled.find((sig) => sig.topic === "cire:wedding:w_shared")?.revoked).toEqual([]);
    // Only the weddings this call took a seat from are signalled.
    expect(h.signalled.map((sig) => sig.topic).toSorted()).toEqual(
      ["w_alone", "w_shared", "w_sibling"].map((id) => `cire:wedding:${id}`),
    );
    // Its record lists the second profile's seat on the shared wedding and
    // not the holder's: a replay takes the one and keeps the other.
    expect(store.records()).toHaveLength(1);
    expect(outcomeOf(store.records()[0])).toEqual({
      deletedWeddings: ["w_alone", "w_sibling"],
      removedSeats: seatsList(["w_alone", P], ["w_sibling", P2], ["w_shared", P2]),
      unsettledWeddings: [],
      cleanUp: "not_run",
      finished: false,
    });
    // The account's clean-up never ran: the person is still signed in.
    expect(sessionsOf(h.db, P)).toBe(1);
    expect(sessionsOf(h.db, O)).toBe(1);
    expect(seatsOf(h.db, "w_theirs")).toEqual([{ profile: O, role: "owner" }]);

    const next = await remove(h, cookie, ANSWERS);
    expect(next.status).toBe(409);
    expect(((await jsonBody(next)) as { weddings: unknown }).weddings).toEqual([
      { weddingId: "w_shared", name: "Shared" },
    ]);
  });

  it("H1e: a removal the payout race stops keeps its record when it removed a seat, and drops it when it removed none", async () => {
    // Part way: the other weddings' seats went before the shared one's batch.
    const partStore = memoryDeletionRecordStore();
    const part = await setup({ deletionRecords: partStore });
    const partCookie = await confirmation(part);
    beforeStatement(part.db, /^update "weddings" set "deleted_at"/i, () =>
      holds(part.db, "w_shared", P),
    );
    expect((await remove(part, partCookie, ANSWERS)).status).toBe(202);
    expect(seatsOf(part.db, "w_alone")).toEqual([]);
    // It says what the call did: a replay deletes the two it deleted, takes
    // no seat on the shared one, and runs no clean-up.
    expect(partStore.records().map(({ kind }) => kind)).toEqual(["organiser_data_removed"]);
    expect(outcomeOf(partStore.records()[0])).toEqual({
      deletedWeddings: ["w_alone", "w_sibling"],
      removedSeats: seatsList(["w_alone", P], ["w_sibling", P2]),
      unsettledWeddings: [],
      cleanUp: "not_run",
      finished: false,
    });

    // Nothing: the shared wedding is the only one the account owns, and the
    // guard keeps its seat.
    const noneStore = memoryDeletionRecordStore();
    const none = await setup({ deletionRecords: noneStore });
    none.db
      .delete(weddingHosts)
      .where(inArray(weddingHosts.weddingId, ["w_alone", "w_sibling"]))
      .run();
    const noneCookie = await confirmation(none);
    beforeStatement(none.db, /^update "weddings" set "deleted_at"/i, () =>
      holds(none.db, "w_shared", P),
    );
    expect((await remove(none, noneCookie, {})).status).toBe(202);
    expect(seatsOf(none.db, "w_shared")).toEqual([
      { profile: O, role: "owner" },
      { profile: P, role: "owner" },
    ]);
    expect(noneStore.records()).toEqual([]);
  });

  it("H1g: a record the store fails to drop still answers 202, and is logged by its key alone", async () => {
    const memory = memoryDeletionRecordStore();
    const keys: string[] = [];
    const store: DeletionRecordStore = {
      ...memory,
      write: (record) =>
        memory.write(record).pipe(Effect.tap(({ key }) => Effect.sync(() => keys.push(key)))),
      discard: ({ kind, key }) =>
        Effect.fail(new DeletionRecordWriteError({ kind, reason: "failed", key })),
    };
    const h = await setup({ deletionRecords: store });
    h.db
      .delete(weddingHosts)
      .where(inArray(weddingHosts.weddingId, ["w_alone", "w_sibling"]))
      .run();
    const cookie = await confirmation(h);
    beforeStatement(h.db, /^update "weddings" set "deleted_at"/i, () => holds(h.db, "w_shared", P));
    let res: Response | undefined;
    const logs = await captureLogs(async () => {
      res = await remove(h, cookie, {});
    });

    expect(res!.status).toBe(202);
    const [record] = memory.records();
    expect(record?.kind).toBe("organiser_data_removed");
    expect(keys).toHaveLength(1);
    expect(logs).toContain("deletion record settle failed");
    expect(logs).toContain("kind: organiser_data_removed");
    expect(logs).toContain("reason: failed");
    expect(logs).toContain(`key: ${keys[0]}`);
    for (const named of [P, P2, O, ACCOUNT, "w_shared"]) {
      expect(logs).not.toContain(named);
    }
  });

  it("H1i: a seat below owner promoted before the batch does not hide the holder's kept seat", async () => {
    const h = await setup();
    seat(h.db, "w_shared", P2, "viewer");
    const cookie = await confirmation(h);
    // After the call's first read, the second profile is made an owner and
    // the person connects the shared wedding's payout account.
    beforeStatement(h.db, /^update "weddings" set "deleted_at"/i, () => {
      holds(h.db, "w_shared", P);
      h.db
        .update(weddingHosts)
        .set({ role: "owner" })
        .where(and(eq(weddingHosts.weddingId, "w_shared"), eq(weddingHosts.osnProfileId, P2)))
        .run();
    });
    expect((await remove(h, cookie, ANSWERS)).status).toBe(202);
    // The holder keeps their seat, and the call stops before the account's
    // clean-up: the holder keeps listening on the wedding, and the person's
    // seat below owner elsewhere is still there.
    expect(seatsOf(h.db, "w_shared")).toEqual([
      { profile: O, role: "owner" },
      { profile: P, role: "owner" },
    ]);
    expect(h.signalled.find((sig) => sig.topic === "cire:wedding:w_shared")?.revoked).toEqual([]);
    expect(seatsOf(h.db, "w_theirs_edit")).toEqual([
      { profile: O, role: "owner" },
      { profile: P, role: "editor" },
    ]);
  });

  it("H1j: a seat below owner another request took before the batch does not read as kept", async () => {
    const h = await setup();
    seat(h.db, "w_shared", P2, "viewer");
    const cookie = await confirmation(h);
    beforeStatement(h.db, /^update "weddings" set "deleted_at"/i, () =>
      h.db
        .delete(weddingHosts)
        .where(and(eq(weddingHosts.weddingId, "w_shared"), eq(weddingHosts.osnProfileId, P2)))
        .run(),
    );
    expect((await remove(h, cookie, ANSWERS)).status).toBe(200);
    expect(seatsOf(h.db, "w_shared")).toEqual([{ profile: O, role: "owner" }]);
  });

  it("H1h: an owner seat another request demoted before the batch is listed as removed, not as kept", async () => {
    const store = memoryDeletionRecordStore();
    const h = await setup({ deletionRecords: store });
    seat(h.db, "w_shared", P2, "owner");
    const cookie = await confirmation(h);
    // Another request demotes the second profile's owner seat between the
    // call's first read and the shared wedding's batch.
    beforeStatement(h.db, /^update "weddings" set "deleted_at"/i, () =>
      h.db
        .update(weddingHosts)
        .set({ role: "viewer" })
        .where(and(eq(weddingHosts.weddingId, "w_shared"), eq(weddingHosts.osnProfileId, P2)))
        .run(),
    );
    // Both seats the first read found went, so nothing reads as kept and the
    // removal finishes.
    expect((await remove(h, cookie, ANSWERS)).status).toBe(200);
    expect(seatsOf(h.db, "w_shared")).toEqual([{ profile: O, role: "owner" }]);
    // Both of the account's seats there went, and the record lists both.
    expect(outcomeOf(store.records()[0])).toEqual({
      deletedWeddings: ["w_alone", "w_sibling"],
      removedSeats: seatsList(
        ["w_alone", P],
        ["w_sibling", P2],
        ["w_shared", P],
        ["w_shared", P2],
        ["w_theirs_edit", P],
      ),
      unsettledWeddings: [],
      cleanUp: "done",
      finished: true,
    });
  });

  it("H1f: a removal for an account that owns no wedding keeps its record", async () => {
    // Only the lower seat on someone else's wedding is left to remove.
    const store = memoryDeletionRecordStore();
    const h = await setup({ deletionRecords: store });
    h.db
      .delete(weddingHosts)
      .where(inArray(weddingHosts.weddingId, ["w_alone", "w_sibling", "w_shared"]))
      .run();
    expect((await remove(h, await confirmation(h), {})).status).toBe(200);
    expect(seatsOf(h.db, "w_theirs_edit")).toEqual([{ profile: O, role: "owner" }]);
    expect(store.records().map(({ kind }) => kind)).toEqual(["organiser_data_removed"]);
  });

  it("H2: asks for the confirmation first, and names the holder ahead of unanswered weddings", async () => {
    const h = await setup();
    holds(h.db, "w_shared", P);
    // No confirmation cookie: refused before anything is read.
    expect((await remove(h, null, ANSWERS)).status).toBe(403);

    const cookie = await confirmation(h);
    const res = await remove(h, cookie, {});
    expect(res.status).toBe(409);
    expect(((await jsonBody(res)) as { error: string }).error).toBe("holds_payout_account");
    untouched(h.db);
  });

  it("H3: refuses no one who holds no account there as an owner beside another", async () => {
    // Someone else holds the shared wedding's account.
    const theirs = await setup();
    holds(theirs.db, "w_shared", O);
    expect((await remove(theirs, await confirmation(theirs), ANSWERS)).status).toBe(200);
    expect(seatsOf(theirs.db, "w_shared")).toEqual([{ profile: O, role: "owner" }]);
    expect(connectorOf(theirs.db, "w_shared")).toBe(O);

    // The person holds the account of a wedding they alone own, which goes
    // with the removal; of one they sit below owner on, already closed to
    // money; and of a deleted one.
    const own = await setup();
    holds(own.db, "w_alone", P);
    holds(own.db, "w_theirs_edit", P);
    holds(own.db, "w_shared", P);
    own.db.update(weddings).set({ deletedAt: new Date() }).where(eq(weddings.id, "w_shared")).run();
    expect((await remove(own, await confirmation(own), ANSWERS)).status).toBe(200);
    expect(seatsOf(own.db, "w_alone")).toEqual([]);
    expect(deletedAt(own.db, "w_alone")).not.toBeNull();
    expect(seatsOf(own.db, "w_theirs_edit")).toEqual([{ profile: O, role: "owner" }]);
    expect(seatsOf(own.db, "w_shared")).toEqual([{ profile: O, role: "owner" }]);
  });
});

describe("a host's removal of their Cire data: what it removes", () => {
  it("C6: removes every seat of both profiles, deletes the weddings left with no owner, ends the person's sessions, and touches no one else's", async () => {
    const h = await setup();
    // What a host keeps when they leave: a vendor listing they claimed, and
    // their link as a guest to their account.
    h.db
      .insert(directoryVendors)
      .values({
        id: "dv_mine",
        name: "Florist",
        claimedByProfileId: P,
        reviewProfileId: P,
        reviewOrgId: "org_mine",
        reviewRequestedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .run();
    // A wedding of someone else's where the person is a guest, linked.
    for (const statement of fullWeddingStatements("wed_guest", { owner: O, now: new Date() })) {
      h.db.run(statement);
    }
    h.db.run(
      sql.raw(
        `UPDATE guest_account_links SET osn_account_id = '${ACCOUNT}', osn_profile_id = '${P}' WHERE id = 'gal_wed_guest'`,
      ),
    );
    const doneBefore = await counterValue(CIRE_METRICS.accountRemovalRequests, { result: "done" });
    const cookie = await confirmation(h);
    const res = await remove(h, cookie, ANSWERS);

    expect(res.status).toBe(200);
    expect(await jsonBody(res)).toEqual({ status: "done" });
    const cleared = res.headers.getSetCookie();
    expect(cleared.some((c) => c.startsWith("cire_org_session=;") && /Max-Age=0/i.test(c))).toBe(
      true,
    );
    expect(cleared.some((c) => c.startsWith("cire_removal=;") && /Max-Age=0/i.test(c))).toBe(true);
    expect(await counterValue(CIRE_METRICS.accountRemovalRequests, { result: "done" })).toBe(
      doneBefore + 1,
    );
    // The host scope: the vendor listing's claim and review stay.
    const listing = h.db
      .select()
      .from(directoryVendors)
      .where(eq(directoryVendors.id, "dv_mine"))
      .get();
    expect([listing?.claimedByProfileId, listing?.reviewProfileId]).toEqual([P, P]);
    expect(
      h.db.select().from(guestAccountLinks).where(eq(guestAccountLinks.osnProfileId, P)).all(),
    ).toHaveLength(1);
    // Each wedding a seat went from is signalled, closing both profiles' sockets.
    expect(h.signalled.map((sig) => sig.topic).toSorted()).toEqual(
      ["w_alone", "w_shared", "w_sibling", "w_theirs_edit"].map((id) => `cire:wedding:${id}`),
    );
    expect(h.signalled.every((sig) => sig.revoked.join() === [P, P2].toSorted().join())).toBe(true);

    expect(deletedAt(h.db, "w_alone")).not.toBeNull();
    expect(deletedAt(h.db, "w_sibling")).not.toBeNull();
    expect(seatsOf(h.db, "w_alone")).toEqual([]);
    expect(seatsOf(h.db, "w_sibling")).toEqual([]);
    expect(deletedAt(h.db, "w_shared")).toBeNull();
    expect(seatsOf(h.db, "w_shared")).toEqual([{ profile: O, role: "owner" }]);
    expect(seatsOf(h.db, "w_theirs_edit")).toEqual([{ profile: O, role: "owner" }]);
    expect(sessionsOf(h.db, P)).toBe(0);

    // The other person's weddings, seats and session.
    expect(deletedAt(h.db, "w_theirs")).toBeNull();
    expect(seatsOf(h.db, "w_theirs")).toEqual([{ profile: O, role: "owner" }]);
    expect(sessionsOf(h.db, O)).toBe(1);
  });

  it("C7: deleteEverything answers every wedding the person alone owns", async () => {
    const h = await setup();
    const cookie = await confirmation(h);
    const res = await remove(h, cookie, { deleteEverything: true });
    expect(res.status).toBe(200);
    expect(deletedAt(h.db, "w_alone")).not.toBeNull();
    expect(deletedAt(h.db, "w_sibling")).not.toBeNull();
    expect(deletedAt(h.db, "w_theirs")).toBeNull();
  });

  it("C8: past three owned weddings it answers not finished, and the same confirmation finishes it", async () => {
    const h = await setup();
    for (let i = 0; i < MAX_OWNED_WEDDINGS_PER_CALL; i += 1) {
      insertWedding(h.db, {
        id: `w_more_${i}`,
        slug: `slug-more-${i}`,
        displayName: `More ${i}`,
        owners: [P, O],
        createdAt: new Date(Date.now() - 86_400_000),
      });
    }
    const cookie = await confirmation(h);

    const first = await remove(h, cookie, ANSWERS);
    expect(first.status).toBe(202);
    expect(await jsonBody(first)).toEqual({ status: "not_finished" });
    expect(sessionsOf(h.db, P)).toBe(1);
    // Only the weddings this call took are signalled; the lower seat waits.
    expect(h.signalled).toHaveLength(MAX_OWNED_WEDDINGS_PER_CALL);
    expect(h.signalled.some((sig) => sig.topic === "cire:wedding:w_theirs_edit")).toBe(false);

    const second = await remove(h, cookie, ANSWERS);
    expect(second.status).toBe(200);
    expect(h.signalled.some((sig) => sig.topic === "cire:wedding:w_theirs_edit")).toBe(true);
    for (let i = 0; i < MAX_OWNED_WEDDINGS_PER_CALL; i += 1) {
      expect(seatsOf(h.db, `w_more_${i}`)).toEqual([{ profile: O, role: "owner" }]);
    }
    expect(seatsOf(h.db, "w_theirs")).toEqual([{ profile: O, role: "owner" }]);
    expect(sessionsOf(h.db, O)).toBe(1);
  });

  it("C9: the owner who stays on a shared wedding is told the person left; the person is not; no budget row names them", async () => {
    const h = await setup();
    const cookie = await confirmation(h);
    expect((await remove(h, cookie, ANSWERS)).status).toBe(200);

    const sent = h.mail.recorded();
    expect(sent.map((m) => m.to)).toEqual(["other@example.test"]);
    expect(sent[0]?.template).toBe("wedding-owner-change");
    expect(sent[0]?.text).toContain("Pat Person (@person) left Shared");
    const keys = h.db
      .select({ key: ownerNoticeBudget.key })
      .from(ownerNoticeBudget)
      .all()
      .map((r) => r.key);
    expect(keys.filter((key) => key.includes(P))).toEqual([]);
    expect(keys).toContain("wedding:w_shared");
  });

  it("C9b: a wedding a sibling profile shared is told that profile left, never the signed-in one", async () => {
    // Red on naming the profile that asked: the other owners would learn the
    // two profiles are one person.
    const h = await setup();
    insertWedding(h.db, {
      id: "w_sibling_shared",
      slug: "slug-w_sibling_shared",
      displayName: "Sibling Shared",
      owners: [P2, O],
      createdAt: new Date(Date.now() - 86_400_000),
    });
    // The signed-in profile holds a lower seat there too: it left no owner's
    // seat, so no notice names it.
    seat(h.db, "w_sibling_shared", P, "editor");
    const cookie = await confirmation(h);
    // Four owned weddings: a second call finishes.
    expect((await remove(h, cookie, ANSWERS)).status).toBe(202);
    expect((await remove(h, cookie, ANSWERS)).status).toBe(200);
    const told = h.mail.recorded().filter((m) => m.text?.includes("Sibling Shared"));
    expect(told.map((m) => m.to)).toEqual(["other@example.test"]);
    expect(told[0]?.text).toContain("Sam Second (@second) left Sibling Shared");
    expect(told[0]?.text).not.toContain("Pat Person");
  });

  it("C13: the worst case, three owned weddings each told to another owner, stays inside 50 D1 statements", async () => {
    const h = await setup();
    // Three owned weddings, each shared, so each sends a notice.
    h.db.delete(weddingHosts).where(eq(weddingHosts.osnProfileId, P2)).run();
    h.db.delete(weddingHosts).where(eq(weddingHosts.weddingId, "w_alone")).run();
    seat(h.db, "w_alone", O, "owner");
    seat(h.db, "w_alone", P, "owner");
    seat(h.db, "w_sibling", O, "owner");
    seat(h.db, "w_sibling", P, "owner");
    const cookie = await confirmation(h);
    const statements = recordStatements(h.db);
    const res = await remove(h, cookie, {});
    expect(res.status).toBe(200);
    expect(h.mail.recorded()).toHaveLength(3);
    expect(statements.length).toBeLessThanOrEqual(50);
  });

  it("C13b: three owned weddings each owned by both of the account's profiles, so six notices, stays inside 50 D1 statements", async () => {
    const h = await setup();
    h.db.delete(weddingHosts).where(eq(weddingHosts.weddingId, "w_alone")).run();
    h.db.delete(weddingHosts).where(eq(weddingHosts.weddingId, "w_sibling")).run();
    h.db.delete(weddingHosts).where(eq(weddingHosts.weddingId, "w_shared")).run();
    for (const id of ["w_alone", "w_sibling", "w_shared"]) {
      seat(h.db, id, O, "owner");
      seat(h.db, id, P, "owner");
      seat(h.db, id, P2, "owner");
    }
    const cookie = await confirmation(h);
    const statements = recordStatements(h.db);
    const res = await remove(h, cookie, {});
    expect(res.status).toBe(200);
    expect(h.mail.recorded()).toHaveLength(6);
    expect(statements.length).toBeLessThanOrEqual(50);
  });
});

describe("a host's removal of their Cire data: the preview and the confirmation", () => {
  it("C10: before confirming, the signed-in profile's weddings; after, every profile's; never anyone else's", async () => {
    const h = await setup();
    const before = await call(h, "POST", "/account/removal/preview", { body: {} });
    expect(before.status).toBe(200);
    const unconfirmed = (await jsonBody(before)) as {
      weddings: { weddingId: string; role: string; soleOwner: boolean; deleted: boolean }[];
      confirmed: boolean;
    };
    expect(unconfirmed.confirmed).toBe(false);
    expect(unconfirmed.weddings.map((w) => [w.weddingId, w.role, w.soleOwner])).toEqual([
      ["w_alone", "owner", true],
      ["w_shared", "owner", false],
      ["w_theirs_edit", "editor", false],
    ]);

    const cookie = await confirmation(h);
    const after = await call(h, "POST", "/account/removal/preview", {
      removal: cookie,
      body: { code: CODE },
    });
    const confirmed = (await jsonBody(after)) as {
      weddings: { weddingId: string }[];
      openActions: { id: string }[];
      confirmed: boolean;
    };
    expect(confirmed.confirmed).toBe(true);
    expect(confirmed.weddings.map((w) => w.weddingId)).toEqual([
      "w_alone",
      "w_shared",
      "w_sibling",
      "w_theirs_edit",
    ]);
    expect(confirmed.openActions.map((a) => a.id).toSorted()).toEqual([
      "cire:wedding:w_alone",
      "cire:wedding:w_sibling",
    ]);
  });

  it("C10b: a code osn-api refuses, or a code with no cookie, lists only the signed-in profile's weddings; osn-api down is 503", async () => {
    // Red on the preview widening to every profile before a confirmation holds.
    const h = await setup();
    const cookie = await confirmation(h);
    for (const opts of [
      { removal: cookie, body: { code: "code_not_the_one_confirmed" } },
      { body: { code: CODE } },
    ]) {
      const res = await call(h, "POST", "/account/removal/preview", opts);
      const answer = (await jsonBody(res)) as {
        weddings: { weddingId: string }[];
        confirmed: boolean;
      };
      expect(answer.confirmed).toBe(false);
      expect(answer.weddings.map((w) => w.weddingId)).toEqual([
        "w_alone",
        "w_shared",
        "w_theirs_edit",
      ]);
    }
    const down = await setup({
      bridgeOverrides: {
        verify: async () => {
          throw new Error("osn-api unreachable");
        },
      },
    });
    const downCookie = await confirmation(down);
    const res = await call(down, "POST", "/account/removal/preview", {
      removal: downCookie,
      body: { code: CODE },
    });
    expect({ status: res.status, body: await jsonBody(res) }).toEqual({
      status: 503,
      body: { error: "unavailable" },
    });
  });

  it("C11b: a confirmation osn-api will not begin binds nothing to the browser", async () => {
    for (const [begin, status, error] of [
      [async () => ({ ok: false, reason: "not_found" }) as const, 409, "account_unavailable"],
      [async () => ({ ok: false, reason: "refused" }) as const, 503, "unavailable"],
      [
        async () => {
          throw new Error("osn-api unreachable");
        },
        503,
        "unavailable",
      ],
      [async () => ({ ok: true, requestId: "bad id!" }) as const, 503, "unavailable"],
    ] as const) {
      const h = await setup({ bridgeOverrides: { begin } });
      const res = await call(h, "POST", "/account/removal/confirmation");
      expect({
        status: res.status,
        body: await jsonBody(res),
        cookie: res.headers.get("set-cookie"),
      }).toEqual({
        status,
        body: { error },
        cookie: null,
      });
    }
  });

  it("C11c: on an https tier the cookie is __Host-prefixed and Secure, lasts 15 minutes, and is cleared the same way", async () => {
    // The origin guard admits the app's own web origin.
    const SITE = "https://invites.example.test";
    const h = await setup({ webOrigin: SITE });
    const res = await call(h, "POST", "/account/removal/confirmation", { origin: SITE });
    const set = res.headers.get("set-cookie") ?? "";
    expect(set).toMatch(/^__Host-cire_removal=/);
    for (const attribute of [
      /; Secure/,
      /; HttpOnly/,
      /; SameSite=Lax/,
      /; Path=\//,
      /; Max-Age=900/,
    ]) {
      expect(set).toMatch(attribute);
    }
    // The plain name is not read on an https tier.
    const plain = `cire_removal=${set.split(";")[0]!.split("=")[1]}`;
    const removeFrom = (removal: string) =>
      call(h, "DELETE", "/account", { removal, body: { code: CODE, ...ANSWERS }, origin: SITE });
    expect((await removeFrom(plain)).status).toBe(403);
    const removed = await removeFrom(set.split(";")[0]!);
    expect(removed.status).toBe(200);
    const cleared = removed.headers
      .getSetCookie()
      .find((c) => c.startsWith("__Host-cire_removal=;"));
    for (const attribute of [
      /; Secure/,
      /; HttpOnly/,
      /; SameSite=Lax/,
      /; Path=\//,
      /Max-Age=0/,
    ]) {
      expect(cleared).toMatch(attribute);
    }
    // A clear without `Secure` cannot replace the session cookie set with it.
    const session = removed.headers.getSetCookie().find((c) => c.startsWith("cire_org_session=;"));
    expect(session).toMatch(/; Secure/);
    expect(session).toMatch(/Max-Age=0/);
  });

  it("C11: the confirmation keeps its secret in an HttpOnly cookie and sends osn-api only its hash, and the portal's own return address", async () => {
    const h = await setup();
    const res = await call(h, "POST", "/account/removal/confirmation");
    expect(await jsonBody(res)).toEqual({ requestId: REQUEST });
    const set = res.headers.get("set-cookie") ?? "";
    expect(set).toMatch(/^cire_removal=/);
    expect(set).toMatch(/HttpOnly/);
    expect(set).toMatch(/SameSite=Lax/);
    const [requestId, secret] = set.split(";")[0]!.slice("cire_removal=".length).split(".");
    expect(requestId).toBe(REQUEST);
    expect(h.log.begun).toEqual([
      { profileId: P, binding: sha256(secret!), returnTo: `${PORTAL}/#/remove-data` },
    ]);
    expect(JSON.stringify(h.log.begun)).not.toContain(secret!);
  });
});

/**
 * A removal is recorded outside the database once it is accepted and before
 * anything is erased (`lib/deletion-records.ts`), with the weddings the person
 * answered `delete` for, so a D1 restore cannot lose it. The other account's
 * weddings, seats and sessions are checked untouched each time.
 */
describe("a host's removal of their Cire data: the deletion record", () => {
  it("records the removal it accepts: the account, its profiles, and the weddings answered delete", async () => {
    const store = memoryDeletionRecordStore();
    const h = await setup({ deletionRecords: store });
    const res = await remove(h, await confirmation(h), ANSWERS);
    expect(res.status).toBe(200);
    const [record, ...rest] = store.records();
    expect(rest).toEqual([]);
    const removed = record as Removal;
    expect({
      ...removed,
      profileIds: removed.profileIds.toSorted(),
      deleteActions: removed.deleteActions.toSorted(),
      outcome: outcomeOf(removed),
    }).toEqual({
      v: 1,
      kind: "organiser_data_removed",
      at: expect.any(Number),
      accountId: ACCOUNT,
      profileIds: [P, P2].toSorted(),
      deleteEverything: false,
      deleteActions: ["cire:wedding:w_alone", "cire:wedding:w_sibling"],
      outcome: {
        deletedWeddings: ["w_alone", "w_sibling"],
        // The clean-up's seat below owner is listed beside the weddings'.
        removedSeats: seatsList(
          ["w_alone", P],
          ["w_sibling", P2],
          ["w_shared", P],
          ["w_theirs_edit", P],
        ),
        unsettledWeddings: [],
        cleanUp: "done",
        finished: true,
      },
    });
    expect(JSON.stringify(store.records())).not.toContain(O);
    expect(deletedAt(h.db, "w_theirs")).toBeNull();
    expect(sessionsOf(h.db, O)).toBe(1);
  });

  it("records delete everything as the person answered it", async () => {
    const store = memoryDeletionRecordStore();
    const h = await setup({ deletionRecords: store });
    expect((await remove(h, await confirmation(h), { deleteEverything: true })).status).toBe(200);
    expect(store.records()).toEqual([expect.objectContaining({ deleteEverything: true })]);
  });

  it("records what a removal that fails part way did before it failed", async () => {
    const store = memoryDeletionRecordStore();
    const h = await setup({ deletionRecords: store });
    const cookie = await confirmation(h);
    // Every wedding's batch commits; the account's clean-up then fails.
    const failing = failStatements(h.db, (statement) =>
      /^delete from "registry_stripe_oauth_states"/i.test(statement),
    );
    const res = await remove(h, cookie, ANSWERS);
    failing.restore();
    expect(res.status).toBe(500);
    expect(failing.failed()).toBeGreaterThan(0);
    expect(deletedAt(h.db, "w_alone")).not.toBeNull();
    const [record, ...rest] = store.records();
    expect(rest).toEqual([]);
    expect(outcomeOf(record)).toEqual({
      deletedWeddings: ["w_alone", "w_sibling"],
      removedSeats: seatsList(["w_alone", P], ["w_sibling", P2], ["w_shared", P]),
      unsettledWeddings: [],
      // The clean-up's batch was sent when the call failed.
      cleanUp: "unsettled",
      finished: false,
    });
  });

  it("records a clean-up that ran on a call an owner seat made since its first read leaves unfinished", async () => {
    const store = memoryDeletionRecordStore();
    const h = await setup({ deletionRecords: store });
    seat(h.db, "w_theirs", P2, "viewer");
    const cookie = await confirmation(h);
    // Just before the account's clean-up, another request makes the person
    // an owner of the wedding they sat on as an editor.
    beforeStatement(
      h.db,
      /^delete from "host_rsvp_notices" where \(\("host_rsvp_notices"."osn_profile_id" in/i,
      () =>
        h.db
          .update(weddingHosts)
          .set({ role: "owner" })
          .where(and(eq(weddingHosts.weddingId, "w_theirs_edit"), eq(weddingHosts.osnProfileId, P)))
          .run(),
    );
    expect((await remove(h, cookie, ANSWERS)).status).toBe(202);
    // The clean-up committed: the second profile's seat below owner is gone.
    expect(seatsOf(h.db, "w_theirs")).toEqual([{ profile: O, role: "owner" }]);
    expect(outcomeOf(store.records()[0])).toEqual({
      deletedWeddings: ["w_alone", "w_sibling"],
      // The seat below owner the clean-up took is listed; the seat made owner
      // before it, which the call kept, is not.
      removedSeats: seatsList(["w_alone", P], ["w_sibling", P2], ["w_shared", P], ["w_theirs", P2]),
      unsettledWeddings: [],
      // A replay runs this call's clean-up, though the erasure did not finish.
      cleanUp: "done",
      finished: false,
    });
  });

  it("takes seats below owner a bounded share at a time, keeping the session for the next call", async () => {
    const store = memoryDeletionRecordStore();
    const h = await setup({ deletionRecords: store });
    for (let i = 0; i <= MAX_LOWER_SEATS_PER_CALL; i += 1) {
      const id = `wv${i}`;
      insertWedding(h.db, { id, slug: `slug-${id}`, displayName: id, owners: [O] });
      seat(h.db, id, P2, "viewer");
    }
    const cookie = await confirmation(h);
    expect((await remove(h, cookie, ANSWERS)).status).toBe(202);
    // Seats are left, so the person keeps their session to call again with.
    expect(sessionsOf(h.db, P)).toBe(1);
    expect(outcomeOf(store.records()[0])).toEqual(
      expect.objectContaining({ cleanUp: "done", finished: false }),
    );
    expect((await remove(h, cookie, ANSWERS)).status).toBe(200);
    expect(sessionsOf(h.db, P)).toBe(0);
    expect(outcomeOf(store.records()[1])).toEqual(
      expect.objectContaining({ cleanUp: "done", finished: true }),
    );
  });

  it("a removal that fails part way names no one in its logs or its spans", async () => {
    const h = await setup();
    const cookie = await confirmation(h);
    const failing = failStatements(h.db, (statement) =>
      /^delete from "registry_stripe_oauth_states"/i.test(statement),
    );
    let res: Response | undefined;
    let spans: Awaited<ReturnType<typeof captureSpans>> = [];
    const logs = await captureLogs(async () => {
      spans = await captureSpans(async () => {
        res = await remove(h, cookie, ANSWERS);
      });
    });
    failing.restore();
    expect(res!.status).toBe(500);
    // Seats went before the failure: the weddings' own batches committed.
    expect(deletedAt(h.db, "w_alone")).not.toBeNull();

    const people = [P, P2, O, ACCOUNT];
    const weddingIds = ["w_alone", "w_sibling", "w_shared", "w_theirs", "w_theirs_edit"];
    for (const named of people) expect(logs).not.toContain(named);
    // The failure's own lines name no wedding either. (Each wedding the
    // erasure reached is logged by its id as it goes, by design.)
    const entries = logs.split(/\n(?=\[\d{2}:\d{2}:\d{2}\.\d{3}\])/);
    const failures = entries.filter((entry) => /failed/.test(entry));
    expect(failures.length).toBeGreaterThan(0);
    for (const entry of failures) {
      for (const named of weddingIds) expect(entry).not.toContain(named);
    }

    const values = (span: (typeof spans)[number]) => JSON.stringify(span.attributes);
    for (const span of spans) {
      for (const named of people) expect(values(span)).not.toContain(named);
    }
    const failed = spans.filter((span) => "error.type" in span.attributes);
    expect(failed.map((span) => span.attributes["error.type"])).toContain("AccountErasureError");
    for (const span of failed) {
      for (const named of weddingIds) expect(values(span)).not.toContain(named);
    }
  });

  it("records nothing for a removal refused for an unanswered wedding", async () => {
    const store = memoryDeletionRecordStore();
    const h = await setup({ deletionRecords: store });
    const res = await remove(h, await confirmation(h), {});
    expect(res.status).toBe(409);
    expect(store.records()).toEqual([]);
  });

  it("refuses the removal with 503, erasing nothing, when the record cannot be written", async () => {
    const h = await setup({ deletionRecords: missingDeletionRecordStore() });
    const before = await counterValue(CIRE_METRICS.accountRemovalRequests, { result: "error" });
    const res = await remove(h, await confirmation(h), ANSWERS);
    expect(await counterValue(CIRE_METRICS.accountRemovalRequests, { result: "error" })).toBe(
      before + 1,
    );
    expect({ status: res.status, body: await jsonBody(res) }).toEqual({
      status: 503,
      body: { error: "deletion_not_recorded" },
    });
    untouched(h.db);
  });
});
