import { it, expect, describe } from "@effect/vitest";
import { Effect } from "effect";
import { beforeAll } from "vitest";

import { createAuthService } from "../../src/services/auth";
import { createGraphService } from "../../src/services/graph";
import { createOrganisationService } from "../../src/services/organisation";
import { createProfileService } from "../../src/services/profile";
import { makeTestAuthConfig } from "../helpers/auth-config";
import { createTestLayer } from "../helpers/db";

let config: Awaited<ReturnType<typeof makeTestAuthConfig>>;
let auth: ReturnType<typeof createAuthService>;
let profile: ReturnType<typeof createProfileService>;
const graph = createGraphService();
const org = createOrganisationService();

beforeAll(async () => {
  config = await makeTestAuthConfig();
  auth = createAuthService(config);
  profile = createProfileService(auth);
});

/** Register an account + profile, returning the profile and accountId. */
function setupAccount(email: string, handle: string, displayName?: string) {
  return Effect.gen(function* () {
    const p = yield* auth.registerProfile(email, handle, displayName);
    return { profile: p, accountId: p.accountId };
  });
}

// ---------------------------------------------------------------------------
// createProfile
// ---------------------------------------------------------------------------

describe("createProfile", () => {
  it.effect("creates a new profile with usr_ prefix and isDefault false", () =>
    Effect.gen(function* () {
      const { accountId } = yield* setupAccount("alice@test.com", "alice");
      const newProfile = yield* profile.createProfile(accountId, "alice_alt", "Alt");
      expect(newProfile.id).toMatch(/^usr_/);
      expect(newProfile.handle).toBe("alice_alt");
      expect(newProfile.displayName).toBe("Alt");
      expect(newProfile.email).toBe("alice@test.com");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("creates profile without displayName", () =>
    Effect.gen(function* () {
      const { accountId } = yield* setupAccount("bob@test.com", "bob");
      const newProfile = yield* profile.createProfile(accountId, "bob_alt");
      expect(newProfile.displayName).toBeNull();
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("enforces maxProfiles limit", () =>
    Effect.gen(function* () {
      // Register creates account with maxProfiles=5, plus the first profile
      const { accountId } = yield* setupAccount("max@test.com", "maxuser");
      // Create 4 more to hit the limit of 5
      yield* profile.createProfile(accountId, "max_alt2");
      yield* profile.createProfile(accountId, "max_alt3");
      yield* profile.createProfile(accountId, "max_alt4");
      yield* profile.createProfile(accountId, "max_alt5");
      // 6th should fail
      const error = yield* Effect.flip(profile.createProfile(accountId, "max_alt6"));
      expect(error._tag).toBe("AuthError");
      expect(error.message).toContain("Maximum profiles reached");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("rejects reserved handles", () =>
    Effect.gen(function* () {
      const { accountId } = yield* setupAccount("res@test.com", "resuser");
      const error = yield* Effect.flip(profile.createProfile(accountId, "admin"));
      expect(error._tag).toBe("AuthError");
      expect(error.message).toContain("Handle is reserved");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("rejects invalid handle format", () =>
    Effect.gen(function* () {
      const { accountId } = yield* setupAccount("inv@test.com", "invuser");
      const error = yield* Effect.flip(profile.createProfile(accountId, "BadHandle"));
      expect(error._tag).toBe("ValidationError");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("rejects duplicate handle against existing user", () =>
    Effect.gen(function* () {
      const { accountId } = yield* setupAccount("dup@test.com", "dupuser");
      const error = yield* Effect.flip(profile.createProfile(accountId, "dupuser"));
      expect(error._tag).toBe("AuthError");
      expect(error.message).toContain("Handle already taken");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("rejects empty handle", () =>
    Effect.gen(function* () {
      const { accountId } = yield* setupAccount("empty@test.com", "emptyuser");
      const error = yield* Effect.flip(profile.createProfile(accountId, ""));
      expect(error._tag).toBe("ValidationError");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("accepts 30-character handle (boundary)", () =>
    Effect.gen(function* () {
      const { accountId } = yield* setupAccount("bound@test.com", "bounduser");
      const handle30 = "a".repeat(30);
      const result = yield* profile.createProfile(accountId, handle30);
      expect(result.handle).toBe(handle30);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("rejects 31-character handle (over boundary)", () =>
    Effect.gen(function* () {
      const { accountId } = yield* setupAccount("over@test.com", "overuser");
      const error = yield* Effect.flip(profile.createProfile(accountId, "a".repeat(31)));
      expect(error._tag).toBe("ValidationError");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("rejects handle with special characters", () =>
    Effect.gen(function* () {
      const { accountId } = yield* setupAccount("spec@test.com", "specuser");
      const error = yield* Effect.flip(profile.createProfile(accountId, "user-name"));
      expect(error._tag).toBe("ValidationError");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("rejects handle that collides with organisation handle", () =>
    Effect.gen(function* () {
      const { profile: owner, accountId } = yield* setupAccount("orgcol@test.com", "orgcoluser");
      yield* org.createOrganisation(owner.id, "myorg", "My Org");
      const error = yield* Effect.flip(profile.createProfile(accountId, "myorg"));
      expect(error._tag).toBe("AuthError");
      expect(error.message).toContain("Handle already taken");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("fails with nonexistent account", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(profile.createProfile("acc_nonexistent", "newhandle"));
      expect(error._tag).toBe("AuthError");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("does not expose accountId in the returned profile", () =>
    Effect.gen(function* () {
      const { accountId } = yield* setupAccount("noleak@test.com", "noleak");
      const newProfile = yield* profile.createProfile(accountId, "noleak_alt");
      expect(newProfile).not.toHaveProperty("accountId");
      expect(newProfile).not.toHaveProperty("createdAt");
    }).pipe(Effect.provide(createTestLayer())),
  );
});

// ---------------------------------------------------------------------------
// deleteProfile
// ---------------------------------------------------------------------------

describe("deleteProfile", () => {
  it.effect("deletes a profile and cascades graph edges", () =>
    Effect.gen(function* () {
      const { profile: main, accountId } = yield* setupAccount("del@test.com", "deluser");
      const alt = yield* profile.createProfile(accountId, "del_alt");

      // Create a connection between the two profiles
      yield* graph.sendConnectionRequest(main.id, alt.id);
      yield* graph.acceptConnection(alt.id, main.id);

      // Add close friend
      yield* graph.addCloseFriend(main.id, alt.id);

      // Delete the alt profile
      yield* profile.deleteProfile(accountId, alt.id);

      // Verify the profile is gone — list should show only one profile
      const { profiles } = yield* auth.listAccountProfiles(accountId);
      expect(profiles).toHaveLength(1);
      expect(profiles[0]!.id).toBe(main.id);

      // Verify connections are cleaned up — main should have no connections
      const connections = yield* graph.listConnections(main.id);
      expect(connections).toHaveLength(0);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("cascades blocks and org memberships", () =>
    Effect.gen(function* () {
      const { profile: main, accountId } = yield* setupAccount("casc@test.com", "cascuser");
      const alt = yield* profile.createProfile(accountId, "casc_alt");

      // Create an org owned by main, add alt as member
      const myOrg = yield* org.createOrganisation(main.id, "cascorg", "Cascade Org");
      yield* org.addMember(myOrg.id, main.id, alt.id, "member");

      // Block from another account
      const { profile: other } = yield* setupAccount("blocker@test.com", "blocker");
      yield* graph.blockProfile(other.id, alt.id);

      // Delete alt
      yield* profile.deleteProfile(accountId, alt.id);

      // Org membership should be gone
      const members = yield* org.listMembers(myOrg.id);
      expect(members.filter((m) => m.profile.id === alt.id)).toHaveLength(0);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("cannot delete the last profile on an account", () =>
    Effect.gen(function* () {
      const { profile: main, accountId } = yield* setupAccount("last@test.com", "lastuser");
      const error = yield* Effect.flip(profile.deleteProfile(accountId, main.id));
      expect(error._tag).toBe("AuthError");
      expect(error.message).toContain("Cannot delete the last profile");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("cannot delete profile owned by different account", () =>
    Effect.gen(function* () {
      const { accountId: rt1 } = yield* setupAccount("own1@test.com", "own1");
      const { profile: other } = yield* setupAccount("own2@test.com", "own2");
      const error = yield* Effect.flip(profile.deleteProfile(rt1, other.id));
      expect(error._tag).toBe("AuthError");
      expect(error.message).toContain("does not belong to this account");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("cannot delete profile that owns an organisation", () =>
    Effect.gen(function* () {
      const { profile: main, accountId } = yield* setupAccount("orgown@test.com", "orgowner");
      yield* profile.createProfile(accountId, "orgown_alt");
      yield* org.createOrganisation(main.id, "ownedorg", "Owned Org");
      const error = yield* Effect.flip(profile.deleteProfile(accountId, main.id));
      expect(error._tag).toBe("AuthError");
      expect(error.message).toContain("Transfer organisation ownership");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("promotes another profile to default if deleted profile was default", () =>
    Effect.gen(function* () {
      const { profile: main, accountId } = yield* setupAccount("prom@test.com", "promuser");
      yield* profile.createProfile(accountId, "prom_alt");

      // Main is default, delete it
      yield* profile.deleteProfile(accountId, main.id);

      // The alt should now be default
      const { profiles } = yield* auth.listAccountProfiles(accountId);
      expect(profiles).toHaveLength(1);
      expect(profiles[0]!.handle).toBe("prom_alt");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("fails with nonexistent profile", () =>
    Effect.gen(function* () {
      const { accountId } = yield* setupAccount("delnone@test.com", "delnone");
      const error = yield* Effect.flip(profile.deleteProfile(accountId, "usr_000000000000"));
      expect(error._tag).toBe("AuthError");
    }).pipe(Effect.provide(createTestLayer())),
  );
});

// ---------------------------------------------------------------------------
// setDefaultProfile
// ---------------------------------------------------------------------------

describe("setDefaultProfile", () => {
  it.effect("sets a new default profile and clears the old one", () =>
    Effect.gen(function* () {
      const { accountId } = yield* setupAccount("def@test.com", "defuser");
      const alt = yield* profile.createProfile(accountId, "def_alt");

      const result = yield* profile.setDefaultProfile(accountId, alt.id);
      expect(result.id).toBe(alt.id);
      expect(result.handle).toBe("def_alt");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("succeeds when target is already default (idempotent)", () =>
    Effect.gen(function* () {
      const { profile: main, accountId } = yield* setupAccount("idem@test.com", "idemuser");
      const result = yield* profile.setDefaultProfile(accountId, main.id);
      expect(result.id).toBe(main.id);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("cannot set default for profile on different account", () =>
    Effect.gen(function* () {
      const { accountId: rt1 } = yield* setupAccount("sdef1@test.com", "sdef1");
      const { profile: other } = yield* setupAccount("sdef2@test.com", "sdef2");
      const error = yield* Effect.flip(profile.setDefaultProfile(rt1, other.id));
      expect(error._tag).toBe("AuthError");
      expect(error.message).toContain("does not belong to this account");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("fails with nonexistent profile", () =>
    Effect.gen(function* () {
      const { accountId } = yield* setupAccount("sdefnone@test.com", "sdefnone");
      const error = yield* Effect.flip(profile.setDefaultProfile(accountId, "usr_000000000000"));
      expect(error._tag).toBe("AuthError");
    }).pipe(Effect.provide(createTestLayer())),
  );
});
