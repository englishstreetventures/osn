import { it, expect, describe } from "@effect/vitest";
import { organisationMembers, organisations } from "@osn/db/schema";
import { Db } from "@osn/db/service";
import { and, eq, sql } from "drizzle-orm";
import { Effect, Fiber, Layer, type Result } from "effect";
import { afterEach, beforeAll, vi } from "vitest";

import { makeHeldHandleDigest } from "../../src/lib/handle-hold";
import { createAuthService } from "../../src/services/auth";
import { createOrganisationService } from "../../src/services/organisation";
import { createProfileService } from "../../src/services/profile";
import { makeTestAuthConfig } from "../helpers/auth-config";
import { createTestLayer, createTestLayerWithSqlite } from "../helpers/db";
import { holdQueries } from "../helpers/held-query";

let config: Awaited<ReturnType<typeof makeTestAuthConfig>>;
let auth: ReturnType<typeof createAuthService>;
const org = createOrganisationService({ heldHandleDigest: makeHeldHandleDigest(undefined) });

/** `declineOwnership` of the organisation `orgId` names, by its handle, as the route calls it. */
const declineById = (orgId: string, callerId: string) =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    const [row] = yield* Effect.promise(() =>
      db
        .select({ handle: organisations.handle })
        .from(organisations)
        .where(eq(organisations.id, orgId)),
    );
    return yield* org.declineOwnership(row!.handle, callerId);
  });

beforeAll(async () => {
  config = await makeTestAuthConfig();
  auth = createAuthService(config);
});

/** Register a user and return them. */
const registerProfile = (email: string, handle: string, displayName?: string) =>
  auth.registerProfile(email, handle, displayName);

/** Register two users. */
const setupTwoUsers = Effect.gen(function* () {
  const alice = yield* registerProfile("alice@example.com", "alice", "Alice");
  const bob = yield* registerProfile("bob@example.com", "bob", "Bob");
  return { alice, bob };
});

/** Register a user and create an org owned by them. */
const setupOrgWithOwner = Effect.gen(function* () {
  const alice = yield* registerProfile("alice@example.com", "alice", "Alice");
  const organisation = yield* org.createOrganisation(alice.id, "acme", "Acme Corp");
  return { alice, organisation };
});

// ---------------------------------------------------------------------------
// Organisation CRUD
// ---------------------------------------------------------------------------

