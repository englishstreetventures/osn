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
import { eq } from "drizzle-orm";
import { Effect, Layer } from "effect";

import { DbService } from "../../src/db";
import { createDb, seedDb } from "../../src/db/setup";
import type { TestDb } from "../../src/db/setup";
import { rsvpChangeService } from "../../src/services/rsvp-changes";
import {
  RSVP_DIGEST_LOOKBACK_MS,
  rsvpDigestService,
  type RsvpDigestResult,
} from "../../src/services/rsvp-digest";

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
  const lookup = async (ids: readonly string[]) => {
    calls.push([...ids]);
    return new Map(ids.flatMap((id) => (addresses[id] ? [[id, addresses[id]] as const] : [])));
  };
  return { lookup, calls };
}

async function run(
  db: TestDb,
  layer: Layer.Layer<EmailService>,
  lookup: (ids: readonly string[]) => Promise<ReadonlyMap<string, string>>,
  opts: { maxEmails?: number; now?: Date } = {},
): Promise<RsvpDigestResult> {
  return Effect.runPromise(
    rsvpDigestService
      .sendDailyDigests({ now: opts.now ?? NOW, organiserOrigin: ORIGIN, lookup, ...opts })
      .pipe(Effect.provideService(DbService, db), Effect.provide(layer)),
  );
}

const recipients = (sent: readonly SendEmailInput[]) => sent.map((s) => s.to).toSorted();

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

  it("sends and marks nothing when osn-api answers with no addresses at all", async () => {
    const { db, ada } = fixture();
    change(db, ada, "reply_new");
    const down = transport();
    const result = await run(db, down.layer, async () => new Map());
    expect(down.sent).toEqual([]);
    expect(result).toEqual({ sent: 0, failed: 0, noAddress: 0, lookupFailed: 3, deferred: 0 });
    expect(db.select().from(hostRsvpNotices).all()).toEqual([]);

    const up = transport();
    await run(db, up.layer, lookupOf(ADDRESSES).lookup);
    expect(up.sent).toHaveLength(3);
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
});
