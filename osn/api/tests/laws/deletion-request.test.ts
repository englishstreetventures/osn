import { deletionJobs } from "@osn/db/schema";
import { Db } from "@osn/db/service";
import type { EmailService } from "@shared/email";
import type { RateLimiterBackend } from "@shared/rate-limit";
import { eq } from "drizzle-orm";
import { Effect, type Layer } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createAccountErasureRoutes,
  type AccountErasureRateLimiters,
} from "../../src/routes/account-erasure";
import { createAuthService } from "../../src/services/auth";
import { DISABLED_CIRE_ORGANISER_REVOKE } from "../../src/services/cire-organiser-revoke";
import { createOrganisationService } from "../../src/services/organisation";
import { createProfileService } from "../../src/services/profile";
import { makeTestAuthConfig } from "../helpers/auth-config";
import { createTestLayer } from "../helpers/db";
import { appStandIns, type AppCall, type AppAnswer } from "../helpers/deletion-apps";
import { mintStepUpToken } from "../helpers/step-up-session";
import {
  type AppAct,
  type Heir,
  type OrgAct,
  type OrgChoice,
  type Pick,
  type Req,
  type Verdict,
  array,
  list,
  model,
  seeded,
} from "./model";

/**
 * The route's verdict on a deletion request (tools/deletion-laws/choices.bend)
 * against `DELETE /account` itself. Each case seeds the person's owned
 * organisations, with or without a member or an admin from another account,
 * has Pulse's stand-in answer the preview with its actions (and Zap fail it
 * when the case says an app could not be checked), sends the answers, and
 * compares the route's answer with the model's verdict. A request the model
 * accepts must leave a deletion job, and one it refuses must leave none: the
 * account model schedules only on `Ok` (law `scheduled_only_when_answered`).
 *
 * Not compared: the handle confirmation, the live session and the step-up,
 * which every case passes.
 */

// The app choices a case draws from; `keep` is offered by no action.
const CHOICES = ["delete", "cancel", "keep"] as const;
const ORG_CHOICE: Record<OrgChoice["$"], string> = {
  Transfer: "transfer",
  Successor: "successor",
  Delete: "delete",
};

let config: Awaited<ReturnType<typeof makeTestAuthConfig>>;
beforeAll(async () => {
  config = await makeTestAuthConfig();
});

let answer: (call: AppCall) => AppAnswer | undefined = () => undefined;
const apps = appStandIns((call) => answer(call));
afterAll(() => apps.stop());

const allowAll = (): AccountErasureRateLimiters => {
  const backend = { check: async () => true } as RateLimiterBackend;
  return {
    accountDelete: backend,
    accountRestore: backend,
    accountDeletionStatus: backend,
    accountDataLink: backend,
  };
};

const runOn = <A, E>(
  layer: Layer.Layer<Db | EmailService>,
  effect: Effect.Effect<A, E, Db | EmailService>,
) => Effect.runPromise(effect.pipe(Effect.provide(layer)));

/** The route's answer, as a verdict. */
const verdictOf = (status: number, error: string | undefined): Verdict["$"] | string => {
  if (status === 202) return "Ok";
  const named: Record<string, Verdict["$"]> = {
    choices_with_delete_everything: "Both",
    could_not_check: "Unchecked",
    invalid_choice: "Invalid",
    stale_choices: "Stale",
    open_actions: "Open",
  };
  return named[error ?? ""] ?? `${status} ${error}`;
};