describe("createOrganisation", () => {
  it.effect("creates an organisation and adds owner as admin", () =>
    Effect.gen(function* () {
      const alice = yield* registerProfile("alice@example.com", "alice");
      const organisation = yield* org.createOrganisation(
        alice.id,
        "acme",
        "Acme Corp",
        "A company",
      );

      expect(organisation.handle).toBe("acme");
      expect(organisation.name).toBe("Acme Corp");
      expect(organisation.description).toBe("A company");
      expect(organisation.ownerId).toBe(alice.id);

      // Owner should be an admin member
      const role = yield* org.getMemberRole(organisation.id, alice.id);
      expect(role).toBe("admin");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("fails when handle is already taken by a user", () =>
    Effect.gen(function* () {
      const alice = yield* registerProfile("alice@example.com", "alice");
      const error = yield* Effect.flip(org.createOrganisation(alice.id, "alice", "Alice Org"));
      expect(error._tag).toBe("OrgError");
      expect(error.message).toContain("Handle unavailable");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("fails when handle is reserved", () =>
    Effect.gen(function* () {
      const alice = yield* registerProfile("alice@example.com", "alice");
      // Org handles share the profile handle namespace (creation cross-checks
      // both tables), so the reserved list has to hold on this side too —
      // otherwise `admin` or the dev-login principal's own handle is takeable
      // as an org.
      for (const handle of ["admin", "dev_bootstrap", "dev_bootstrap_org"]) {
        const error = yield* Effect.flip(org.createOrganisation(alice.id, handle, "Squat Org"));
        expect(error._tag).toBe("OrgError");
        expect(error.message).toContain("Handle unavailable");
      }
    }).pipe(Effect.provide(createTestLayer())),
  );

  // A soft delete renames each profile to `deleted_` and its id's suffix,
  // and profile ids are visible to other people. Organisation handles share
  // the profile namespace, so the form is reserved here too.
  it.effect("fails when the handle has the form a soft delete gives a profile", () =>
    Effect.gen(function* () {
      const alice = yield* registerProfile("alice@example.com", "alice");
      const error = yield* Effect.flip(
        org.createOrganisation(alice.id, "deleted_0123456789ab", "Squat Org"),
      );
      expect(error._tag).toBe("OrgError");
      expect(error.message).toBe("Handle unavailable");
    }).pipe(Effect.provide(createTestLayer())),
  );

  // The pre-check sees the handle free; a twin row written in between, as a
  // parallel request would, makes the insert itself hit the unique index. The
  // database's reason sits below drizzle's "Failed query" message on both
  // drivers, so this is the case that proves it is read through the cause.
  it.effect("answers a handle taken between the check and the insert as unavailable", () => {
    const { layer, sqlite } = createTestLayerWithSqlite();
    return Effect.gen(function* () {
      const alice = yield* registerProfile("alice@example.com", "alice");
      sqlite.run(`
        CREATE TRIGGER race_organisation_handle BEFORE INSERT ON organisations
        WHEN NEW.id NOT LIKE '%_race'
        BEGIN
          INSERT INTO organisations (id, handle, name, owner_id, created_at, updated_at)
          VALUES (NEW.id || '_race', NEW.handle, NEW.name, NEW.owner_id, NEW.created_at, NEW.updated_at);
        END;
      `);
      const error = yield* Effect.flip(org.createOrganisation(alice.id, "racer", "Racer Org"));
      expect(error._tag).toBe("OrgError");
      expect(error.message).toContain("Handle unavailable");
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails when handle is already taken by another org", () =>
    Effect.gen(function* () {
      const alice = yield* registerProfile("alice@example.com", "alice");
      yield* org.createOrganisation(alice.id, "acme", "Acme Corp");
      const error = yield* Effect.flip(org.createOrganisation(alice.id, "acme", "Another Acme"));
      expect(error._tag).toBe("OrgError");
      expect(error.message).toContain("Handle unavailable");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("fails when owner does not exist", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        org.createOrganisation("usr_nonexistent", "acme", "Acme Corp"),
      );
      expect(error._tag).toBe("OrgError");
      expect(error.message).toContain("Owner not found");
    }).pipe(Effect.provide(createTestLayer())),
  );
});

describe("getOrganisation", () => {
  it.effect("fails when not found", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(org.getOrganisation("org_nonexistent"));
      expect(error._tag).toBe("NotFoundError");
    }).pipe(Effect.provide(createTestLayer())),
  );
});

describe("getOrganisationByHandle", () => {
  it.effect("returns the organisation by handle", () =>
    Effect.gen(function* () {
      yield* setupOrgWithOwner;
      const found = yield* org.getOrganisationByHandle("acme");
      expect(found).not.toBeNull();
      expect(found!.name).toBe("Acme Corp");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("returns null when not found", () =>
    Effect.gen(function* () {
      const found = yield* org.getOrganisationByHandle("nonexistent");
      expect(found).toBeNull();
    }).pipe(Effect.provide(createTestLayer())),
  );
});

describe("updateOrganisation", () => {
  it.effect("updates name and description when caller is admin", () =>
    Effect.gen(function* () {
      const { alice, organisation } = yield* setupOrgWithOwner;
      const updated = yield* org.updateOrganisation(organisation.id, alice.id, {
        name: "Acme Inc",
        description: "Updated",
      });
      expect(updated.name).toBe("Acme Inc");
      expect(updated.description).toBe("Updated");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("fails when caller is not an admin", () =>
    Effect.gen(function* () {
      const { organisation } = yield* setupOrgWithOwner;
      const bob = yield* registerProfile("bob@example.com", "bob");
      // Add bob as regular member
      yield* org.addMember(organisation.id, organisation.ownerId, bob.id, "member");
      const error = yield* Effect.flip(
        org.updateOrganisation(organisation.id, bob.id, { name: "Hacked" }),
      );
      expect(error._tag).toBe("OrgError");
      expect(error.message).toContain("admin");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("fails when org does not exist", () =>
    Effect.gen(function* () {
      const alice = yield* registerProfile("alice@example.com", "alice");
      const error = yield* Effect.flip(
        org.updateOrganisation("org_nonexistent", alice.id, { name: "X" }),
      );
      expect(error._tag).toBe("NotFoundError");
    }).pipe(Effect.provide(createTestLayer())),
  );
});

describe("deleteOrganisation", () => {
  it.effect("deletes org and all members when caller is owner", () =>
    Effect.gen(function* () {
      const { alice, organisation } = yield* setupOrgWithOwner;
      yield* org.deleteOrganisation(organisation.id, alice.id);
      const found = yield* org.getOrganisationByHandle("acme");
      expect(found).toBeNull();
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("fails when caller is admin but not owner", () =>
    Effect.gen(function* () {
      const { organisation } = yield* setupOrgWithOwner;
      const bob = yield* registerProfile("bob@example.com", "bob");
      yield* org.addMember(organisation.id, organisation.ownerId, bob.id, "admin");
      const error = yield* Effect.flip(org.deleteOrganisation(organisation.id, bob.id));
      expect(error._tag).toBe("OrgError");
      expect(error.message).toContain("owner");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("fails when org does not exist", () =>
    Effect.gen(function* () {
      const alice = yield* registerProfile("alice@example.com", "alice");
      const error = yield* Effect.flip(org.deleteOrganisation("org_nonexistent", alice.id));
      expect(error._tag).toBe("NotFoundError");
    }).pipe(Effect.provide(createTestLayer())),
  );
});

describe("listProfileOrganisations", () => {
  it.effect("returns all orgs the user belongs to", () =>
    Effect.gen(function* () {
      const alice = yield* registerProfile("alice@example.com", "alice");
      yield* org.createOrganisation(alice.id, "acme", "Acme Corp");
      yield* org.createOrganisation(alice.id, "globex", "Globex Corp");

      const list = yield* org.listProfileOrganisations(alice.id);
      const handles = list.map((o) => o.handle).toSorted();
      expect(handles).toEqual(["acme", "globex"]);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("returns empty when user has no orgs", () =>
    Effect.gen(function* () {
      const alice = yield* registerProfile("alice@example.com", "alice");
      const list = yield* org.listProfileOrganisations(alice.id);
      expect(list).toHaveLength(0);
    }).pipe(Effect.provide(createTestLayer())),
  );
});

// ---------------------------------------------------------------------------
// Membership management
// ---------------------------------------------------------------------------

describe("addMember", () => {
  it.effect("adds a user as a member", () =>
    Effect.gen(function* () {
      const { alice, organisation } = yield* setupOrgWithOwner;
      const bob = yield* registerProfile("bob@example.com", "bob");
      yield* org.addMember(organisation.id, alice.id, bob.id, "member");

      const role = yield* org.getMemberRole(organisation.id, bob.id);
      expect(role).toBe("member");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("fails when caller is not admin", () =>
    Effect.gen(function* () {
      const { organisation } = yield* setupOrgWithOwner;
      const bob = yield* registerProfile("bob@example.com", "bob");
      const carol = yield* registerProfile("carol@example.com", "carol");
      yield* org.addMember(organisation.id, organisation.ownerId, bob.id, "member");

      const error = yield* Effect.flip(org.addMember(organisation.id, bob.id, carol.id, "member"));
      expect(error._tag).toBe("OrgError");
      expect(error.message).toContain("admin");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("fails when user is already a member", () =>
    Effect.gen(function* () {
      const { alice, organisation } = yield* setupOrgWithOwner;
      const bob = yield* registerProfile("bob@example.com", "bob");
      yield* org.addMember(organisation.id, alice.id, bob.id, "member");

      const error = yield* Effect.flip(org.addMember(organisation.id, alice.id, bob.id, "member"));
      expect(error._tag).toBe("OrgError");
      expect(error.message).toContain("already a member");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("fails when target user does not exist", () =>
    Effect.gen(function* () {
      const { alice, organisation } = yield* setupOrgWithOwner;
      const error = yield* Effect.flip(
        org.addMember(organisation.id, alice.id, "usr_nonexistent", "member"),
      );
      expect(error._tag).toBe("OrgError");
      expect(error.message).toContain("Target profile not found");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("owner can grant admin", () =>
    Effect.gen(function* () {
      const { alice, organisation } = yield* setupOrgWithOwner;
      const bob = yield* registerProfile("bob@example.com", "bob");
      yield* org.addMember(organisation.id, alice.id, bob.id, "admin");
      const role = yield* org.getMemberRole(organisation.id, bob.id);
      expect(role).toBe("admin");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("non-owner admin cannot grant admin (owner-only role gate)", () =>
    Effect.gen(function* () {
      const { alice, organisation } = yield* setupOrgWithOwner;
      const bob = yield* registerProfile("bob@example.com", "bob");
      const carol = yield* registerProfile("carol@example.com", "carol");
      // Owner makes bob an admin; bob then tries to mint another admin.
      yield* org.addMember(organisation.id, alice.id, bob.id, "admin");
      const error = yield* Effect.flip(org.addMember(organisation.id, bob.id, carol.id, "admin"));
      expect(error._tag).toBe("OrgError");
      expect(error.message).toContain("owner");
      // ...but bob CAN still add a plain member.
      yield* org.addMember(organisation.id, bob.id, carol.id, "member");
      expect(yield* org.getMemberRole(organisation.id, carol.id)).toBe("member");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("fails when org does not exist", () =>
    Effect.gen(function* () {
      const alice = yield* registerProfile("alice@example.com", "alice");
      const error = yield* Effect.flip(
        org.addMember("org_nonexistent", alice.id, alice.id, "member"),
      );
      expect(error._tag).toBe("NotFoundError");
    }).pipe(Effect.provide(createTestLayer())),
  );
});

describe("removeMember", () => {
  it.effect("removes a member", () =>
    Effect.gen(function* () {
      const { alice, organisation } = yield* setupOrgWithOwner;
      const bob = yield* registerProfile("bob@example.com", "bob");
      yield* org.addMember(organisation.id, alice.id, bob.id, "member");
      yield* org.removeMember(organisation.id, alice.id, bob.id);

      const role = yield* org.getMemberRole(organisation.id, bob.id);
      expect(role).toBeNull();
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("fails when trying to remove the owner", () =>
    Effect.gen(function* () {
      const { alice, organisation } = yield* setupOrgWithOwner;
      const error = yield* Effect.flip(org.removeMember(organisation.id, alice.id, alice.id));
      expect(error._tag).toBe("OrgError");
      expect(error.message).toContain("owner");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("fails when caller is not admin", () =>
    Effect.gen(function* () {
      const { organisation } = yield* setupOrgWithOwner;
      const bob = yield* registerProfile("bob@example.com", "bob");
      const carol = yield* registerProfile("carol@example.com", "carol");
      yield* org.addMember(organisation.id, organisation.ownerId, bob.id, "member");
      yield* org.addMember(organisation.id, organisation.ownerId, carol.id, "member");

      const error = yield* Effect.flip(org.removeMember(organisation.id, bob.id, carol.id));
      expect(error._tag).toBe("OrgError");
      expect(error.message).toContain("admin");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("fails when member not found", () =>
    Effect.gen(function* () {
      const { alice, organisation } = yield* setupOrgWithOwner;
      const bob = yield* registerProfile("bob@example.com", "bob");
      const error = yield* Effect.flip(org.removeMember(organisation.id, alice.id, bob.id));
      expect(error._tag).toBe("NotFoundError");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("non-owner admin cannot remove another admin", () =>
    Effect.gen(function* () {
      const { alice, organisation } = yield* setupOrgWithOwner;
      const bob = yield* registerProfile("bob@example.com", "bob");
      const carol = yield* registerProfile("carol@example.com", "carol");
      yield* org.addMember(organisation.id, alice.id, bob.id, "admin");
      yield* org.addMember(organisation.id, alice.id, carol.id, "admin");
      // bob (admin, not owner) tries to strip fellow admin carol.
      const error = yield* Effect.flip(org.removeMember(organisation.id, bob.id, carol.id));
      expect(error._tag).toBe("OrgError");
      expect(error.message).toContain("owner");
      // The owner still can.
      yield* org.removeMember(organisation.id, alice.id, carol.id);
      expect(yield* org.getMemberRole(organisation.id, carol.id)).toBeNull();
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("admin can still remove a plain member", () =>
    Effect.gen(function* () {
      const { alice, organisation } = yield* setupOrgWithOwner;
      const bob = yield* registerProfile("bob@example.com", "bob");
      const carol = yield* registerProfile("carol@example.com", "carol");
      yield* org.addMember(organisation.id, alice.id, bob.id, "admin");
      yield* org.addMember(organisation.id, alice.id, carol.id, "member");
      yield* org.removeMember(organisation.id, bob.id, carol.id);
      expect(yield* org.getMemberRole(organisation.id, carol.id)).toBeNull();
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("fails when org does not exist", () =>
    Effect.gen(function* () {
      const alice = yield* registerProfile("alice@example.com", "alice");
      const error = yield* Effect.flip(org.removeMember("org_nonexistent", alice.id, alice.id));
      expect(error._tag).toBe("NotFoundError");
    }).pipe(Effect.provide(createTestLayer())),
  );
});

describe("updateMemberRole", () => {
  it.effect("owner can promote member to admin", () =>
    Effect.gen(function* () {
      const { alice, organisation } = yield* setupOrgWithOwner;
      const bob = yield* registerProfile("bob@example.com", "bob");
      yield* org.addMember(organisation.id, alice.id, bob.id, "member");
      yield* org.updateMemberRole(organisation.id, alice.id, bob.id, "admin");

      const role = yield* org.getMemberRole(organisation.id, bob.id);
      expect(role).toBe("admin");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("owner can demote admin to member", () =>
    Effect.gen(function* () {
      const { alice, organisation } = yield* setupOrgWithOwner;
      const bob = yield* registerProfile("bob@example.com", "bob");
      yield* org.addMember(organisation.id, alice.id, bob.id, "admin");
      yield* org.updateMemberRole(organisation.id, alice.id, bob.id, "member");

      const role = yield* org.getMemberRole(organisation.id, bob.id);
      expect(role).toBe("member");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("fails when non-owner tries to change roles", () =>
    Effect.gen(function* () {
      const { organisation } = yield* setupOrgWithOwner;
      const bob = yield* registerProfile("bob@example.com", "bob");
      const carol = yield* registerProfile("carol@example.com", "carol");
      yield* org.addMember(organisation.id, organisation.ownerId, bob.id, "admin");
      yield* org.addMember(organisation.id, organisation.ownerId, carol.id, "member");

      const error = yield* Effect.flip(
        org.updateMemberRole(organisation.id, bob.id, carol.id, "admin"),
      );
      expect(error._tag).toBe("OrgError");
      expect(error.message).toContain("owner");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("fails when trying to change owner's role", () =>
    Effect.gen(function* () {
      const { alice, organisation } = yield* setupOrgWithOwner;
      const error = yield* Effect.flip(
        org.updateMemberRole(organisation.id, alice.id, alice.id, "member"),
      );
      expect(error._tag).toBe("OrgError");
      expect(error.message).toContain("owner's role");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("fails when org does not exist", () =>
    Effect.gen(function* () {
      const alice = yield* registerProfile("alice@example.com", "alice");
      const error = yield* Effect.flip(
        org.updateMemberRole("org_nonexistent", alice.id, alice.id, "admin"),
      );
      expect(error._tag).toBe("NotFoundError");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("fails when target member not found", () =>
    Effect.gen(function* () {
      const { alice, organisation } = yield* setupOrgWithOwner;
      const bob = yield* registerProfile("bob@example.com", "bob");
      const error = yield* Effect.flip(
        org.updateMemberRole(organisation.id, alice.id, bob.id, "admin"),
      );
      expect(error._tag).toBe("NotFoundError");
    }).pipe(Effect.provide(createTestLayer())),
  );
});

describe("listMembers", () => {
  it.effect("returns all members with roles", () =>
    Effect.gen(function* () {
      const { alice, organisation } = yield* setupOrgWithOwner;
      const bob = yield* registerProfile("bob@example.com", "bob");
      yield* org.addMember(organisation.id, alice.id, bob.id, "member");

      const members = yield* org.listMembers(organisation.id);
      expect(members).toHaveLength(2);
      const handles = members.map((m) => m.profile.handle).toSorted();
      expect(handles).toEqual(["alice", "bob"]);
      const aliceMember = members.find((m) => m.profile.handle === "alice");
      expect(aliceMember?.role).toBe("admin");
      const bobMember = members.find((m) => m.profile.handle === "bob");
      expect(bobMember?.role).toBe("member");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("projects only id, handle and displayName on each profile", () =>
    Effect.gen(function* () {
      const { organisation } = yield* setupOrgWithOwner;

      const members = yield* org.listMembers(organisation.id);
      expect(members).toHaveLength(1);
      expect(Object.keys(members[0].profile).toSorted()).toEqual(["displayName", "handle", "id"]);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("fails when org not found", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(org.listMembers("org_nonexistent"));
      expect(error._tag).toBe("NotFoundError");
    }).pipe(Effect.provide(createTestLayer())),
  );
});

describe("getMemberRole", () => {
  it.effect("returns null for non-members", () =>
    Effect.gen(function* () {
      const { organisation } = yield* setupOrgWithOwner;
      const bob = yield* registerProfile("bob@example.com", "bob");
      const role = yield* org.getMemberRole(organisation.id, bob.id);
      expect(role).toBeNull();
    }).pipe(Effect.provide(createTestLayer())),
  );
});

// ---------------------------------------------------------------------------
// User can belong to many organisations
// ---------------------------------------------------------------------------

describe("multi-org membership", () => {
  it.effect("user can be a member of multiple orgs", () =>
    Effect.gen(function* () {
      const { alice, bob } = yield* setupTwoUsers;
      const org1 = yield* org.createOrganisation(alice.id, "org_one", "Org One");
      const org2 = yield* org.createOrganisation(alice.id, "org_two", "Org Two");
      yield* org.addMember(org1.id, alice.id, bob.id, "member");
      yield* org.addMember(org2.id, alice.id, bob.id, "admin");

      const bobOrgs = yield* org.listProfileOrganisations(bob.id);
      expect(bobOrgs).toHaveLength(2);

      const role1 = yield* org.getMemberRole(org1.id, bob.id);
      const role2 = yield* org.getMemberRole(org2.id, bob.id);
      expect(role1).toBe("member");
      expect(role2).toBe("admin");
    }).pipe(Effect.provide(createTestLayer())),
  );
});

/**
 * Every membership write is checked and written in separate statements, so
 * each write names what its checks read — the caller still an admin, the
 * member's row and role as read — and writes nothing once another request has
 * changed them. The refusal is the one the checks would give had they run
 * afterwards. Each case holds the write until the other request has landed.
 */
describe("a membership write holds only while what it checked still holds", () => {
  /** The organisation service on a database whose statements a test can hold. */
  function held() {
    const { db, sqlite, email } = createTestLayerWithSqlite();
    const queries = holdQueries(db);
    return {
      layer: Layer.merge(Layer.succeed(Db, { db: queries.db }), email.layer),
      hold: queries.hold,
      membershipRows: (orgId: string, profileId: string) =>
        (
          sqlite
            .query(
              "SELECT COUNT(*) AS n FROM organisation_members WHERE organisation_id = ? AND profile_id = ?",
            )
            .get(orgId, profileId) as { n: number }
        ).n,
    };
  }

  /** The refusal's message, or `"ok"`. */
  const answer = (outcome: Result.Result<unknown, { readonly message?: string }>) =>
    outcome._tag === "Success" ? "ok" : (outcome.failure.message ?? "no message");

  /** Runs `write` with its statement matching `pattern` held until `between` has run. */
  const across = <E extends { readonly message?: string }>(
    h: ReturnType<typeof held>,
    pattern: RegExp,
    write: Effect.Effect<unknown, E, Db>,
    between: Effect.Effect<unknown, unknown, Db>,
  ) =>
    Effect.gen(function* () {
      const gate = h.hold(pattern);
      const fiber = yield* Effect.forkChild(Effect.result(write));
      yield* Effect.promise(() => gate.reached);
      yield* between;
      gate.release();
      return answer(yield* Fiber.join(fiber));
    });

  /** alice owns "acme"; bob is an admin, carol a member, dave not in it. */
  const setupTeam = Effect.gen(function* () {
    const { alice, organisation } = yield* setupOrgWithOwner;
    const bob = yield* registerProfile("bob@example.com", "bob");
    const carol = yield* registerProfile("carol@example.com", "carol");
    const dave = yield* registerProfile("dave@example.com", "dave");
    yield* org.addMember(organisation.id, alice.id, bob.id, "admin");
    yield* org.addMember(organisation.id, alice.id, carol.id, "member");
    return { alice, bob, carol, dave, orgId: organisation.id };
  });

  const removal = /^delete from "organisation_members"/;

  it.live("an admin's removal leaves a member the owner has promoted since", () => {
    const h = held();
    return Effect.gen(function* () {
      const { alice, bob, carol, orgId } = yield* setupTeam;
      const removed = yield* across(
        h,
        removal,
        org.removeMember(orgId, bob.id, carol.id),
        org.updateMemberRole(orgId, alice.id, carol.id, "admin"),
      );
      expect(removed).toBe("Only the owner can remove an admin");
      expect(yield* org.getMemberRole(orgId, carol.id)).toBe("admin");
    }).pipe(Effect.provide(h.layer));
  });

  it.live("an admin demoted since its check removes no one", () => {
    const h = held();
    return Effect.gen(function* () {
      const { alice, bob, carol, orgId } = yield* setupTeam;
      const removed = yield* across(
        h,
        removal,
        org.removeMember(orgId, bob.id, carol.id),
        org.updateMemberRole(orgId, alice.id, bob.id, "member"),
      );
      expect(removed).toBe("Only admins can remove members");
      expect(yield* org.getMemberRole(orgId, carol.id)).toBe("member");
    }).pipe(Effect.provide(h.layer));
  });

  it.live("the owner's removal of a member already removed answers as a repeat would", () => {
    const h = held();
    return Effect.gen(function* () {
      const { alice, bob, carol, orgId } = yield* setupTeam;
      const removed = yield* across(
        h,
        removal,
        org.removeMember(orgId, alice.id, carol.id),
        org.removeMember(orgId, bob.id, carol.id),
      );
      expect(removed).toBe("Member not found");
    }).pipe(Effect.provide(h.layer));
  });

  it.live("an admin's removal of a member already removed answers as a repeat would", () => {
    const h = held();
    return Effect.gen(function* () {
      const { alice, bob, carol, orgId } = yield* setupTeam;
      const removed = yield* across(
        h,
        removal,
        org.removeMember(orgId, bob.id, carol.id),
        org.removeMember(orgId, alice.id, carol.id),
      );
      expect(removed).toBe("Member not found");
    }).pipe(Effect.provide(h.layer));
  });

  it.live("the owner removes an admin whatever role it holds by the time of the delete", () => {
    const h = held();
    return Effect.gen(function* () {
      const { alice, bob, orgId } = yield* setupTeam;
      const removed = yield* across(
        h,
        removal,
        org.removeMember(orgId, alice.id, bob.id),
        org.updateMemberRole(orgId, alice.id, bob.id, "member"),
      );
      expect(removed).toBe("ok");
      expect(yield* org.getMemberRole(orgId, bob.id)).toBeNull();
    }).pipe(Effect.provide(h.layer));
  });

  it.live("a removal in an organisation deleted since answers that it is gone", () => {
    const h = held();
    return Effect.gen(function* () {
      const { alice, bob, carol, orgId } = yield* setupTeam;
      const removed = yield* across(
        h,
        removal,
        org.removeMember(orgId, bob.id, carol.id),
        org.deleteOrganisation(orgId, alice.id),
      );
      expect(removed).toBe("Organisation not found");
    }).pipe(Effect.provide(h.layer));
  });

  it.live("an admin demoted since its check adds no one", () => {
    const h = held();
    return Effect.gen(function* () {
      const { alice, bob, dave, orgId } = yield* setupTeam;
      const added = yield* across(
        h,
        /^insert into "organisation_members"/,
        org.addMember(orgId, bob.id, dave.id, "member"),
        org.updateMemberRole(orgId, alice.id, bob.id, "member"),
      );
      expect(added).toBe("Only admins can add members");
      expect(h.membershipRows(orgId, dave.id)).toBe(0);
    }).pipe(Effect.provide(h.layer));
  });

  it.live("of two adds of one profile at once, the second answers as a repeat would", () => {
    const h = held();
    return Effect.gen(function* () {
      const { alice, bob, dave, orgId } = yield* setupTeam;
      const added = yield* across(
        h,
        /^insert into "organisation_members"/,
        org.addMember(orgId, bob.id, dave.id, "member"),
        org.addMember(orgId, alice.id, dave.id, "member"),
      );
      expect(added).toBe("Profile is already a member");
      expect(h.membershipRows(orgId, dave.id)).toBe(1);
    }).pipe(Effect.provide(h.layer));
  });

  it.live("an add to an organisation deleted since answers that it is gone", () => {
    const h = held();
    return Effect.gen(function* () {
      const { alice, bob, dave, orgId } = yield* setupTeam;
      const added = yield* across(
        h,
        /^insert into "organisation_members"/,
        org.addMember(orgId, bob.id, dave.id, "member"),
        org.deleteOrganisation(orgId, alice.id),
      );
      expect(added).toBe("Organisation not found");
      expect(h.membershipRows(orgId, dave.id)).toBe(0);
    }).pipe(Effect.provide(h.layer));
  });

  it.live("a role change for a member removed since answers that the member is gone", () => {
    const h = held();
    return Effect.gen(function* () {
      const { alice, bob, carol, orgId } = yield* setupTeam;
      const changed = yield* across(
        h,
        /^update "organisation_members"/,
        org.updateMemberRole(orgId, alice.id, carol.id, "admin"),
        org.removeMember(orgId, bob.id, carol.id),
      );
      expect(changed).toBe("Member not found");
      expect(h.membershipRows(orgId, carol.id)).toBe(0);
    }).pipe(Effect.provide(h.layer));
  });

  it.live("a role change in an organisation deleted since answers that it is gone", () => {
    const h = held();
    return Effect.gen(function* () {
      const { alice, carol, orgId } = yield* setupTeam;
      const changed = yield* across(
        h,
        /^update "organisation_members"/,
        org.updateMemberRole(orgId, alice.id, carol.id, "admin"),
        org.deleteOrganisation(orgId, alice.id),
      );
      expect(changed).toBe("Organisation not found");
    }).pipe(Effect.provide(h.layer));
  });

  it.live(
    "a role change by an owner who has since passed the organisation on changes nothing",
    () => {
      // The owner moves only in the hard delete of the owner's account, which
      // hands the organisation to another member in one batch.
      const h = held();
      return Effect.gen(function* () {
        const { alice, bob, carol, orgId } = yield* setupTeam;
        const changed = yield* across(
          h,
          /^update "organisation_members"/,
          org.updateMemberRole(orgId, alice.id, carol.id, "admin"),
          Effect.gen(function* () {
            const { db } = yield* Db;
            yield* Effect.promise(() =>
              db.update(organisations).set({ ownerId: bob.id }).where(eq(organisations.id, orgId)),
            );
          }),
        );
        expect(changed).toBe("Only the owner can change roles");
        expect(yield* org.getMemberRole(orgId, carol.id)).toBe("member");
      }).pipe(Effect.provide(h.layer));
    },
  );

  it.live("an admin demoted since its check leaves the organisation as it was", () => {
    const h = held();
    return Effect.gen(function* () {
      const { alice, bob, orgId } = yield* setupTeam;
      const updated = yield* across(
        h,
        /^update "organisations"/,
        org.updateOrganisation(orgId, bob.id, { name: "Renamed" }),
        org.updateMemberRole(orgId, alice.id, bob.id, "member"),
      );
      expect(updated).toBe("Only admins can update the organisation");
      expect((yield* org.getOrganisation(orgId)).name).toBe("Acme Corp");
    }).pipe(Effect.provide(h.layer));
  });

  it.live("an update to an organisation deleted since answers that it is gone", () => {
    const h = held();
    return Effect.gen(function* () {
      const { alice, bob, orgId } = yield* setupTeam;
      const updated = yield* across(
        h,
        /^update "organisations"/,
        org.updateOrganisation(orgId, bob.id, { name: "Renamed" }),
        org.deleteOrganisation(orgId, alice.id),
      );
      expect(updated).toBe("Organisation not found");
    }).pipe(Effect.provide(h.layer));
  });

  // An owner can change between a read and a write: a member who received
  // the organisation by succession declines it, and the next one has it.
  // The old owner's writes in flight then change nothing.
  it.live("an old owner's removal held across a decline removes no one", () => {
    const h = held();
    return Effect.gen(function* () {
      const { alice, carol, orgId } = yield* setupTeam;
      yield* inheritedNow(orgId);
      const removed = yield* across(
        h,
        removal,
        org.removeMember(orgId, alice.id, carol.id),
        declineById(orgId, alice.id),
      );
      expect(removed).toBe("Only admins can remove members");
      expect(yield* org.getMemberRole(orgId, carol.id)).toBe("member");
    }).pipe(Effect.provide(h.layer));
  });

  it.live(
    "a profile's delete held across a decline that makes it the owner deletes nothing",
    () => {
      // The decline passes acme to bob's second profile while bob's account is
      // deleting that profile: the delete, read before the decline, must not
      // remove an owner or its membership, and refuses as it would now.
      const h = held();
      return Effect.gen(function* () {
        const { alice, organisation } = yield* setupOrgWithOwner;
        const bob = yield* registerProfile("bob@example.com", "bob");
        const heir = yield* createProfileService(auth).createProfile(bob.accountId, "bobtwo");
        yield* org.addMember(organisation.id, alice.id, heir.id, "admin");
        yield* inheritedNow(organisation.id);
        const deleted = yield* across(
          h,
          /^delete from "connections"/,
          createProfileService(auth).deleteProfile(bob.accountId, heir.id),
          declineById(organisation.id, alice.id),
        );
        expect(deleted).toBe("Delete the organisations this profile owns before deleting it");
        expect((yield* org.getOrganisation(organisation.id)).ownerId).toBe(heir.id);
        expect(yield* org.getMemberRole(organisation.id, heir.id)).toBe("admin");
      }).pipe(Effect.provide(h.layer));
    },
  );

  it.live("a decline held across another decline of the same organisation writes nothing", () => {
    // Two declines at once: the second, read before the first committed, finds
    // its caller no longer the owner and changes nothing.
    const h = held();
    return Effect.gen(function* () {
      const { alice, bob, carol, orgId } = yield* setupTeam;
      yield* inheritedNow(orgId);
      const second = yield* across(
        h,
        /^delete from "organisation_members"/,
        declineById(orgId, alice.id).pipe(Effect.map((r) => r.outcome)),
        declineById(orgId, alice.id),
      );
      expect(second).toBe("ok");
      expect((yield* org.getOrganisation(orgId)).ownerId).toBe(bob.id);
      expect(yield* org.getMemberRole(orgId, bob.id)).toBe("admin");
      expect(yield* org.getMemberRole(orgId, carol.id)).toBe("member");
    }).pipe(Effect.provide(h.layer));
  });

  it.live("an old owner's delete held across a decline leaves the new owner's organisation", () => {
    const h = held();
    return Effect.gen(function* () {
      const { alice, bob, orgId } = yield* setupTeam;
      yield* inheritedNow(orgId);
      const deleted = yield* across(
        h,
        removal,
        org.deleteOrganisation(orgId, alice.id),
        declineById(orgId, alice.id),
      );
      expect(deleted).toBe("Only the owner can delete the organisation");
      expect((yield* org.getOrganisation(orgId)).ownerId).toBe(bob.id);
      expect(yield* org.getMemberRole(orgId, bob.id)).toBe("admin");
    }).pipe(Effect.provide(h.layer));
  });
});

/** Sets when `profileId` joined `orgId`, in seconds since the epoch. */
const joinedAt = (orgId: string, profileId: string, seconds: number) =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    yield* Effect.promise(() =>
      db
        .update(organisationMembers)
        .set({ createdAt: new Date(seconds * 1_000) })
        .where(
          and(
            eq(organisationMembers.organisationId, orgId),
            eq(organisationMembers.profileId, profileId),
          ),
        ),
    );
  });

/** Marks `orgId`'s owner as having received it by succession `secondsAgo` ago. */
const inheritedNow = (orgId: string, secondsAgo = 0) =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    yield* Effect.promise(() =>
      db
        .update(organisations)
        .set({ ownerInheritedAt: Math.floor(Date.now() / 1_000) - secondsAgo })
        .where(eq(organisations.id, orgId)),
    );
  });

/**
 * A member who received an organisation by succession may hand it back for
 * 30 days: it passes as the hard delete would pass it without them, or is
 * deleted when no one else could take it, and they leave it either way.
 */
describe("declineOwnership", () => {
  /** alice received "acme"; bob and carol are members from other accounts. */
  const setup = (bobRole: "admin" | "member", carolRole: "admin" | "member") =>
    Effect.gen(function* () {
      const { alice, organisation } = yield* setupOrgWithOwner;
      const bob = yield* registerProfile("bob@example.com", "bob");
      const carol = yield* registerProfile("carol@example.com", "carol");
      yield* org.addMember(organisation.id, alice.id, bob.id, bobRole);
      yield* org.addMember(organisation.id, alice.id, carol.id, carolRole);
      // Bob joined first. `created_at` is in seconds, so two members added in
      // one second would tie and the random id would choose between them.
      yield* joinedAt(organisation.id, bob.id, 100);
      yield* joinedAt(organisation.id, carol.id, 200);
      yield* inheritedNow(organisation.id);
      return { alice, bob, carol, orgId: organisation.id };
    });

  it.effect(
    "passes to the longest-standing admin from another account, and the decliner leaves",
    () =>
      Effect.gen(function* () {
        const { alice, bob, carol, orgId } = yield* setup("member", "admin");
        const result = yield* declineById(orgId, alice.id);
        expect(result).toMatchObject({
          outcome: "passed",
          handle: "acme",
          newOwnerEmail: "carol@example.com",
        });
        const after = yield* org.getOrganisation(orgId);
        expect(after.ownerId).toBe(carol.id);
        // The new owner may decline in turn.
        expect(after.ownerInheritedAt).not.toBeNull();
        expect(yield* org.getMemberRole(orgId, alice.id)).toBeNull();
        expect(yield* org.getMemberRole(orgId, bob.id)).toBe("member");
      }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("with no other admin, makes the longest-standing member its admin and owner", () =>
    Effect.gen(function* () {
      const { alice, bob, orgId } = yield* setup("member", "member");
      expect((yield* declineById(orgId, alice.id)).outcome).toBe("passed");
      expect((yield* org.getOrganisation(orgId)).ownerId).toBe(bob.id);
      expect(yield* org.getMemberRole(orgId, bob.id)).toBe("admin");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect(
    "with no member from another account, deletes it, never passing it to the decliner's own profile",
    () =>
      Effect.gen(function* () {
        const { alice, organisation } = yield* setupOrgWithOwner;
        const { db } = yield* Db;
        // A second profile on alice's own account, an admin of the organisation.
        const own = "usr_" + crypto.randomUUID().replace(/-/g, "").slice(0, 12);
        yield* Effect.sync(() =>
          db.run(
            sql`INSERT INTO users (id, account_id, handle, is_default, created_at, updated_at) VALUES (${own}, ${alice.accountId}, 'alicetwo', 0, 0, 0)`,
          ),
        );
        yield* org.addMember(organisation.id, alice.id, own, "admin");
        yield* inheritedNow(organisation.id);

        expect(yield* declineById(organisation.id, alice.id)).toEqual({
          outcome: "deleted",
        });
        const left = yield* Effect.promise(() =>
          db.select().from(organisations).where(eq(organisations.id, organisation.id)),
        );
        expect(left).toEqual([]);
        expect(yield* org.getMemberRole(organisation.id, own)).toBeNull();
      }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("refuses someone who does not own it, and changes nothing", () =>
    Effect.gen(function* () {
      const { alice, bob, orgId } = yield* setup("admin", "member");
      expect(yield* declineById(orgId, bob.id)).toEqual({ outcome: "not_owner" });
      expect((yield* org.getOrganisation(orgId)).ownerId).toBe(alice.id);
      expect(yield* org.getMemberRole(orgId, bob.id)).toBe("admin");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("refuses one who declined it already: no longer the owner", () =>
    Effect.gen(function* () {
      const { alice, bob, orgId } = yield* setup("admin", "member");
      expect((yield* declineById(orgId, alice.id)).outcome).toBe("passed");
      expect(yield* declineById(orgId, alice.id)).toEqual({ outcome: "not_owner" });
      expect((yield* org.getOrganisation(orgId)).ownerId).toBe(bob.id);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("refuses an owner who created it", () =>
    Effect.gen(function* () {
      const { alice, organisation } = yield* setupOrgWithOwner;
      const bob = yield* registerProfile("bob@example.com", "bob");
      yield* org.addMember(organisation.id, alice.id, bob.id, "admin");
      expect(yield* declineById(organisation.id, alice.id)).toEqual({
        outcome: "not_declinable",
      });
      expect((yield* org.getOrganisation(organisation.id)).ownerId).toBe(alice.id);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("refuses an owner who received it more than 30 days ago", () =>
    Effect.gen(function* () {
      const { alice, orgId } = yield* setup("admin", "member");
      yield* inheritedNow(orgId, 30 * 24 * 60 * 60 + 1);
      expect(yield* declineById(orgId, alice.id)).toEqual({ outcome: "not_declinable" });
      expect((yield* org.getOrganisation(orgId)).ownerId).toBe(alice.id);
      expect(yield* org.getMemberRole(orgId, alice.id)).toBe("admin");
    }).pipe(Effect.provide(createTestLayer())),
  );

  // The window's edge, on a clock held still so the read and the write agree.
  describe("at the edge of the 30 days", () => {
    afterEach(() => {
      vi.useRealTimers();
    });
    const THIRTY_DAYS = 30 * 24 * 60 * 60;

    it.effect("refuses one received exactly 30 days ago", () =>
      Effect.gen(function* () {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(new Date("2026-11-16T12:00:00Z"));
        const { alice, orgId } = yield* setup("admin", "member");
        yield* inheritedNow(orgId, THIRTY_DAYS);
        expect(yield* declineById(orgId, alice.id)).toEqual({
          outcome: "not_declinable",
        });
      }).pipe(Effect.provide(createTestLayer())),
    );

    it.effect("takes one received a second inside the 30 days", () =>
      Effect.gen(function* () {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(new Date("2026-11-16T12:00:00Z"));
        const { alice, orgId } = yield* setup("admin", "member");
        yield* inheritedNow(orgId, THIRTY_DAYS - 1);
        expect((yield* declineById(orgId, alice.id)).outcome).toBe("passed");
      }).pipe(Effect.provide(createTestLayer())),
    );
  });
});
