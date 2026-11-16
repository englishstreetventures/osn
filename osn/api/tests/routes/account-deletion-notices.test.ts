import type { Db } from "@osn/db/service";
import type { EmailService, RecordedEmail } from "@shared/email";
import type { RateLimiterBackend } from "@shared/rate-limit";
import { Effect, type Layer } from "effect";
import { beforeAll, describe, expect, it, vi } from "vitest";

import {
  createAccountErasureRoutes,
  type AccountErasureRateLimiters,
} from "../../src/routes/account-erasure";
import { createAuthService } from "../../src/services/auth";
import { createOrganisationService } from "../../src/services/organisation";
import { createProfileService } from "../../src/services/profile";
import { makeTestAuthConfig } from "../helpers/auth-config";
import { createTestLayerWithSqlite } from "../helpers/db";
import { mintStepUpToken } from "../helpers/step-up-session";

/**
 * The emails the erasure routes send, and the "send me a link" route: each
 * goes to the account's own address, once, and only when the thing it reports
 * happened. Each case is red when the route sends the email in the wrong case,
 * to the wrong place, or says something the server will not do.
 */

let config: Awaited<ReturnType<typeof makeTestAuthConfig>>;

beforeAll(async () => {
  config = await makeTestAuthConfig();
});

const IP_HEADERS = { "x-forwarded-for": "1.2.3.4" };

const allow = { check: async () => true } as RateLimiterBackend;
const limiters = (
  overrides: Partial<AccountErasureRateLimiters> = {},
): AccountErasureRateLimiters => ({
  accountDelete: allow,
  accountRestore: allow,
  accountDeletionStatus: allow,
  accountDataLink: allow,
  ...overrides,
});

const runOn = <A, E, R>(layer: Layer.Layer<Db | EmailService>, effect: Effect.Effect<A, E, R>) =>
  Effect.runPromise(effect.pipe(Effect.provide(layer)) as Effect.Effect<A, E, never>);

