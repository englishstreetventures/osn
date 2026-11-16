import { organisationMembers, organisations } from "@osn/db/schema";
import type { Db } from "@osn/db/service";
import type { EmailService } from "@shared/email";
import type { RateLimiterBackend } from "@shared/rate-limit";
import { and, eq } from "drizzle-orm";
import { Effect, type Layer } from "effect";
import { beforeAll, describe, expect, it } from "vitest";

import { makeHeldHandleDigest } from "../../src/lib/handle-hold";
import { createOrganisationRoutes } from "../../src/routes/organisation";
import { requestErasure } from "../../src/services/account-erasure";
import { createAuthService } from "../../src/services/auth";
import { createOrganisationService } from "../../src/services/organisation";
import { makeTestAuthConfig } from "../helpers/auth-config";
import { settledHandle } from "../helpers/background";
import { createTestLayerWithSqlite } from "../helpers/db";

/**
 * `POST /organisations/:handle/decline-ownership` as a request reaches it:
 * who may send it, what each refusal answers, and the email to the next
 * owner. Each case is red on one wrong line of the route. What the decline
 * does to the rows is `tests/services/organisation.test.ts` (`declineOwnership`).
 */

let config: Awaited<ReturnType<typeof makeTestAuthConfig>>;

beforeAll(async () => {
  config = await makeTestAuthConfig();
});

const allow = { check: async () => true } as RateLimiterBackend;
const deny = { check: async () => false } as RateLimiterBackend;

const runOn = <A, E, R>(layer: Layer.Layer<Db | EmailService>, effect: Effect.Effect<A, E, R>) =>
  Effect.runPromise(effect.pipe(Effect.provide(layer)) as Effect.Effect<A, E, never>);

/**
 * Alice owns "acme" by succession, received now; bob is a member from another
 * account. The routes run on `limiter`, with a recording mail transport.
 */
async function seed(limiter: RateLimiterBackend = allow, members = true) {
  const { layer, email, db } = createTestLayerWithSqlite();
  const auth = createAuthService(config);
  const orgs = createOrganisationService({ heldHandleDigest: makeHeldHandleDigest(undefined) });
  const alice = await runOn(layer, auth.registerProfile("alice@example.com", "alice"));
  const bob = await runOn(layer, auth.registerProfile("bob@example.com", "bob"));
  const acme = await runOn(layer, orgs.createOrganisation(alice.id, "acme", "Acme"));
  if (members) await runOn(layer, orgs.addMember(acme.id, alice.id, bob.id, "member"));
  const inherit = () =>
    db
      .update(organisations)
      .set({ ownerInheritedAt: Math.floor(Date.now() / 1_000) })
      .where(eq(organisations.id, acme.id));
  await inherit();
  const tokenOf = async (profile: typeof alice) =>
    (
      await runOn(
        layer,
        auth.issueTokens(
          profile.id,
          profile.accountId,
          profile.email,
          profile.handle,
          profile.displayName,
        ),
      )
    ).accessToken;
  const app = createOrganisationRoutes(config, layer, undefined, limiter);
  const decline = (handle: string, token: string | null) =>
    settledHandle(
      app,
      new Request(`http://localhost/organisations/${handle}/decline-ownership`, {
        method: "POST",
        headers: token === null ? {} : { Authorization: `Bearer ${token}` },
      }),
    );
  const ownerOf = async () =>
    (
      await db
        .select({ ownerId: organisations.ownerId })
        .from(organisations)
        .where(eq(organisations.id, acme.id))
    )[0]?.ownerId ?? null;
  const membership = async (profileId: string) =>
    (
      await db
        .select({ role: organisationMembers.role })
        .from(organisationMembers)
        .where(
          and(
            eq(organisationMembers.organisationId, acme.id),
            eq(organisationMembers.profileId, profileId),
          ),
        )
    )[0]?.role ?? null;
  const sent = () =>
    email.recorded().filter((m) => m.template === "organisation-ownership-received");
  return { layer, auth, alice, bob, acme, tokenOf, decline, ownerOf, membership, sent, db };
}

describe("POST /organisations/:handle/decline-ownership", () => {
  it("passes it to the next member, mails them a link to decline in turn, and the decliner leaves", async () => {
    const h = await seed();
    const res = await h.decline("acme", await h.tokenOf(h.alice));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ outcome: "passed" });
    expect(await h.ownerOf()).toBe(h.bob.id);
    expect(await h.membership(h.alice.id)).toBeNull();

    const [mail, ...more] = h.sent();
    expect(more).toEqual([]);
    expect(mail!.to).toBe("bob@example.com");
    expect(mail!.text).toContain("/organisations/acme?decline=1");
    expect(mail!.text).toContain("declined it");
  });

  it("deletes it when no one else could take it, and mails no one", async () => {
    const h = await seed(allow, false);
    const res = await h.decline("acme", await h.tokenOf(h.alice));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ outcome: "deleted" });
    expect(await h.ownerOf()).toBeNull();
    expect(h.sent()).toEqual([]);
  });

  it("refuses a request with no token", async () => {
    const h = await seed();
    expect((await h.decline("acme", null)).status).toBe(401);
    expect(await h.ownerOf()).toBe(h.alice.id);
  });

  it("refuses a token that does not verify", async () => {
    const h = await seed();
    expect((await h.decline("acme", "not.a.token")).status).toBe(401);
    expect(await h.ownerOf()).toBe(h.alice.id);
  });

  it("refuses the token of an account whose deletion is pending", async () => {
    const h = await seed();
    await runOn(
      h.layer,
      requestErasure({
        accountId: h.alice.accountId,
        cancel: null,
        heldHandleDigest: h.auth.heldHandleDigest,
      }),
    );
    // Minted now, the token is on the pending-deletion audience.
    const pending = await h.tokenOf(h.alice);
    expect((await h.decline("acme", pending)).status).toBe(401);
    expect(await h.ownerOf()).toBe(h.alice.id);
  });

  it("refuses a member who does not own it, 403 not_owner, and changes nothing", async () => {
    const h = await seed();
    const res = await h.decline("acme", await h.tokenOf(h.bob));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "not_owner" });
    expect(await h.ownerOf()).toBe(h.alice.id);
    expect(h.sent()).toEqual([]);
  });

  it("refuses the owner who created it, 409 not_declinable", async () => {
    const h = await seed();
    await h.db
      .update(organisations)
      .set({ ownerInheritedAt: null })
      .where(eq(organisations.id, h.acme.id));
    const res = await h.decline("acme", await h.tokenOf(h.alice));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "not_declinable" });
    expect(await h.ownerOf()).toBe(h.alice.id);
  });

  it("answers 404 for a handle no organisation has", async () => {
    const h = await seed();
    expect((await h.decline("nosuchorg", await h.tokenOf(h.alice))).status).toBe(404);
  });

  it("answers 429 when the caller's limiter refuses, before anything is read", async () => {
    const h = await seed(deny);
    expect((await h.decline("acme", await h.tokenOf(h.alice))).status).toBe(429);
    expect(await h.ownerOf()).toBe(h.alice.id);
  });
});
