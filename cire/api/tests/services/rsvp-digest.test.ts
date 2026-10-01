import { describe, expect, it } from "bun:test";

import {
  BOOTSTRAP_WEDDING_ID,
  guests,
  hostRsvpNotices,
  rsvpChanges,
  weddingHosts,
  weddings,
  type RsvpChangeKind,
} from "@cire/db";
import { events as eventsData } from "@cire/db/seed";
import { EmailError, EmailService, type SendEmailInput } from "@shared/email";
import { eq, sql } from "drizzle-orm";
import { Effect, Layer } from "effect";

import { DbService } from "../../src/db";
import { createDb, seedDb } from "../../src/db/setup";
import type { TestDb } from "../../src/db/setup";
import { deriveDigestStopKey, verifyDigestStopToken } from "../../src/lib/digest-stop";
import { CIRE_METRICS } from "../../src/metrics";
import type { OsnOrganiserEmailLookup } from "../../src/services/osn-bridge";
import { rsvpChangeService } from "../../src/services/rsvp-changes";
import {
  buildCandidateQuery,
  chooseRecipients,
  RSVP_DIGEST_LOOKBACK_MS,
  RSVP_DIGEST_MAX_EMAILS_PER_RUN,
  rsvpDigestService,
  type RsvpDigestResult,
} from "../../src/services/rsvp-digest";
import { counterValue } from "../test-helpers/metrics-harness";

const OWNER = "usr_dev_bootstrap_owner";
const EDITOR = "usr_digest_editor";
const LEGACY_HOST = "usr_digest_legacy_host";
const VIEWER = "usr_digest_viewer";
const HELPER = "usr_digest_helper";
const ORIGIN = "https://host.example.test";
const NOW = new Date("2026-09-27T04:00:00Z");

const ADDRESSES: Record<string, string> = {
  [OWNER]: "owner@example.test",
  [EDITOR]: "editor@example.test",
  [LEGACY_HOST]: "legacy@example.test",
  [VIEWER]: "viewer@example.test",
  [HELPER]: "helper@example.test",
};

function fixture() {
  const db = createDb(":memory:");
  seedDb(db);
  const created = new Date("2026-01-01T00:00:00Z");
  for (const [id, osnProfileId, role] of [
    ["whost_d_editor", EDITOR, "editor"],
    ["whost_d_legacy", LEGACY_HOST, "host"],
    ["whost_d_viewer", VIEWER, "viewer"],
    ["whost_d_helper", HELPER, "helper"],
  ] as const) {
    db.insert(weddingHosts)
      .values({
        id,
        weddingId: BOOTSTRAP_WEDDING_ID,
        osnProfileId,
        addedByOsnProfileId: OWNER,
        role,
        createdAt: created,
      })
      .run();
  }
  const guest = (firstName: string) =>
    db
      .select({ id: guests.id, familyId: guests.familyId })
      .from(guests)
      .where(eq(guests.firstName, firstName))
      .all()[0]!;
  return { db, ada: guest("Ada"), bo: guest("Bo"), cleo: guest("Cleo") };
}

function change(
  db: TestDb,
  who: { id: string; familyId: string },
  kind: RsvpChangeKind,
  at = new Date(NOW.getTime() - 60 * 60 * 1000),
  weddingId = BOOTSTRAP_WEDDING_ID,
) {
  db.insert(rsvpChanges)
    .values({
      weddingId,
      familyId: who.familyId,
      guestId: who.id,
      eventId: kind.startsWith("plus_one") ? null : eventsData.hindu.id,
      kind,
      createdAt: at,
    })
    .run();
}

/** A transport that records every send and fails the addresses it is told to. */
function transport(failFor: readonly string[] = []) {
  const sent: SendEmailInput[] = [];
  const layer = Layer.succeed(EmailService, {
    send: (input: SendEmailInput) =>
      failFor.includes(input.to)
        ? Effect.fail(new EmailError({ reason: "dispatch_failed" }))
        : Effect.sync(() => {
            sent.push(input);
          }),
  });
  return { sent, layer };
}

function lookupOf(addresses: Record<string, string>) {
  const calls: string[][] = [];
  const lookup: OsnOrganiserEmailLookup = async (ids) => {
    calls.push([...ids]);
    return {
      answered: true,
      emails: new Map(ids.flatMap((id) => (addresses[id] ? [[id, addresses[id]] as const] : []))),
    };
  };
  return { lookup, calls };
}

