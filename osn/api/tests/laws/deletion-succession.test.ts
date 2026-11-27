import { accounts, deletionJobs, organisationMembers, organisations, users } from "@osn/db/schema";
import { Db } from "@osn/db/service";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { hardDeleteAccount } from "../../src/services/account-erasure";
import { createTestLayer } from "../helpers/db";
import { type Answer, type Mem, list, model, seeded } from "./model";

/**
 * Who an organisation passes to at its owner's hard delete
 * (laws/account-deletion/succession.bend) against hardDeleteAccount on
 * bun:sqlite. Each case seeds one organisation owned by a profile of the
 * account being erased, its members in order of joining (the owner's own
 * membership first, the account's other profiles among them), and the answer
 * stored on the job, then compares the organisation's owner after the hard
 * delete with the model's heir: the same profile, or the organisation gone.
 *
 * Profiles are numbered; profile `p` of account `a` is `usr_<p>` of
 * `acc_<a>`, and account 0 is the one erased.
 */

const NOW = 2_000_000_000;
const GONE = 0;

const mem = (profile: number, account: number, admin: boolean): Mem => ({
  $: "Mem",
  profile,
  account,
  rank: { $: admin ? "Admin" : "Plain" },
});

const stored = (orgId: string, ans: Answer): string | null => {
  const action = `osn:organisation:${orgId}`;
  switch (ans.$) {
    case "Transfer":
      return JSON.stringify({ [action]: { choice: "transfer" } });
    case "Named":
      return JSON.stringify({
        [action]: { choice: "successor", successorProfileId: `usr_${ans.profile}` },
      });
    case "Remove":
      return JSON.stringify({ [action]: { choice: "delete" } });
    case "Unanswered":
      return null;
  }
};

/**
 * Whether the hard delete ran, and the organisation's owner after it, as a
 * profile number, or null when the organisation went.
 */
async function throughHardDelete(
  members: Mem[],
  ans: Answer,
  extraProfiles: number[],
): Promise<{ deleted: boolean; owner: number | null }> {
  const layer = createTestLayer();
  const orgId = "org_succession";
  return Effect.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Db;
      const at = new Date(NOW * 1_000);
      const owner = members[0]!;
      const profiles = new Map<number, number>();
      for (const m of members) profiles.set(m.profile, m.account);
      for (const p of extraProfiles) if (!profiles.has(p)) profiles.set(p, 9);
      for (const account of new Set(profiles.values())) {
        yield* Effect.promise(() =>
          db.insert(accounts).values({
            id: `acc_${account}`,
            email: `a${account}@example.com`,
            passkeyUserId: crypto.randomUUID(),
            maxProfiles: 10,
            createdAt: at,
            updatedAt: at,
          }),
        );
      }
      for (const [profile, account] of profiles) {
        yield* Effect.promise(() =>
          db.insert(users).values({
            id: `usr_${profile}`,
            accountId: `acc_${account}`,
            handle: `p${profile}`,
            isDefault: false,
            createdAt: at,
            updatedAt: at,
          }),
        );
      }
      yield* Effect.promise(() =>
        db.insert(organisations).values({
          id: orgId,
          handle: "successionorg",
          name: "Succession",
          ownerId: `usr_${owner.profile}`,
          createdAt: at,
          updatedAt: at,
        }),
      );
      for (const [i, m] of members.entries()) {
        yield* Effect.promise(() =>
          db.insert(organisationMembers).values({
            id: `orgm_${String(i).padStart(3, "0")}`,
            organisationId: orgId,
            profileId: `usr_${m.profile}`,
            role: m.rank.$ === "Admin" ? "admin" : "member",
            createdAt: new Date((NOW + i) * 1_000),
          }),
        );
      }
      const choices = stored(orgId, ans);
      yield* Effect.promise(() =>
        db.insert(deletionJobs).values({
          accountId: `acc_${GONE}`,
          softDeletedAt: NOW - 8 * 86_400,
          hardDeleteAt: NOW - 86_400,
          reason: "user_request",
          pulseDoneAt: NOW,
          zapDoneAt: NOW,
          cireDoneAt: NOW,
          purgeStartedAt: NOW,
          choices,
        }),
      );
      const result = yield* hardDeleteAccount(
        { accountId: `acc_${GONE}`, purgeStartedAt: NOW, choices },
        NOW,
      );
      const [org] = yield* Effect.promise(() =>
        db.select().from(organisations).where(eq(organisations.id, orgId)),
      );
      return {
        deleted: result.deleted,
        owner: org ? Number(org.ownerId.replace("usr_", "")) : null,
      };
    }).pipe(Effect.provide(layer)),
  );
}

async function expectModelAgrees(
  members: Mem[],
  ans: Answer,
  extraProfiles: number[] = [],
): Promise<void> {
  const heir = model["succession:heir"](GONE, list(members), ans);
  const at = JSON.stringify({ members, ans });
  const got = await throughHardDelete(members, ans, extraProfiles);
  expect({ at, ...got }).toEqual({
    at,
    deleted: true,
    owner: heir.$ === "Some" ? heir.value : null,
  });
}

describe("organisation succession: the model and the hard delete agree", () => {
  const owner = mem(0, GONE, true);

  it("passes to the named successor while still a member from another account", async () => {
    await expectModelAgrees([owner, mem(1, 1, true), mem(2, 2, false)], { $: "Named", profile: 2 });
  });

  it("falls back when the named successor is not a member, or is the account's own profile", async () => {
    await expectModelAgrees(
      [owner, mem(1, 1, false), mem(2, 2, true)],
      { $: "Named", profile: 7 },
      [7],
    );
    await expectModelAgrees([owner, mem(3, GONE, true), mem(1, 1, false)], {
      $: "Named",
      profile: 3,
    });
  });

  it("takes an admin from another account before an older member, and never the account's own profiles", async () => {
    await expectModelAgrees([owner, mem(1, 1, false), mem(3, GONE, true), mem(2, 2, true)], {
      $: "Transfer",
    });
    await expectModelAgrees([owner, mem(3, GONE, true), mem(1, 1, false), mem(2, 2, false)], {
      $: "Unanswered",
    });
  });

  it("deletes it on a delete answer, and when no member from another account is left", async () => {
    await expectModelAgrees([owner, mem(1, 1, true)], { $: "Remove" });
    await expectModelAgrees([owner, mem(3, GONE, true)], { $: "Transfer" });
  });

  const draw = (seed: number): { members: Mem[]; ans: Answer } => {
    const rand = seeded(seed);
    const members = [owner];
    const count = rand.int(5);
    for (let p = 1; p <= count; p++) {
      members.push(mem(p, rand.pick([GONE, 1, 2, 3]), rand.chance(0.4)));
    }
    const ans = rand.pick<Answer>([
      { $: "Transfer" },
      { $: "Remove" },
      { $: "Unanswered" },
      { $: "Named", profile: rand.int(count + 2) },
    ]);
    return { members, ans };
  };

  for (let seed = 1; seed <= 40; seed++) {
    it(`agrees on seeded organisation ${seed}`, async () => {
      const { members, ans } = draw(seed);
      const named = ans.$ === "Named" ? [ans.profile] : [];
      await expectModelAgrees(members, ans, named);
    });
  }
});
