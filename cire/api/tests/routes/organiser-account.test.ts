import { beforeAll, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";

import { organiserSessions, ownerNoticeBudget, weddingHosts, weddings } from "@cire/db";
import { makeLogEmailLive } from "@shared/email";
import { createRateLimiter } from "@shared/rate-limit";
import { eq } from "drizzle-orm";

import type { AppOptions } from "../../src/app";
import { createApp } from "../../src/app";
import { createDb } from "../../src/db/setup";
import type { TestDb } from "../../src/db/setup";
import { MAX_OWNED_WEDDINGS_PER_CALL } from "../../src/services/account-erasure";
import type { OsnRemovalBridge } from "../../src/services/osn-bridge";
import { appRequest, jsonBody, recordStatements } from "../test-helpers";
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
    osnTestKey: auth.key,
    organiserOrigin: PORTAL,
    accountRemovalLimiter: createRateLimiter({ maxRequests: 1000, windowMs: 60_000 }),
    accountRemovalBridge: stubBridge(log, bridgeOverrides),
    emailLayer: mail.layer,
    organiserEmailLookup: async (ids) => ({
      answered: true,
      emails: new Map(ids.flatMap((id) => (ADDRESSES[id] ? [[id, ADDRESSES[id]] as const] : []))),
    }),
    resolveOsnProfileDisplays: async (ids) =>
      new Map(
        ids.includes(P)
          ? [[P, { handle: "person", displayName: "Pat Person", avatarUrl: null }]]
          : [],
      ),
    ...appOverrides,
  });
  return { db, app, sessions, log, mail };
}

type Setup = Awaited<ReturnType<typeof setup>>;

const call = (
  h: Setup,
  method: string,
  path: string,
  opts: { session?: string | null; removal?: string | null; body?: unknown } = {},
) => {
  const cookies = [
    opts.session === null ? null : `cire_org_session=${opts.session ?? h.sessions.person}`,
    opts.removal ? opts.removal : null,
  ].filter((c): c is string => c !== null);
  const headers: Record<string, string> = {};
  if (cookies.length > 0) headers.cookie = cookies.join("; ");
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
    for (const removal of [null, "cire_removal=not-a-pair", "cire_removal=a.b.c"]) {
      const res = await remove(h, removal, ANSWERS);
      expect({ removal, status: res.status, body: await jsonBody(res) }).toEqual({
        removal,
        status: 403,
        body: { error: "confirmation_required" },
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
    untouched(h.db);
  });
});

describe("a host's removal of their Cire data: what it removes", () => {
  it("C6: removes every seat of both profiles, deletes the weddings left with no owner, ends the person's sessions, and touches no one else's", async () => {
    const h = await setup();
    const cookie = await confirmation(h);
    const res = await remove(h, cookie, ANSWERS);

    expect(res.status).toBe(200);
    expect(await jsonBody(res)).toEqual({ status: "done" });
    const cleared = res.headers.getSetCookie();
    expect(cleared.some((c) => c.startsWith("cire_org_session=;") && /Max-Age=0/i.test(c))).toBe(
      true,
    );
    expect(cleared.some((c) => c.startsWith("cire_removal=;") && /Max-Age=0/i.test(c))).toBe(true);

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

    const second = await remove(h, cookie, ANSWERS);
    expect(second.status).toBe(200);
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