async function run(
  db: TestDb,
  layer: Layer.Layer<EmailService>,
  lookup: OsnOrganiserEmailLookup,
  opts: {
    maxEmails?: number;
    now?: Date;
    stopLinks?: { apiOrigin: string; key: CryptoKey };
  } = {},
): Promise<RsvpDigestResult> {
  return Effect.runPromise(
    rsvpDigestService
      .sendDailyDigests({ now: opts.now ?? NOW, organiserOrigin: ORIGIN, lookup, ...opts })
      .pipe(Effect.provideService(DbService, db), Effect.provide(layer)),
  );
}

const recipients = (sent: readonly SendEmailInput[]) => sent.map((s) => s.to).toSorted();

const unanswered: OsnOrganiserEmailLookup = async () => ({ answered: false, emails: new Map() });

describe("rsvpDigestService.sendDailyDigests", () => {
  it("mails the owner and every editor, legacy host seats included, and no viewer or helper", async () => {
    const { db, ada } = fixture();
    change(db, ada, "reply_new");
    const { sent, layer } = transport();
    const result = await run(db, layer, lookupOf(ADDRESSES).lookup);
    expect(recipients(sent)).toEqual([
      "editor@example.test",
      "legacy@example.test",
      "owner@example.test",
    ]);
    expect(result).toEqual({ sent: 3, failed: 0, noAddress: 0, lookupFailed: 0, deferred: 0 });
  });

  it("counts households per kind of change, with the wedding's name and RSVP link", async () => {
    const { db, ada, bo, cleo } = fixture();
    change(db, ada, "reply_new");
    change(db, ada, "reply_new");
    change(db, bo, "reply_new");
    change(db, cleo, "reply_edited");
    change(db, ada, "plus_one_added");
    const { sent, layer } = transport();
    await run(db, layer, lookupOf({ [OWNER]: ADDRESSES[OWNER]! }).lookup);
    const [email] = sent;
    const [wedding] = db
      .select({ name: weddings.displayName })
      .from(weddings)
      .where(eq(weddings.id, BOOTSTRAP_WEDDING_ID))
      .all();
    expect(email).toEqual({
      template: "rsvp-change-digest",
      to: "owner@example.test",
      data: {
        weddingName: wedding!.name,
        // Bo and Cleo share a household, so two households in all.
        households: 2,
        counts: { reply_new: 2, reply_edited: 1, plus_one_added: 1 },
        rsvpUrl: `${ORIGIN}/#/w/${BOOTSTRAP_WEDDING_ID}/guests/rsvps`,
      },
    });
  });

  it("gives each email a stop link signed for its own recipient and wedding", async () => {
    const { db, ada } = fixture();
    change(db, ada, "reply_new");
    const key = await deriveDigestStopKey("test-secret");
    const { sent, layer } = transport();
    await run(db, layer, lookupOf(ADDRESSES).lookup, {
      stopLinks: { apiOrigin: "https://api.example.test", key },
    });
    expect(sent).toHaveLength(3);
    const byAddress = Object.fromEntries(Object.entries(ADDRESSES).map(([id, to]) => [to, id]));
    for (const email of sent) {
      if (email.template !== "rsvp-change-digest") throw new Error("unexpected template");
      const url = new URL(email.data.stopUrl ?? "");
      expect(url.origin + url.pathname).toBe("https://api.example.test/api/rsvp-digest/stop");
      expect(await verifyDigestStopToken(key, url.searchParams.get("t") ?? "")).toEqual({
        weddingId: BOOTSTRAP_WEDDING_ID,
        osnProfileId: byAddress[email.to]!,
      });
    }
  });

  it("sends no stop link without a signing key", async () => {
    const { db, ada } = fixture();
    change(db, ada, "reply_new");
    const { sent, layer } = transport();
    await run(db, layer, lookupOf(ADDRESSES).lookup);
    for (const email of sent) {
      if (email.template !== "rsvp-change-digest") throw new Error("unexpected template");
      expect(email.data.stopUrl).toBeUndefined();
    }
  });

  it("sends nothing on a day with no changes, and asks osn-api for nothing", async () => {
    const { db } = fixture();
    const { sent, layer } = transport();
    const { lookup, calls } = lookupOf(ADDRESSES);
    const result = await run(db, layer, lookup);
    expect(sent).toEqual([]);
    expect(calls).toEqual([]);
    expect(result.sent).toBe(0);
  });

  it("does not mail the same changes twice", async () => {
    const { db, ada } = fixture();
    change(db, ada, "reply_new");
    const first = transport();
    await run(db, first.layer, lookupOf(ADDRESSES).lookup);
    const second = transport();
    await run(db, second.layer, lookupOf(ADDRESSES).lookup);
    expect(first.sent).toHaveLength(3);
    expect(second.sent).toEqual([]);
  });

  it("covers only what changed since the recipient's last digest", async () => {
    const { db, ada, bo } = fixture();
    change(db, ada, "reply_new");
    await run(db, transport().layer, lookupOf(ADDRESSES).lookup);
    change(db, bo, "reply_edited");
    const { sent, layer } = transport();
    await run(db, layer, lookupOf({ [OWNER]: ADDRESSES[OWNER]! }).lookup);
    expect(sent.map((s) => s.data)).toEqual([
      expect.objectContaining({ households: 1, counts: { reply_edited: 1 } }),
    ]);
  });

  it("skips a recipient who turned the digest off for this wedding", async () => {
    const { db, ada } = fixture();
    await Effect.runPromise(
      rsvpChangeService
        .setDigest(BOOTSTRAP_WEDDING_ID, EDITOR, false)
        .pipe(Effect.provideService(DbService, db)),
    );
    change(db, ada, "reply_new");
    const { sent, layer } = transport();
    await run(db, layer, lookupOf(ADDRESSES).lookup);
    expect(recipients(sent)).toEqual(["legacy@example.test", "owner@example.test"]);
  });

  it("sends and marks nothing when osn-api does not answer", async () => {
    const { db, ada } = fixture();
    change(db, ada, "reply_new");
    const down = transport();
    const result = await run(db, down.layer, unanswered);
    expect(down.sent).toEqual([]);
    expect(result).toEqual({ sent: 0, failed: 0, noAddress: 0, lookupFailed: 3, deferred: 0 });
    expect(db.select().from(hostRsvpNotices).all()).toEqual([]);

    const up = transport();
    await run(db, up.layer, lookupOf(ADDRESSES).lookup);
    expect(up.sent).toHaveLength(3);
  });

  it("moves every marker when osn-api answers with no address for anyone", async () => {
    const { db, ada } = fixture();
    change(db, ada, "reply_new");
    const result = await run(db, transport().layer, lookupOf({}).lookup);
    expect(result).toEqual({ sent: 0, failed: 0, noAddress: 3, lookupFailed: 0, deferred: 0 });
    // Nobody is behind any more, so the next run asks osn-api nothing.
    const { lookup, calls } = lookupOf(ADDRESSES);
    await run(db, transport().layer, lookup);
    expect(calls).toEqual([]);
  });

  it("treats a lookup that throws as osn-api being down", async () => {
    const { db, ada } = fixture();
    change(db, ada, "reply_new");
    const { sent, layer } = transport();
    const result = await run(db, layer, async () => {
      throw new Error("boom");
    });
    expect(sent).toEqual([]);
    expect(result.lookupFailed).toBe(3);
  });

  it("marks a recipient osn-api has no address for, so they stop taking a place", async () => {
    const { db, ada } = fixture();
    change(db, ada, "reply_new");
    const { [OWNER]: _owner, ...withoutOwner } = ADDRESSES;
    const first = await run(db, transport().layer, lookupOf(withoutOwner).lookup);
    expect(first.noAddress).toBe(1);
    const { lookup, calls } = lookupOf(ADDRESSES);
    await run(db, transport().layer, lookup);
    expect(calls).toEqual([]);
  });

  it("retries a failed send on the next run", async () => {
    const { db, ada } = fixture();
    change(db, ada, "reply_new");
    const flaky = transport(["editor@example.test"]);
    const first = await run(db, flaky.layer, lookupOf(ADDRESSES).lookup);
    expect(first).toEqual({ sent: 2, failed: 1, noAddress: 0, lookupFailed: 0, deferred: 0 });
    const next = transport();
    await run(db, next.layer, lookupOf(ADDRESSES).lookup);
    expect(recipients(next.sent)).toEqual(["editor@example.test"]);
  });

  it("carries recipients past the per-run cap to the next run", async () => {
    const { db, ada } = fixture();
    change(db, ada, "reply_new");
    const first = transport();
    const result = await run(db, first.layer, lookupOf(ADDRESSES).lookup, { maxEmails: 2 });
    expect(result).toEqual({ sent: 2, failed: 0, noAddress: 0, lookupFailed: 0, deferred: 1 });
    const second = transport();
    await run(db, second.layer, lookupOf(ADDRESSES).lookup, { maxEmails: 2 });
    expect(second.sent).toHaveLength(1);
    expect(recipients([...first.sent, ...second.sent])).toEqual([
      "editor@example.test",
      "legacy@example.test",
      "owner@example.test",
    ]);
  });

  it("ignores changes older than the look-back window", async () => {
    const { db, ada } = fixture();
    change(db, ada, "reply_new", new Date(NOW.getTime() - RSVP_DIGEST_LOOKBACK_MS - 1000));
    const { sent, layer } = transport();
    await run(db, layer, lookupOf(ADDRESSES).lookup);
    expect(sent).toEqual([]);
  });

  it("keeps each wedding's changes to its own organisers", async () => {
    const { db, ada } = fixture();
    const now = new Date();
    db.insert(weddings)
      .values({
        id: "wed_digest_other",
        slug: "digest-other",
        displayName: "Other",
        ownerOsnProfileId: "usr_other_owner",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    change(db, ada, "reply_new", undefined, "wed_digest_other");
    const { sent, layer } = transport();
    await run(db, layer, lookupOf({ ...ADDRESSES, usr_other_owner: "other@example.test" }).lookup);
    expect(recipients(sent)).toEqual(["other@example.test"]);
    expect(sent[0]!.data).toEqual(expect.objectContaining({ weddingName: "Other" }));
  });

  it("counts each outcome under its own label", async () => {
    const { db, ada } = fixture();
    change(db, ada, "reply_new");
    const counts = async () =>
      Object.fromEntries(
        await Promise.all(
          (["sent", "failed", "no_address", "lookup_failed", "deferred"] as const).map(
            async (outcome) =>
              [outcome, await counterValue(CIRE_METRICS.rsvpDigestEmails, { outcome })] as const,
          ),
        ),
      );
    const before = await counts();
    const { [LEGACY_HOST]: _legacy, ...withoutLegacy } = ADDRESSES;
    // Owner sent, editor failed, legacy seat has no address; cap 3 of 3.
    await run(db, transport(["editor@example.test"]).layer, lookupOf(withoutLegacy).lookup);
    const mid = await counts();
    expect(mid.sent - before.sent).toBe(1);
    expect(mid.failed - before.failed).toBe(1);
    expect(mid.no_address - before.no_address).toBe(1);
    // Then osn-api down, with a cap of one: one looked up and failed, none deferred.
    change(db, ada, "reply_edited");
    await run(db, transport().layer, unanswered, { maxEmails: 1 });
    const after = await counts();
    expect(after.lookup_failed - mid.lookup_failed).toBe(1);
    expect(after.deferred - mid.deferred).toBe(2);
  });

  it("fails as RsvpDigestError when the database cannot be read", async () => {
    const { db } = fixture();
    db.run(sql`DROP TABLE rsvp_changes`);
    const error = await Effect.runPromise(
      rsvpDigestService
        .sendDailyDigests({ now: NOW, organiserOrigin: ORIGIN, lookup: lookupOf(ADDRESSES).lookup })
        .pipe(Effect.flip, Effect.provideService(DbService, db), Effect.provide(transport().layer)),
    );
    expect(error._tag).toBe("RsvpDigestError");
  });

  it("serves the recipient who has waited longest first", async () => {
    const { db, ada, bo } = fixture();
    change(db, ada, "reply_new");
    // Two of three are mailed; the third (the legacy seat) is deferred and
    // its marker stays behind the other two.
    const first = transport();
    await run(db, first.layer, lookupOf(ADDRESSES).lookup, { maxEmails: 2 });
    expect(recipients(first.sent)).toEqual(["editor@example.test", "owner@example.test"]);
    change(db, bo, "reply_new");
    const { sent, layer } = transport();
    await run(db, layer, lookupOf(ADDRESSES).lookup, { maxEmails: 1 });
    expect(sent.map((s) => s.to)).toEqual(["legacy@example.test"]);
  });

  it("builds the RSVP link on an origin given with a trailing slash", async () => {
    const { db, ada } = fixture();
    change(db, ada, "reply_new");
    const { sent, layer } = transport();
    await Effect.runPromise(
      rsvpDigestService
        .sendDailyDigests({
          now: NOW,
          organiserOrigin: `${ORIGIN}/`,
          lookup: lookupOf({ [OWNER]: ADDRESSES[OWNER]! }).lookup,
        })
        .pipe(Effect.provideService(DbService, db), Effect.provide(layer)),
    );
    expect(sent[0]!.data).toEqual(
      expect.objectContaining({ rsvpUrl: `${ORIGIN}/#/w/${BOOTSTRAP_WEDDING_ID}/guests/rsvps` }),
    );
  });

  it("asks osn-api about an organiser of two weddings once", async () => {
    const { db, ada } = fixture();
    const now = new Date();
    db.insert(weddings)
      .values({
        id: "wed_digest_second",
        slug: "digest-second",
        displayName: "Second",
        ownerOsnProfileId: OWNER,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    change(db, ada, "reply_new");
    change(db, ada, "reply_new", undefined, "wed_digest_second");
    const { lookup, calls } = lookupOf({ [OWNER]: ADDRESSES[OWNER]! });
    const { sent, layer } = transport();
    await run(db, layer, lookup);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.filter((id) => id === OWNER)).toHaveLength(1);
    expect(sent.filter((s) => s.to === ADDRESSES[OWNER])).toHaveLength(2);
  });

  it("leaves a digest switched off mid-run off", async () => {
    const { db, ada } = fixture();
    change(db, ada, "reply_new");
    const lookup = async (ids: readonly string[]) => {
      // The editor turns the digest off while the run is between its reads
      // and its marker upsert.
      await Effect.runPromise(
        rsvpChangeService
          .setDigest(BOOTSTRAP_WEDDING_ID, EDITOR, false)
          .pipe(Effect.provideService(DbService, db)),
      );
      return lookupOf(ADDRESSES).lookup(ids);
    };
    await run(db, transport().layer, lookup);
    const [notice] = db
      .select({ enabled: hostRsvpNotices.digestEnabled })
      .from(hostRsvpNotices)
      .where(eq(hostRsvpNotices.osnProfileId, EDITOR))
      .all();
    expect(notice?.enabled).toBe(false);
  });

  it("sends through the transport's batch call when it has one, and marks nothing if it fails", async () => {
    const { db, ada } = fixture();
    change(db, ada, "reply_new");
    const batches: SendEmailInput[][] = [];
    let fail = true;
    const batchLayer = Layer.succeed(EmailService, {
      send: () => Effect.die("a batch-capable transport is sent one batch"),
      sendBatch: (inputs: readonly SendEmailInput[]) =>
        fail
          ? Effect.fail(new EmailError({ reason: "dispatch_failed" }))
          : Effect.sync(() => void batches.push([...inputs])),
    });
    const failed = await run(db, batchLayer, lookupOf(ADDRESSES).lookup);
    expect(failed).toEqual({ sent: 0, failed: 3, noAddress: 0, lookupFailed: 0, deferred: 0 });
    expect(db.select().from(hostRsvpNotices).all()).toEqual([]);

    fail = false;
    const sent = await run(db, batchLayer, lookupOf(ADDRESSES).lookup);
    expect(sent.sent).toBe(3);
    expect(batches).toHaveLength(1);
    expect(recipients(batches[0]!)).toEqual([
      "editor@example.test",
      "legacy@example.test",
      "owner@example.test",
    ]);
  });

  it("mails a co-host with no marker only for what changed after they were seated", async () => {
    const { db, ada, bo } = fixture();
    const seated = new Date(NOW.getTime() - 2 * 60 * 60 * 1000);
    db.insert(weddingHosts)
      .values({
        id: "whost_d_new",
        weddingId: BOOTSTRAP_WEDDING_ID,
        osnProfileId: "usr_digest_new",
        addedByOsnProfileId: OWNER,
        role: "editor",
        createdAt: seated,
      })
      .run();
    change(db, ada, "reply_new", new Date(seated.getTime() - 60_000));
    const addresses = { ...ADDRESSES, usr_digest_new: "new@example.test" };
    const first = transport();
    await run(db, first.layer, lookupOf(addresses).lookup);
    expect(recipients(first.sent)).not.toContain("new@example.test");

    change(db, bo, "reply_edited", new Date(seated.getTime() + 60_000));
    const second = transport();
    await run(db, second.layer, lookupOf(addresses).lookup);
    const mine = second.sent.find((s) => s.to === "new@example.test");
    expect(mine?.data).toEqual(
      expect.objectContaining({ households: 1, counts: { reply_edited: 1 } }),
    );
  });

  it("gives every waiting wedding a place before any wedding gets a second", async () => {
    const { db, ada } = fixture();
    const now = new Date();
    db.insert(weddings)
      .values({
        id: "wed_digest_small",
        slug: "digest-small",
        displayName: "Small",
        ownerOsnProfileId: "usr_small_owner",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    change(db, ada, "reply_new");
    change(db, ada, "reply_new", undefined, "wed_digest_small");
    const { sent, layer } = transport();
    await run(db, layer, lookupOf({ ...ADDRESSES, usr_small_owner: "small@example.test" }).lookup, {
      maxEmails: 2,
    });
    // The bootstrap wedding has three recipients waiting and the small one has
    // one; a cap of two takes one from each.
    expect(recipients(sent)).toContain("small@example.test");
    expect(sent).toHaveLength(2);
  });

  it("writes no marker for a co-host removed while the run was going", async () => {
    const { db, ada } = fixture();
    change(db, ada, "reply_new");
    const lookup: OsnOrganiserEmailLookup = async (ids) => {
      db.delete(weddingHosts).where(eq(weddingHosts.osnProfileId, EDITOR)).run();
      return lookupOf(ADDRESSES).lookup(ids);
    };
    await run(db, transport().layer, lookup);
    const owners = db
      .select({ who: hostRsvpNotices.osnProfileId })
      .from(hostRsvpNotices)
      .all()
      .map((r) => r.who)
      .toSorted();
    expect(owners).toEqual([LEGACY_HOST, OWNER].toSorted());
  });

  it("reads its candidates through the created_at index, not the whole log", () => {
    const { db } = fixture();
    const { sql: text, params } = buildCandidateQuery(db, NOW).toSQL();
    const plan = db.$client
      .query<{ detail: string }, never[]>(`EXPLAIN QUERY PLAN ${text}`)
      .all(...(params as never[]))
      .map((r) => r.detail)
      .join("\n");
    expect(plan).toMatch(
      /rsvp_changes USING (COVERING )?INDEX rsvp_changes_created_at_idx \(created_at>\?\)/,
    );
    expect(plan).not.toMatch(/SCAN rsvp_changes/);
  });

  it("caps a run at one lookup call and one batch call's worth", () => {
    expect(RSVP_DIGEST_MAX_EMAILS_PER_RUN).toBe(100);
  });
});

describe("chooseRecipients", () => {
  const r = (weddingId: string, osnProfileId: string, cursor: number) => ({
    weddingId,
    osnProfileId,
    cursor,
    since: 0,
  });

  it("takes one per wedding per round, longest-waiting wedding first", () => {
    const { chosen, deferred } = chooseRecipients(
      [
        r("w_big", "a", 0),
        r("w_big", "b", 0),
        r("w_big", "c", 0),
        r("w_small", "z", 5),
        r("w_mid", "m", 2),
      ],
      4,
    );
    expect(chosen.map((x) => `${x.weddingId}/${x.osnProfileId}`)).toEqual([
      "w_big/a",
      "w_mid/m",
      "w_small/z",
      "w_big/b",
    ]);
    expect(deferred).toBe(1);
  });

  it("takes everyone under the cap", () => {
    expect(chooseRecipients([r("w", "a", 0), r("w", "b", 3)], 10)).toEqual({
      chosen: [r("w", "a", 0), r("w", "b", 3)],
      deferred: 0,
    });
  });
});
