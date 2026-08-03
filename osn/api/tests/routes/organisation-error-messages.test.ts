/**
 * Regression tests for the organisation routes' error contract — the org half
 * of the `makeSafeError` fix (see `tests/routes/graph-error-messages.test.ts`
 * for the graph half and the full story). Asserts that tagged `OrgError` /
 * `NotFoundError` messages survive the `ManagedRuntime.runPromise`
 * `FiberFailure` wrapping and reach clients instead of the generic
 * "Request failed".
 */

import type { Db } from "@osn/db/service";
import { Effect } from "effect";
import { describe, it, expect, beforeEach, beforeAll } from "vitest";

import { createOrganisationRoutes } from "../../src/routes/organisation";
import { createAuthService } from "../../src/services/auth";
import { makeTestAuthConfig } from "../helpers/auth-config";
import { createTestLayer } from "../helpers/db";

let config: Awaited<ReturnType<typeof makeTestAuthConfig>>;

beforeAll(async () => {
  config = await makeTestAuthConfig();
});

describe("organisation route error messages", () => {
  let layer: ReturnType<typeof createTestLayer>;
  let orgApp: ReturnType<typeof createOrganisationRoutes>;
  let auth: ReturnType<typeof createAuthService>;

  beforeEach(() => {
    layer = createTestLayer();
    orgApp = createOrganisationRoutes(config, layer);
    auth = createAuthService(config);
  });

  const runWithLayer = <A>(eff: Effect.Effect<A, unknown, Db>): Promise<A> =>
    Effect.runPromise(eff.pipe(Effect.provide(layer)) as Effect.Effect<A, never, never>);

  async function registerAndGetToken(email: string, handle: string) {
    const user = await runWithLayer(auth.registerProfile(email, handle));
    const tokens = await runWithLayer(
      auth.issueTokens(user.id, user.accountId, user.email, user.handle, user.displayName),
    );
    return { profileId: user.id, token: tokens.accessToken };
  }

  const jsonHeaders = (token: string) => ({
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  });

  async function createOrg(token: string, handle: string) {
    const res = await orgApp.handle(
      new Request("http://localhost/organisations", {
        method: "POST",
        headers: jsonHeaders(token),
        body: JSON.stringify({ handle, name: "Acme Corp" }),
      }),
    );
    expect(res.status).toBe(201);
  }

  it("duplicate org handle → 400 'Handle unavailable'", async () => {
    const alice = await registerAndGetToken("alice@example.com", "alice");
    await createOrg(alice.token, "acme");

    const res = await orgApp.handle(
      new Request("http://localhost/organisations", {
        method: "POST",
        headers: jsonHeaders(alice.token),
        body: JSON.stringify({ handle: "acme", name: "Acme Again" }),
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("Handle unavailable");
  });

  it("non-admin update → 400 'Only admins can update the organisation'", async () => {
    const alice = await registerAndGetToken("alice@example.com", "alice");
    const bob = await registerAndGetToken("bob@example.com", "bob");
    await createOrg(alice.token, "acme");

    const res = await orgApp.handle(
      new Request("http://localhost/organisations/acme", {
        method: "PATCH",
        headers: jsonHeaders(bob.token),
        body: JSON.stringify({ name: "Hijacked" }),
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("Only admins can update the organisation");
  });

  it("adding an existing member → 400 'Profile is already a member'", async () => {
    const alice = await registerAndGetToken("alice@example.com", "alice");
    await createOrg(alice.token, "acme");

    // The owner is already a member; adding them again trips the OrgError.
    const res = await orgApp.handle(
      new Request("http://localhost/organisations/acme/members/alice", {
        method: "POST",
        headers: jsonHeaders(alice.token),
        body: JSON.stringify({ role: "member" }),
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("Profile is already a member");
  });

  it("removing a non-member → 400 'Member not found' (NotFoundError tag)", async () => {
    const alice = await registerAndGetToken("alice@example.com", "alice");
    await registerAndGetToken("bob@example.com", "bob");
    await createOrg(alice.token, "acme");

    const res = await orgApp.handle(
      new Request("http://localhost/organisations/acme/members/bob", {
        method: "DELETE",
        headers: { Authorization: `Bearer ${alice.token}` },
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("Member not found");
  });
});