/** Sends `req` to `DELETE /account` as the code sees it, and answers its verdict and whether a job stands. */
async function throughRoute(req: Req): Promise<{ verdict: string; scheduled: boolean }> {
  const layer = createTestLayer();
  const auth = createAuthService(config);
  const profile = await runOn(
    layer,
    auth.registerProfile("eraser@example.com", "eraser", "Erase Me"),
  );
  const tokens = await runOn(
    layer,
    auth.issueTokens(
      profile.id,
      profile.accountId,
      profile.email,
      profile.handle,
      profile.displayName,
    ),
  );
  const orgs = createOrganisationService({ heldHandleDigest: auth.heldHandleDigest });
  const bob = await runOn(layer, auth.registerProfile("bob@example.com", "bob"));
  const carol = await runOn(layer, auth.registerProfile("carol@example.com", "carol"));
  // The account's own second profile, a member of every organisation: never a
  // successor, since it goes with the account.
  const own = await runOn(
    layer,
    createProfileService(auth).createProfile(profile.accountId, "erasertwo"),
  );

  const orgIds = new Map<number, string>();
  for (const org of array(req.orgs)) {
    const created = await runOn(
      layer,
      orgs.createOrganisation(profile.id, `org${org.id}`, `Org ${org.id}`),
    );
    orgIds.set(org.id, created.id);
    if (org.heir.$ !== "Nobody") {
      const role = org.heir.$ === "Admin" ? "admin" : "member";
      await runOn(layer, orgs.addMember(created.id, profile.id, bob.id, role));
    }
    await runOn(layer, orgs.addMember(created.id, profile.id, own.id, "admin"));
  }

  const actions = array(req.apps).map((act: AppAct) => ({
    id: `pulse:event:${act.id}`,
    kind: "events_hosted",
    label: `Event ${act.id}`,
    choices: array(act.offers).map((c) => ({
      choice: CHOICES[c]!,
      description: `${CHOICES[c]} it`,
      erasedOn: null,
    })),
    defaultChoice: act.fallback.$ === "Some" ? CHOICES[act.fallback.value]! : null,
    link: null,
  }));
  answer = (call) => {
    if (call.path !== "/internal/account-deletion-preview") return undefined;
    if (call.app === "pulse") return { body: { openActions: actions } };
    if (call.app === "zap" && req.unchecked) return { status: 503, body: { error: "down" } };
    return undefined;
  };

  // A successor who is not a member from another account: someone outside
  // the organisation, or, every other time, the account's own profile.
  const choices = array(req.picks).map((p: Pick, i) => {
    switch (p.$) {
      case "OrgPick":
        return {
          action: `osn:organisation:${orgIds.get(p.id) ?? "org_not_owned"}`,
          choice: ORG_CHOICE[p.choice.$],
          successor_profile_id:
            p.choice.$ === "Successor"
              ? p.member
                ? bob.id
                : i % 2 === 0
                  ? own.id
                  : carol.id
              : undefined,
        };
      case "AppPick":
        return { action: `pulse:event:${p.id}`, choice: CHOICES[p.choice]! };
      case "OtherPick":
        return { action: "nope:thing", choice: "delete" };
    }
  });

  const app = createAccountErasureRoutes(
    config,
    layer,
    undefined,
    allowAll(),
    { secure: false },
    { trustedProxyCount: 1 },
    undefined,
    apps.config(),
    DISABLED_CIRE_ORGANISER_REVOKE,
  );
  const stepUp = await runOn(
    layer,
    mintStepUpToken(auth, profile.accountId, "otp", "account_delete"),
  );
  const res = await app.handle(
    new Request("http://localhost/account", {
      method: "DELETE",
      headers: {
        "x-forwarded-for": "1.2.3.4",
        Authorization: `Bearer ${tokens.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        confirm_handle: profile.handle,
        step_up_token: stepUp,
        ...(choices.length > 0 ? { choices } : {}),
        ...(req.everything ? { delete_everything: true } : {}),
      }),
    }),
  );
  const body = (await res.json()) as { error?: string };
  const jobs = await runOn(
    layer,
    Effect.gen(function* () {
      const { db } = yield* Db;
      return yield* Effect.promise(() =>
        db.select().from(deletionJobs).where(eq(deletionJobs.accountId, profile.accountId)),
      );
    }),
  );
  return { verdict: verdictOf(res.status, body.error), scheduled: jobs.length > 0 };
}

async function expectModelAgrees(req: Req): Promise<void> {
  const expected = model["choices:verdict"](req).$;
  const got = await throughRoute(req);
  const at = JSON.stringify(req);
  expect({ at, ...got }).toEqual({ at, verdict: expected, scheduled: expected === "Ok" });
}

const org = (id: number, heir: Heir["$"]): OrgAct => ({
  $: "OrgAct",
  id,
  heir: { $: heir } as Heir,
});
const act = (id: number, offers: number[], fallback: number | null): AppAct => ({
  $: "AppAct",
  id,
  offers: list(offers),
  fallback: fallback === null ? { $: "None" } : { $: "Some", value: fallback },
});
const orgPick = (id: number, choice: OrgChoice["$"], member = true): Pick => ({
  $: "OrgPick",
  id,
  choice: { $: choice } as OrgChoice,
  member,
});
const appPick = (id: number, choice: number): Pick => ({ $: "AppPick", id, choice });
const req = (
  orgs: OrgAct[],
  appActs: AppAct[],
  picks: Pick[],
  { everything = false, unchecked = false } = {},
): Req => ({
  $: "Req",
  orgs: list(orgs),
  apps: list(appActs),
  picks: list(picks),
  everything,
  unchecked,
});

describe("the route's verdict and the model's agree", () => {
  it("accepts a request with nothing open, and one where every open action has an answer", async () => {
    await expectModelAgrees(req([], [], []));
    await expectModelAgrees(
      req(
        [org(0, "Member"), org(1, "Nobody")],
        [act(0, [0, 1], null)],
        [orgPick(0, "Successor"), orgPick(1, "Delete"), appPick(0, 1)],
      ),
    );
  });

  it("leaves open an organisation with no admin to take it, and an app action with no default", async () => {
    await expectModelAgrees(req([org(0, "Member")], [], []));
    await expectModelAgrees(req([org(0, "Admin")], [act(0, [0], null)], []));
    await expectModelAgrees(req([org(0, "Admin")], [act(0, [0, 1], 1), act(1, [], null)], []));
  });

  it("refuses a choice not offered, a successor who is not a member or is the account's own profile, and an answer given twice", async () => {
    await expectModelAgrees(req([org(0, "Nobody")], [], [orgPick(0, "Transfer")]));
    await expectModelAgrees(req([org(0, "Member")], [], [orgPick(0, "Successor", false)]));
    await expectModelAgrees(
      req([org(0, "Admin")], [], [{ $: "OtherPick" }, orgPick(0, "Successor", false)]),
    );
    await expectModelAgrees(req([], [act(0, [0], null)], [appPick(0, 2)]));
    await expectModelAgrees(req([], [act(0, [0, 1], null)], [appPick(0, 0), appPick(0, 1)]));
  });

  it("refuses an answer to an action the fresh preview does not list, but an invalid one first", async () => {
    await expectModelAgrees(req([], [act(0, [0], null)], [appPick(0, 0), appPick(1, 0)]));
    await expectModelAgrees(req([org(0, "Nobody")], [], [appPick(3, 0), orgPick(0, "Transfer")]));
  });

  it("ignores answers to organisations not owned and to no app, and takes delete everything alone", async () => {
    await expectModelAgrees(req([], [], [orgPick(5, "Delete"), { $: "OtherPick" }]));
    await expectModelAgrees(req([org(0, "Nobody")], [act(0, [0], null)], [], { everything: true }));
    await expectModelAgrees(
      req([org(0, "Nobody")], [], [orgPick(0, "Delete")], { everything: true }),
    );
  });

  it("refuses while an app cannot be checked, even with delete everything", async () => {
    await expectModelAgrees(req([], [], [], { unchecked: true }));
    await expectModelAgrees(req([], [], [], { unchecked: true, everything: true }));
  });

  const draw = (seed: number): Req => {
    const rand = seeded(seed);
    const orgs = Array.from({ length: rand.int(3) }, (_, i) =>
      org(i, rand.pick(["Nobody", "Member", "Admin"] as const)),
    );
    const appActs = Array.from({ length: rand.int(3) }, (_, i) => {
      const offers = [0, 1].filter(() => rand.chance(0.6));
      const fallback = offers.length > 0 && rand.chance(0.4) ? rand.pick(offers) : null;
      return act(i, offers, fallback);
    });
    const picks = Array.from({ length: rand.int(4) }, (): Pick => {
      const kind = rand.int(5);
      if (kind < 2) {
        return orgPick(
          rand.int(orgs.length + 1),
          rand.pick(["Transfer", "Successor", "Delete"] as const),
          rand.chance(0.7),
        );
      }
      if (kind < 4) return appPick(rand.int(appActs.length + 1), rand.int(3));
      return { $: "OtherPick" };
    });
    return req(orgs, appActs, picks, {
      everything: rand.chance(0.15),
      unchecked: rand.chance(0.1),
    });
  };

  for (let seed = 1; seed <= 60; seed++) {
    it(`agrees on seeded request ${seed}`, async () => {
      await expectModelAgrees(draw(seed));
    });
  }
});
