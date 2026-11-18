import type { Db } from "@osn/db/service";
import type { EmailService } from "@shared/email";
import type { RateLimiterBackend } from "@shared/rate-limit";
import { Effect, type Layer } from "effect";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import * as metrics from "../../src/metrics";
import {
  createAccountErasureRoutes,
  type AccountErasureRateLimiters,
} from "../../src/routes/account-erasure";
import { createAuthService } from "../../src/services/auth";
import { NO_DELETION_APPS, type DeletionAppsConfig } from "../../src/services/deletion-apps";
import { createOrganisationService } from "../../src/services/organisation";
import { createProfileService } from "../../src/services/profile";
import { makeTestAuthConfig } from "../helpers/auth-config";
import { settledHandle } from "../helpers/background";
import { createTestLayerWithSqlite } from "../helpers/db";
import { appStandIns } from "../helpers/deletion-apps";
import { mintStepUpToken } from "../helpers/step-up-session";

/**
 * The emails the erasure routes send, and the "send me a link" route: each
 * goes to the account's own address, once, and only when the thing it reports
 * happened. Each case is red when the route sends the email in the wrong case,
 * to the wrong place, or says something the server will not do. Every request
 * waits for the work it started after its answer (`settledHandle`), so a send
 * that should not happen has happened by the time a case looks.
 */

let config: Awaited<ReturnType<typeof makeTestAuthConfig>>;