/** "eraser", signed in, with the routes on a fresh database and a recording mail transport. */
async function seed(overrides: Partial<AccountErasureRateLimiters> = {}) {
  const { layer, email } = createTestLayerWithSqlite();
  const auth = createAuthService(config);
  const profile = await runOn(
    layer,
    auth.registerProfile("eraser@example.com", "eraser", "Erase Me"),
  );
  const mint = () =>
    runOn(
      layer,
      auth.issueTokens(
        profile.id,
        profile.accountId,
        profile.email,
        profile.handle,
        profile.displayName,
      ),
    );
  const tokens = await mint();
  const app = createAccountErasureRoutes(
    config,
    layer,
    undefined,
    limiters(overrides),
    { secure: false },
    { trustedProxyCount: 1 },
  );
  const authed = { ...IP_HEADERS, Authorization: `Bearer ${tokens.accessToken}` };
  const stepUp = (purpose: "account_delete" | "account_restore") =>
    runOn(layer, mintStepUpToken(auth, profile.accountId, "otp", purpose));
  const send = (
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = authed,
  ) =>
    app.handle(
      new Request(`http://localhost${path}`, {
        method,
        headers: body === undefined ? headers : { ...headers, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
  return { layer, email, auth, profile, app, authed, stepUp, send, mint };
}

/** The sends of `template`, once the forked send has had its turn. */
const sent = async (
  email: { recorded: () => readonly RecordedEmail[] },
  template: string,
  count: number,
) => {
  await vi.waitFor(() =>
    expect(email.recorded().filter((m) => m.template === template)).toHaveLength(count),
  );
  return email.recorded().filter((m) => m.template === template);
};

describe("DELETE /account sends the scheduled notice", () => {
  it("once, to the account's address, with the date and each answer's outcome", async () => {
    const h = await seed();
    const orgs = createOrganisationService({ heldHandleDigest: h.auth.heldHandleDigest });
    const bob = await runOn(h.layer, h.auth.registerProfile("bob@example.com", "bob"));
    const acme = await runOn(h.layer, orgs.createOrganisation(h.profile.id, "acme", "Acme"));
    await runOn(h.layer, orgs.addMember(acme.id, h.profile.id, bob.id, "member"));

    const res = await h.send("DELETE", "/account", {
      confirm_handle: h.profile.handle,
      step_up_token: await h.stepUp("account_delete"),
      choices: [
        {
          action: `osn:organisation:${acme.id}`,
          choice: "successor",
          successor_profile_id: bob.id,
        },
      ],
    });
    expect(res.status).toBe(202);
    const { scheduled_for } = (await res.json()) as { scheduled_for: number };

    const [mail] = await sent(h.email, "account-deletion-scheduled", 1);
    expect(mail!.to).toBe("eraser@example.com");
    const when = new Date(scheduled_for * 1_000);
    expect(mail!.text).toContain(`${when.getUTCDate()} `);
    expect(mail!.text).toContain("You own Acme (@acme).");
    // The named successor, by handle: what the hard delete will do.
    expect(mail!.text).toContain("@bob becomes the owner.");

    // A repeat inside the window answers `already_pending` and sends nothing more.
    const again = await h.send("DELETE", "/account", { confirm_handle: h.profile.handle });
    expect(((await again.json()) as { already_pending: boolean }).already_pending).toBe(true);
    await sent(h.email, "account-deletion-scheduled", 1);
  });

  it('with "delete everything", the rule the server applies and no default it will not', async () => {
    const h = await seed();
    const orgs = createOrganisationService({ heldHandleDigest: h.auth.heldHandleDigest });
    const carol = await runOn(h.layer, h.auth.registerProfile("carol@example.com", "carol"));
    const acme = await runOn(h.layer, orgs.createOrganisation(h.profile.id, "acme", "Acme"));
    await runOn(h.layer, orgs.addMember(acme.id, h.profile.id, carol.id, "admin"));
    await runOn(h.layer, orgs.createOrganisation(h.profile.id, "alone", "Alone"));

    const res = await h.send("DELETE", "/account", {
      confirm_handle: h.profile.handle,
      step_up_token: await h.stepUp("account_delete"),
      delete_everything: true,
    });
    expect(res.status).toBe(202);

    const [mail] = await sent(h.email, "account-deletion-scheduled", 1);
    expect(mail!.text).toContain("You chose to delete everything");
    // Each organisation by the succession rule: to its other admin, or gone.
    expect(mail!.text).toContain("It passes to @carol.");
    expect(mail!.text).toContain("It is deleted.");
  });

  it("not for a refused request", async () => {
    const h = await seed();
    const res = await h.send("DELETE", "/account", {
      confirm_handle: "someone_else",
      step_up_token: await h.stepUp("account_delete"),
    });
    expect(res.status).toBe(400);
    // Give a wrongly forked send its turn before reading the recorder.
    await new Promise((resolve) => queueMicrotask(() => resolve(undefined)));
    expect(h.email.recorded().filter((m) => m.template === "account-deletion-scheduled")).toEqual(
      [],
    );
  });
});

describe("POST /account/restore sends the cancelled notice", () => {
  it("when it cancels, and not when there was nothing to cancel", async () => {
    const h = await seed();
    const nothing = await h.send("POST", "/account/restore", {
      step_up_token: await h.stepUp("account_restore"),
    });
    expect(await nothing.json()).toEqual({ cancelled: false });

    await h.send("DELETE", "/account", {
      confirm_handle: h.profile.handle,
      step_up_token: await h.stepUp("account_delete"),
    });
    const res = await h.send("POST", "/account/restore", {
      step_up_token: await h.stepUp("account_restore"),
    });
    expect(await res.json()).toEqual({ cancelled: true });

    const [mail] = await sent(h.email, "account-deletion-cancelled", 1);
    expect(mail!.to).toBe("eraser@example.com");
  });
});

describe("POST /account/data-link", () => {
  it("emails the account's own address a link to the download page, and holds no data", async () => {
    const h = await seed();
    const res = await h.send("POST", "/account/data-link");
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ sent: true });

    const [mail] = await sent(h.email, "account-data-link", 1);
    expect(mail!.to).toBe("eraser@example.com");
    expect(mail!.text).toContain("/settings#account");
  });

  it("refuses a caller with no token", async () => {
    const h = await seed();
    const res = await h.send("POST", "/account/data-link", undefined, IP_HEADERS);
    expect(res.status).toBe(401);
  });

  it("refuses the token of an account whose deletion is pending", async () => {
    const h = await seed();
    await h.send("DELETE", "/account", {
      confirm_handle: h.profile.handle,
      step_up_token: await h.stepUp("account_delete"),
    });
    // A token minted now is on the pending-deletion audience.
    const pending = await h.mint();
    const res = await h.send("POST", "/account/data-link", undefined, {
      ...IP_HEADERS,
      Authorization: `Bearer ${pending.accessToken}`,
    });
    expect(res.status).toBe(401);
    expect(h.email.recorded().filter((m) => m.template === "account-data-link")).toEqual([]);
  });

  it("counts against the account, not the address: a refused check sends nothing", async () => {
    const keys: string[] = [];
    const h = await seed({
      accountDataLink: {
        check: async (key: string) => {
          keys.push(key);
          return false;
        },
      } as RateLimiterBackend,
    });
    const res = await h.send("POST", "/account/data-link");
    expect(res.status).toBe(429);
    expect(keys).toEqual([h.profile.accountId]);
    expect(h.email.recorded().filter((m) => m.template === "account-data-link")).toEqual([]);
  });
});

describe("GET /account/deletion-preview offers successors", () => {
  it("never the account's own other profiles", async () => {
    const h = await seed();
    const orgs = createOrganisationService({ heldHandleDigest: h.auth.heldHandleDigest });
    const own = await runOn(
      h.layer,
      createProfileService(h.auth).createProfile(h.profile.accountId, "erasertwo"),
    );
    const bob = await runOn(h.layer, h.auth.registerProfile("bob@example.com", "bob"));
    const acme = await runOn(h.layer, orgs.createOrganisation(h.profile.id, "acme", "Acme"));
    await runOn(h.layer, orgs.addMember(acme.id, h.profile.id, own.id, "admin"));
    await runOn(h.layer, orgs.addMember(acme.id, h.profile.id, bob.id, "member"));

    const res = await h.send("GET", "/account/deletion-preview");
    const { open_actions } = (await res.json()) as {
      open_actions: Array<{ candidates?: Array<{ handle: string }> }>;
    };
    expect(open_actions[0]!.candidates!.map((c) => c.handle)).toEqual(["bob"]);
  });
});
