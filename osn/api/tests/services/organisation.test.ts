import { it, expect, describe } from "@effect/vitest";
import { Effect } from "effect";
import { beforeAll } from "vitest";

import { createAuthService } from "../../src/services/auth";
import { createOrganisationService } from "../../src/services/organisation";
import { makeTestAuthConfig } from "../helpers/auth-config";
import { createTestLayer } from "../helpers/db";

let config: Awaited<ReturnType<typeof makeTestAuthConfig>>;
let auth: ReturnType<typeof createAuthService>;
const org = createOrganisationService();

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
  it.effect("returns the organisation by id", () =>
    Effect.gen(function* () {
      const { organisation } = yield* setupOrgWithOwner;
      const found = yield* org.getOrganisation(organisation.id);
      expect(found.handle).toBe("acme");
    }).pipe(Effect.provide(createTestLayer())),
  );

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