beforeAll(async () => {
  config = await makeTestAuthConfig();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const IP_HEADERS = { "x-forwarded-for": "1.2.3.4" };

const allow = { check: async () => true } as RateLimiterBackend;
const deny = { check: async () => false } as RateLimiterBackend;
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
async function seed(
  options: {
    readonly limiters?: Partial<AccountErasureRateLimiters>;
    readonly apps?: DeletionAppsConfig;
  } = {},
) {
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
    limiters(options.limiters),
    { secure: false },
    { trustedProxyCount: 1 },
    undefined,
    options.apps ?? NO_DELETION_APPS,
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
    settledHandle(
      app,
      new Request(`http://localhost${path}`, {
        method,
        headers: body === undefined ? headers : { ...headers, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
  /** The sends of `template` so far: every request has finished its background work. */
  const sent = (template: string) => email.recorded().filter((m) => m.template === template);
  return { layer, auth, profile, app, authed, stepUp, send, mint, sent };
}

/** 2026-12-07 00:00 UTC, as an app's choice says it keeps something until. */
const KEPT_UNTIL = Date.UTC(2026, 11, 7) / 1_000;

/** A cire stand-in that answers its preview with one wedding to answer, and Pulse with one event that has a default. */
function appsWithActions() {
  return appStandIns((call) => {
    if (call.path !== "/internal/account-deletion-preview") return undefined;
    if (call.app === "cire") {
      return {
        body: {
          openActions: [
            {
              id: "cire:wedding:wed_1",
              kind: "wedding_sole_owner",
              label: 'You are the only owner of "Ama & Jonah".',
              choices: [
                {
                  choice: "delete",
                  description: "Deleted with its guests when your account is deleted.",
                  erasedOn: null,
                },
              ],
              defaultChoice: null,
              link: null,
            },
          ],
        },
      };
    }
    if (call.app === "pulse") {
      return {
        body: {
          openActions: [
            {
              id: "pulse:event:evt_1",
              kind: "hosted_event",
              label: "You host Launch, on 1 December.",
              choices: [
                {
                  choice: "cancel",
                  description: "Cancelled and kept for its guests.",
                  erasedOn: KEPT_UNTIL,
                },
                { choice: "delete", description: "Deleted at once.", erasedOn: null },
              ],
              defaultChoice: "cancel",
              link: null,
            },
          ],
        },
      };
    }
    return undefined;
  });
}

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

    const [mail, ...more] = h.sent("account-deletion-scheduled");
    expect(more).toEqual([]);
    expect(mail!.to).toBe("eraser@example.com");
    const when = new Date(scheduled_for * 1_000);
    expect(mail!.text).toContain(`${when.getUTCDate()} `);
    expect(mail!.text).toContain("You own @acme.");
    // Named by handle alone: any admin can rewrite the name.
    expect(mail!.text).not.toContain("Acme");
    // The named successor, by handle: what the hard delete will do.
    expect(mail!.text).toContain("@bob becomes the owner.");

    // A repeat inside the window answers `already_pending` and sends nothing more.
    const again = await h.send("DELETE", "/account", { confirm_handle: h.profile.handle });
    expect(((await again.json()) as { already_pending: boolean }).already_pending).toBe(true);
    expect(h.sent("account-deletion-scheduled")).toHaveLength(1);
  });

  it("an app's answer, or its default, and the date anything it keeps is erased", async () => {
    const apps = appsWithActions();
    try {
      const h = await seed({ apps: apps.config() });
      const res = await h.send("DELETE", "/account", {
        confirm_handle: h.profile.handle,
        step_up_token: await h.stepUp("account_delete"),
        choices: [{ action: "cire:wedding:wed_1", choice: "delete" }],
      });
      expect(res.status).toBe(202);

      const [mail] = h.sent("account-deletion-scheduled");
      // The answer given, in cire's own words.
      expect(mail!.text).toContain(
        'You are the only owner of "Ama & Jonah".\n  Deleted with its guests when your account is deleted.',
      );
      // No answer: the event's default, with the date its kept copy goes.
      expect(mail!.text).toContain(
        "You host Launch, on 1 December.\n  Cancelled and kept for its guests. Kept until 7 December 2026.",
      );
    } finally {
      apps.stop();
    }
  });

  it('with "delete everything", the rule the server applies and no default it will not', async () => {
    const apps = appsWithActions();
    try {
      const h = await seed({ apps: apps.config() });
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

      const [mail] = h.sent("account-deletion-scheduled");
      // Each app's action by the contract's rule, never its default.
      expect(mail!.text).toContain(
        'You are the only owner of "Ama & Jonah".\n  You chose to delete everything, so Cire deletes this as soon as it can.',
      );
      expect(mail!.text).toContain(
        "You host Launch, on 1 December.\n  You chose to delete everything, so Pulse deletes this as soon as it can.",
      );
      expect(mail!.text).not.toContain("Cancelled and kept for its guests.");
      // Each organisation by the succession rule: to its other admin, or gone.
      expect(mail!.text).toContain("It passes to @carol.");
      expect(mail!.text).toContain("It is deleted.");
    } finally {
      apps.stop();
    }
  });

  it("not for a refused request", async () => {
    const h = await seed();
    const res = await h.send("DELETE", "/account", {
      confirm_handle: "someone_else",
      step_up_token: await h.stepUp("account_delete"),
    });
    expect(res.status).toBe(400);
    expect(h.sent("account-deletion-scheduled")).toEqual([]);
  });
});

describe("POST /account/restore sends the cancelled notice", () => {
  it("when it cancels, and not when there was nothing to cancel", async () => {
    const h = await seed();
    const nothing = await h.send("POST", "/account/restore", {
      step_up_token: await h.stepUp("account_restore"),
    });
    expect(await nothing.json()).toEqual({ cancelled: false });
    expect(h.sent("account-deletion-cancelled")).toEqual([]);

    await h.send("DELETE", "/account", {
      confirm_handle: h.profile.handle,
      step_up_token: await h.stepUp("account_delete"),
    });
    const res = await h.send("POST", "/account/restore", {
      step_up_token: await h.stepUp("account_restore"),
    });
    expect(await res.json()).toEqual({ cancelled: true });

    const [mail, ...more] = h.sent("account-deletion-cancelled");
    expect(more).toEqual([]);
    expect(mail!.to).toBe("eraser@example.com");
  });
});

describe("POST /account/data-link", () => {
  it("emails the account's own address a link to the download page, and holds no data", async () => {
    const h = await seed();
    const res = await h.send("POST", "/account/data-link");
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ sent: true });

    const [mail, ...more] = h.sent("account-data-link");
    expect(more).toEqual([]);
    expect(mail!.to).toBe("eraser@example.com");
    expect(mail!.text).toContain("/settings#account");
  });

  it("refuses a caller with no token", async () => {
    const h = await seed();
    const res = await h.send("POST", "/account/data-link", undefined, IP_HEADERS);
    expect(res.status).toBe(401);
    expect(h.sent("account-data-link")).toEqual([]);
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
    expect(h.sent("account-data-link")).toEqual([]);
  });

  it("counts against the account, not the address: a refused check sends nothing", async () => {
    const keys: string[] = [];
    const h = await seed({
      limiters: {
        accountDataLink: {
          check: async (key: string) => {
            keys.push(key);
            return false;
          },
        } as RateLimiterBackend,
      },
    });
    const res = await h.send("POST", "/account/data-link");
    expect(res.status).toBe(429);
    expect(keys).toEqual([h.profile.accountId]);
    expect(h.sent("account-data-link")).toEqual([]);
  });

  it("refuses at its per-IP limit before it reads any token", async () => {
    // Red on a route that verifies the token first: a caller with none would
    // then get 401, and make the server verify tokens without limit.
    const rateLimited = vi.spyOn(metrics, "metricAuthRateLimited");
    const h = await seed({ limiters: { accountDeletionStatus: deny } });
    const res = await h.send("POST", "/account/data-link", undefined, IP_HEADERS);
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "rate_limited" });
    expect(rateLimited).toHaveBeenCalledWith("account_data_link");
  });

  it("refuses a caller whose address cannot be told", async () => {
    // Under `app.handle` there is no socket peer, and with no trusted hop the
    // address is unresolved: such a caller is refused, never pooled.
    const h = await seed();
    const res = await h.send("POST", "/account/data-link", undefined, {
      Authorization: h.authed.Authorization,
    });
    expect(res.status).toBe(429);
    expect(h.sent("account-data-link")).toEqual([]);
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
