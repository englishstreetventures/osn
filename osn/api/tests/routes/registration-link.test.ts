/**
 * Sign-up's emailed link, over the routes: what a link can and cannot do, and
 * that a taken address answers exactly as a free one.
 *
 * Each case is a refusal the link flow must make: a `GET` never approves, a
 * wrong secret is counted and wiped, the confirming device gets no session,
 * only the tab holding the claim secret does, and every limit holds. The happy
 * path end to end is the E2E flow `musubi-passkey`.
 */

import { makeLogEmailLive } from "@shared/email";
import type { TurnstileVerifier } from "@shared/turnstile";
import { Effect, Layer } from "effect";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { createDurableCoordination } from "../../src/lib/coordination/durable";
import { createAuthService } from "../../src/services/auth";
import {
  EMAIL_LINK_PAIRING_CANDIDATES,
  MAX_OTP_ATTEMPTS,
  REGISTRATION_LINK_LOCKOUT_THRESHOLD,
  REGISTRATION_FIRST_LINKS_MAX,
} from "../../src/services/auth/constants";
import { makeTestAuthConfig } from "../helpers/auth-config";
import { createFakeNamespace } from "../helpers/coordination-namespace";
import { createTestLayer } from "../helpers/db";
import {
  beginThroughRoutes,
  candidatesThroughRoutes,
  confirmThroughRoutes,
  latestLinkTo,
  linksTo,
  registerThroughRoutes,
  resendThroughRoutes,
  statusThroughRoutes,
} from "../helpers/registration";
import { createAuthRoutes } from "../helpers/routes";

let config: Awaited<ReturnType<typeof makeTestAuthConfig>>;

beforeAll(async () => {
  config = await makeTestAuthConfig();
});

afterEach(() => {
  vi.useRealTimers();
});

function harness() {
  const mail = makeLogEmailLive();
  const db = createTestLayer();
  const app = createAuthRoutes(config, Layer.merge(db, mail.layer));
  return { app, db, recorded: () => mail.recorded() };
}

/** A begun sign-up for a free address, and the link mailed for it. */
async function begun(h: ReturnType<typeof harness>, email: string, handle: string) {
  const { body } = await beginThroughRoutes(h.app, { email, handle });
  const link = latestLinkTo(h.recorded(), email);
  if (!link) throw new Error("no link mailed");
  return { ...body, link };
}

const WRONG_SECRET = "0".repeat(64);
const MINUTE = 60_000;

/**
 * A poll's body with its number reduced to its shape: two requests draw their
 * numbers apart, so a decoy and a real request are compared on keys and form.
 */
function pollShape(body: unknown): unknown {
  const { pairingCode, ...rest } = body as { pairingCode?: unknown };
  if (pairingCode === undefined) return rest;
  return {
    ...rest,
    pairingCode:
      typeof pairingCode === "string" && /^[1-9][0-9]$/.test(pairingCode)
        ? "two digits"
        : pairingCode,
  };
}

describe("a GET never approves", () => {
  it("answers 404 to a GET on the confirm route and on the link path, and the request stays pending", async () => {
    const h = harness();
    const s = await begun(h, "get-only@example.com", "getonly");

    const onConfirm = await h.app.handle(
      new Request(`http://localhost/email-link/${s.requestId}/confirm`),
    );
    const onLink = await h.app.handle(new Request(`http://localhost/verify/${s.requestId}`));
    expect(onConfirm.status).toBe(404);
    expect(onLink.status).toBe(404);

    const poll = await statusThroughRoutes(h.app, s.requestId, s.claimSecret);
    expect(poll.status).toBe(200);
    expect(await poll.json()).toEqual({ status: "pending", pairingCode: s.pairingCode });
  });
});

describe("wrong secrets", () => {
  it(`refuse everything past the ${MAX_OTP_ATTEMPTS}th, even the right one, and the tab still reads pending`, async () => {
    const h = harness();
    const email = "wipe@example.com";
    const s = await begun(h, email, "wipe");

    for (let n = 0; n < MAX_OTP_ATTEMPTS; n++) {
      const res = await confirmThroughRoutes(h.app, s.requestId, WRONG_SECRET, s.pairingCode);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: "expired" });
    }
    const sixth = await confirmThroughRoutes(h.app, s.requestId, s.link.linkSecret, s.pairingCode);
    expect(await sixth.json()).toEqual({ status: "expired" });

    // Nothing ends the request: it reads as one nobody acted on, and keeps
    // its address until it expires or the tab starts again.
    const poll = await statusThroughRoutes(h.app, s.requestId, s.claimSecret);
    expect(await poll.json()).toEqual({ status: "pending", pairingCode: s.pairingCode });
    await beginThroughRoutes(h.app, { email, handle: "wipe" }, { "x-forwarded-for": "10.0.6.1" });
    expect(linksTo(h.recorded(), email)).toHaveLength(1);

    const again = await beginThroughRoutes(
      h.app,
      { email, handle: "wipe", previous: { requestId: s.requestId, retireSecret: s.retireSecret } },
      { "x-forwarded-for": "10.0.6.2" },
    );
    const link = latestLinkTo(h.recorded(), email)!;
    expect(link.requestId).toBe(again.body.requestId);
    await confirmThroughRoutes(h.app, link.requestId, link.linkSecret, again.body.pairingCode);
    expect(
      (await statusThroughRoutes(h.app, again.body.requestId, again.body.claimSecret)).status,
    ).toBe(201);
  });

  it("leave the reader's decline open, which frees the address", async () => {
    const h = harness();
    const email = "spent-decline@example.com";
    const s = await begun(h, email, "spentdecline");
    for (let n = 0; n < MAX_OTP_ATTEMPTS + 1; n++) {
      await confirmThroughRoutes(h.app, s.requestId, WRONG_SECRET, "none");
    }
    // A wrong secret's decline is refused like any guess past the count; the
    // link's own decline goes through.
    const declined = await confirmThroughRoutes(h.app, s.requestId, s.link.linkSecret, "none");
    expect(await declined.json()).toEqual({ status: "declined" });
    const again = await begun(h, email, "spentdecline");
    expect(again.requestId).not.toBe(s.requestId);
  });

  it("answer alike on a taken address's request and on one whose reader declined", async () => {
    const h = harness();
    await registerThroughRoutes(h.app, h.recorded, "wipe-taken@example.com", "wipetaken");
    const declined = await begun(h, "wipe-declined@example.com", "wipedeclined");
    await confirmThroughRoutes(h.app, declined.requestId, declined.link.linkSecret, "none");
    const taken = await beginThroughRoutes(h.app, {
      email: "wipe-taken@example.com",
      handle: "wipetakentwo",
    });

    for (let n = 0; n < MAX_OTP_ATTEMPTS + 2; n++) {
      const from = { "x-forwarded-for": `10.0.7.${n}` };
      const a = await confirmThroughRoutes(h.app, declined.requestId, WRONG_SECRET, "10", from);
      const b = await confirmThroughRoutes(h.app, taken.body.requestId, WRONG_SECRET, "10", from);
      expect({ status: b.status, body: await b.json() }).toEqual({
        status: a.status,
        body: await a.json(),
      });
    }
    const a = await statusThroughRoutes(h.app, declined.requestId, declined.claimSecret);
    const b = await statusThroughRoutes(h.app, taken.body.requestId, taken.body.claimSecret);
    expect(pollShape(await b.json())).toEqual(pollShape(await a.json()));
    expect(b.status).toBe(a.status);
  });
});

describe("a taken address", () => {
  it("answers begin, poll and resend exactly as a free one, and is mailed nothing", async () => {
    const h = harness();
    await registerThroughRoutes(h.app, h.recorded, "taken@example.com", "takenone");
    const mailedBefore = h.recorded().length;

    const free = await beginThroughRoutes(h.app, { email: "free@example.com", handle: "freeone" });
    const taken = await beginThroughRoutes(h.app, {
      email: "taken@example.com",
      handle: "takentwo",
    });

    expect(taken.res.status).toBe(free.res.status);
    expect(Object.keys(taken.body).toSorted()).toEqual(Object.keys(free.body).toSorted());
    for (const body of [free.body, taken.body]) {
      expect(body.requestId).toMatch(/^signup_[a-f0-9]{12}$/);
      expect(body.claimSecret).toMatch(/^[a-f0-9]{64}$/);
      expect(body.pairingCode).toMatch(/^[1-9][0-9]$/);
      expect(typeof body.expiresAt).toBe("number");
    }
    expect(Math.abs(taken.body.expiresAt - free.body.expiresAt)).toBeLessThanOrEqual(1);

    const freePoll = await statusThroughRoutes(h.app, free.body.requestId, free.body.claimSecret);
    const takenPoll = await statusThroughRoutes(
      h.app,
      taken.body.requestId,
      taken.body.claimSecret,
    );
    expect(takenPoll.status).toBe(freePoll.status);
    expect(pollShape(await takenPoll.json())).toEqual(pollShape(await freePoll.json()));

    const freeResend = await resendThroughRoutes(h.app, free.body.requestId, free.body.claimSecret);
    const takenResend = await resendThroughRoutes(
      h.app,
      taken.body.requestId,
      taken.body.claimSecret,
    );
    expect(takenResend.status).toBe(freeResend.status);
    expect(await takenResend.json()).toEqual(await freeResend.json());

    const mailedSince = h.recorded().slice(mailedBefore);
    expect(mailedSince.filter((m) => m.to === "taken@example.com")).toEqual([]);
    expect(linksTo(mailedSince, "free@example.com")).toHaveLength(2);
  });

  it("gives the same poll answers as a free one over the request's whole life", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const h = harness();
    await registerThroughRoutes(h.app, h.recorded, "taken-life@example.com", "takenlife");
    const free = await beginThroughRoutes(h.app, { email: "free-life@example.com", handle: "fl" });
    const taken = await beginThroughRoutes(h.app, {
      email: "taken-life@example.com",
      handle: "tl",
    });

    const answers = async () => {
      const a = await statusThroughRoutes(h.app, free.body.requestId, free.body.claimSecret);
      const b = await statusThroughRoutes(h.app, taken.body.requestId, taken.body.claimSecret);
      return {
        free: { status: a.status, body: pollShape(await a.json()) },
        taken: { status: b.status, body: pollShape(await b.json()) },
      };
    };

    const atStart = await answers();
    vi.setSystemTime(Date.now() + 5 * MINUTE);
    const midway = await answers();
    vi.setSystemTime(Date.now() + 6 * MINUTE);
    const after = await answers();

    expect(atStart.taken).toEqual(atStart.free);
    expect(midway.taken).toEqual(midway.free);
    expect(after.taken).toEqual(after.free);
    expect(atStart.free.body).toEqual({ status: "pending", pairingCode: "two digits" });
    expect(midway.free.body).toEqual({ status: "pending", pairingCode: "two digits" });
    expect(after.free.body).toEqual({ status: "expired" });
  });
});

describe("the device that confirms", () => {
  it("is told confirmed every time it sends the right secret, and is never given a session", async () => {
    const h = harness();
    const s = await begun(h, "twice@example.com", "twice");

    for (let n = 0; n < 2; n++) {
      const res = await confirmThroughRoutes(h.app, s.requestId, s.link.linkSecret, s.pairingCode);
      expect(res.status).toBe(200);
      expect(res.headers.getSetCookie()).toEqual([]);
      expect(await res.json()).toEqual({ status: "confirmed" });
    }

    expect((await statusThroughRoutes(h.app, s.requestId, s.claimSecret)).status).toBe(201);
  });
});

describe("the tab that began", () => {
  it("alone can claim: a wrong claim secret answers as unknown and spends nothing", async () => {
    const h = harness();
    const s = await begun(h, "claim@example.com", "claimer");
    await confirmThroughRoutes(h.app, s.requestId, s.link.linkSecret, s.pairingCode);

    const stranger = await statusThroughRoutes(h.app, s.requestId, WRONG_SECRET);
    expect(stranger.status).toBe(200);
    expect(stranger.headers.getSetCookie()).toEqual([]);
    expect(await stranger.json()).toEqual({ status: "expired" });
    const handleFree = await h.app.handle(new Request("http://localhost/handle/claimer"));
    expect(await handleFree.json()).toEqual({ available: true });

    const owner = await statusThroughRoutes(h.app, s.requestId, s.claimSecret);
    expect(owner.status).toBe(201);
    expect(owner.headers.getSetCookie().some((c) => c.startsWith("osn_session="))).toBe(true);
    const body = (await owner.json()) as { handle: string; session: { access_token: string } };
    expect(body.handle).toBe("claimer");
    expect(body.session.access_token.length).toBeGreaterThan(0);
  });

  it("gets the account once when two polls of a confirmed request land together", async () => {
    const h = harness();
    const s = await begun(h, "race@example.com", "racer");
    await confirmThroughRoutes(h.app, s.requestId, s.link.linkSecret, s.pairingCode);

    const both = await Promise.all([
      statusThroughRoutes(h.app, s.requestId, s.claimSecret),
      statusThroughRoutes(h.app, s.requestId, s.claimSecret),
    ]);
    expect(both.map((r) => r.status).toSorted()).toEqual([200, 201]);
    const loser = both.find((r) => r.status === 200)!;
    expect(await loser.json()).toEqual({ status: "expired" });
  });
});

describe("an expired request", () => {
  it("answers expired to confirm, poll and resend", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const h = harness();
    const s = await begun(h, "late@example.com", "late");
    vi.setSystemTime(Date.now() + 11 * MINUTE);

    const confirm = await confirmThroughRoutes(
      h.app,
      s.requestId,
      s.link.linkSecret,
      s.pairingCode,
    );
    const poll = await statusThroughRoutes(h.app, s.requestId, s.claimSecret);
    const resend = await resendThroughRoutes(h.app, s.requestId, s.claimSecret);
    expect(await confirm.json()).toEqual({ status: "expired" });
    expect(await poll.json()).toEqual({ status: "expired" });
    expect(await resend.json()).toEqual({ status: "expired" });
  });
});

describe("rate limits", () => {
  it("refuses the 61st status poll in a minute from one address", async () => {
    const h = harness();
    const s = await begun(h, "poll-limit@example.com", "polllimit");
    for (let n = 0; n < 60; n++) {
      expect((await statusThroughRoutes(h.app, s.requestId, s.claimSecret)).status).toBe(200);
    }
    expect((await statusThroughRoutes(h.app, s.requestId, s.claimSecret)).status).toBe(429);
  });

  it("refuses the 11th confirm in a minute from one address", async () => {
    const h = harness();
    const s = await begun(h, "confirm-limit@example.com", "confirmlimit");
    for (let n = 0; n < 10; n++) {
      const res = await confirmThroughRoutes(h.app, s.requestId, s.link.linkSecret, s.pairingCode);
      expect(res.status).toBe(200);
    }
    expect(
      (await confirmThroughRoutes(h.app, s.requestId, s.link.linkSecret, s.pairingCode)).status,
    ).toBe(429);
  });

  it("refuses the 21st candidates read in a minute from one address", async () => {
    const h = harness();
    const s = await begun(h, "candidates-limit@example.com", "candidateslimit");
    for (let n = 0; n < 20; n++) {
      const res = await candidatesThroughRoutes(h.app, s.requestId, s.link.linkSecret);
      expect(res.status).toBe(200);
    }
    expect((await candidatesThroughRoutes(h.app, s.requestId, s.link.linkSecret)).status).toBe(429);
  });

  it("refuses the 6th resend in a minute from one address", async () => {
    const h = harness();
    const s = await begun(h, "resend-limit@example.com", "resendlimit");
    for (let n = 0; n < 5; n++) {
      expect((await resendThroughRoutes(h.app, s.requestId, s.claimSecret)).status).toBe(200);
    }
    expect((await resendThroughRoutes(h.app, s.requestId, s.claimSecret)).status).toBe(429);
  });
});

describe("resend", () => {
  it("sends at most three links for one request, and none without the claim secret", async () => {
    const h = harness();
    const email = "resend-cap@example.com";
    const s = await begun(h, email, "resendcap");

    const stranger = await resendThroughRoutes(h.app, s.requestId, WRONG_SECRET);
    expect(await stranger.json()).toEqual({ status: "expired" });
    expect(linksTo(h.recorded(), email)).toHaveLength(1);

    expect(await (await resendThroughRoutes(h.app, s.requestId, s.claimSecret)).json()).toEqual({
      status: "sent",
    });
    expect(await (await resendThroughRoutes(h.app, s.requestId, s.claimSecret)).json()).toEqual({
      status: "sent",
    });
    expect(await (await resendThroughRoutes(h.app, s.requestId, s.claimSecret)).json()).toEqual({
      status: "limit",
    });
    const links = linksTo(h.recorded(), email);
    expect(links).toHaveLength(3);

    // Every link sent for the request still confirms it.
    const first = await confirmThroughRoutes(
      h.app,
      links[0]!.requestId,
      links[0]!.linkSecret,
      s.pairingCode,
    );
    expect(await first.json()).toEqual({ status: "confirmed" });
  });

  it("mails nothing for a second begin made while the address's first sign-up is live", async () => {
    const h = harness();
    const email = "second-begin@example.com";
    await begun(h, email, "secondbegin");
    const second = await beginThroughRoutes(h.app, { email, handle: "secondbegin" });
    expect(linksTo(h.recorded(), email)).toHaveLength(1);

    const resent = await resendThroughRoutes(h.app, second.body.requestId, second.body.claimSecret);
    expect(await resent.json()).toEqual({ status: "sent" });
    expect(linksTo(h.recorded(), email)).toHaveLength(1);
  });

  it("parks a second begin's sign-up on its Resend once the first has ended, and its link finishes it", async () => {
    const h = harness();
    const email = "parks-later@example.com";
    // Two tabs, neither knowing of the other: no `previous`.
    const first = await begun(h, email, "parksfirst");
    const second = await beginThroughRoutes(h.app, { email, handle: "parkssecond" });
    expect(linksTo(h.recorded(), email)).toHaveLength(1);

    // While the first is live, the second's Resend mails nothing.
    const whileHeld = await resendThroughRoutes(
      h.app,
      second.body.requestId,
      second.body.claimSecret,
    );
    expect(await whileHeld.json()).toEqual({ status: "sent" });
    expect(linksTo(h.recorded(), email)).toHaveLength(1);

    // The first link's reader says they did not ask, which ends the first.
    const declined = await confirmThroughRoutes(
      h.app,
      first.requestId,
      first.link.linkSecret,
      "none",
    );
    expect(await declined.json()).toEqual({ status: "declined" });

    const resent = await resendThroughRoutes(h.app, second.body.requestId, second.body.claimSecret);
    expect(await resent.json()).toEqual({ status: "sent" });
    const links = linksTo(h.recorded(), email);
    expect(links).toHaveLength(2);
    expect(links[1]!.requestId).toBe(second.body.requestId);

    const confirmed = await confirmThroughRoutes(
      h.app,
      links[1]!.requestId,
      links[1]!.linkSecret,
      second.body.pairingCode,
    );
    expect(await confirmed.json()).toEqual({ status: "confirmed" });
    const done = await statusThroughRoutes(h.app, second.body.requestId, second.body.claimSecret);
    expect(done.status).toBe(201);
    expect(await done.json()).toMatchObject({ handle: "parkssecond", email });
  });

  it("mails nothing on a second begin's Resend once the first has made the account", async () => {
    const h = harness();
    const email = "parks-taken@example.com";
    const first = await begun(h, email, "parkstakenfirst");
    const second = await beginThroughRoutes(h.app, { email, handle: "parkstakensecond" });

    const confirmed = await confirmThroughRoutes(
      h.app,
      first.requestId,
      first.link.linkSecret,
      first.pairingCode,
    );
    expect(await confirmed.json()).toEqual({ status: "confirmed" });
    const done = await statusThroughRoutes(h.app, first.requestId, first.claimSecret);
    expect(done.status).toBe(201);

    // The first sign-up ended by making the account, so the second's Resend
    // parks its sign-up; the address has an account, so nothing goes.
    const resent = await resendThroughRoutes(h.app, second.body.requestId, second.body.claimSecret);
    expect(await resent.json()).toEqual({ status: "sent" });
    expect(linksTo(h.recorded(), email)).toHaveLength(1);
    const poll = await statusThroughRoutes(h.app, second.body.requestId, second.body.claimSecret);
    expect(await poll.json()).toEqual({ status: "pending", pairingCode: second.body.pairingCode });
  });

  it("mails nothing on a Resend once another account has taken the request's handle", async () => {
    const h = harness();
    const email = "handle-gone@example.com";
    const s = await begun(h, email, "handlegone");
    await registerThroughRoutes(h.app, h.recorded, "handle-gone-other@example.com", "handlegone");

    const resent = await resendThroughRoutes(h.app, s.requestId, s.claimSecret);
    expect(await resent.json()).toEqual({ status: "sent" });
    expect(linksTo(h.recorded(), email)).toHaveLength(1);
  });

  it("resends one address no more than six links an hour across requests, and always sends a begin's first", async () => {
    const h = harness();
    const email = "address-cap@example.com";
    let current = await beginThroughRoutes(h.app, { email, handle: "addrcap" });
    for (let round = 0; round < 3; round++) {
      // Each round from its own address, so the per-IP Resend limit stays out of it.
      const from = { "x-forwarded-for": `10.0.0.${round + 1}` };
      await resendThroughRoutes(h.app, current.body.requestId, current.body.claimSecret, from);
      await resendThroughRoutes(h.app, current.body.requestId, current.body.claimSecret, from);
      current = await beginThroughRoutes(h.app, {
        email,
        handle: "addrcap",
        previous: { requestId: current.body.requestId, retireSecret: current.body.retireSecret },
      });
    }
    // Four begins, each with its first link, and six Resends: ten mailed.
    expect(linksTo(h.recorded(), email)).toHaveLength(10);
    // The seventh Resend in the hour mails nothing; the fourth begin's link stands.
    const answer = await resendThroughRoutes(
      h.app,
      current.body.requestId,
      current.body.claimSecret,
      { "x-forwarded-for": "10.0.0.9" },
    );
    expect(await answer.json()).toEqual({ status: "sent" });
    expect(linksTo(h.recorded(), email)).toHaveLength(10);
    expect(linksTo(h.recorded(), email).at(-1)!.requestId).toBe(current.body.requestId);
  });

  it("counts Resends to every +tag variant of a local part against one cap, on any domain", async () => {
    const h = harness();
    // Two Resends on each of three requests: the key's six for the hour.
    for (const tag of ["a", "b", "c"]) {
      const email = `capfold+${tag}@custom.example`;
      const s = await begun(h, email, `capfold${tag}`);
      const from = { "x-forwarded-for": `10.0.1.${tag.charCodeAt(0)}` };
      await resendThroughRoutes(h.app, s.requestId, s.claimSecret, from);
      await resendThroughRoutes(h.app, s.requestId, s.claimSecret, from);
      expect(linksTo(h.recorded(), email)).toHaveLength(3);
    }
    // A fourth variant gets its begin's first link, and its Resend mails nothing.
    const email = "capfold+d@custom.example";
    const last = await begun(h, email, "capfoldd");
    const answer = await resendThroughRoutes(h.app, last.requestId, last.claimSecret, {
      "x-forwarded-for": "10.0.1.200",
    });
    expect(await answer.json()).toEqual({ status: "sent" });
    expect(linksTo(h.recorded(), email)).toHaveLength(1);
    // A different local part on the same domain keeps its own cap.
    const other = "capfold2@custom.example";
    const fresh = await begun(h, other, "capfold2");
    await resendThroughRoutes(h.app, fresh.requestId, fresh.claimSecret, {
      "x-forwarded-for": "10.0.1.201",
    });
    expect(linksTo(h.recorded(), other)).toHaveLength(2);
  });

  it("counts Resends to every form of one Gmail address against one cap", async () => {
    const h = harness();
    // Two Resends on each of three requests: the key's six for the hour.
    const forms = ["gcap.fold@gmail.com", "gcapfold+z@googlemail.com", "gcapfold@gmail.com"];
    for (const [n, email] of forms.entries()) {
      const s = await begun(h, email, `gcapfold${n}`);
      const from = { "x-forwarded-for": `10.0.4.${n + 1}` };
      await resendThroughRoutes(h.app, s.requestId, s.claimSecret, from);
      await resendThroughRoutes(h.app, s.requestId, s.claimSecret, from);
      expect(linksTo(h.recorded(), email)).toHaveLength(3);
    }
    // A fourth form gets its begin's first link, and its Resend mails nothing.
    const email = "g.capfold+w@gmail.com";
    const last = await begun(h, email, "gcapfold3");
    await resendThroughRoutes(h.app, last.requestId, last.claimSecret, {
      "x-forwarded-for": "10.0.4.200",
    });
    expect(linksTo(h.recorded(), email)).toHaveLength(1);
  });

  it("mails a +tag sign-up to the address as typed, and makes the account under it", async () => {
    const h = harness();
    const typed = "Exact.Name+Tag@Gmail.com";
    const exact = typed.toLowerCase();
    const s = await beginThroughRoutes(h.app, { email: typed, handle: "exacttag" });
    const link = latestLinkTo(h.recorded(), exact);
    expect(link?.requestId).toBe(s.body.requestId);
    expect(h.recorded().map((mail) => mail.to)).toEqual([exact]);
    await confirmThroughRoutes(h.app, link!.requestId, link!.linkSecret, s.body.pairingCode);
    const done = await statusThroughRoutes(h.app, s.body.requestId, s.body.claimSecret);
    expect(done.status).toBe(201);
    expect(((await done.json()) as { email: string }).email).toBe(exact);
  });
});

describe("previous on begin", () => {
  it("retires the earlier request only for the holder of its retire secret, and mails at once", async () => {
    const h = harness();
    const email = "previous@example.com";
    const first = await begun(h, email, "previous");

    // A wrong retire secret, an unknown request and the claim secret in the
    // retire secret's place each answer as a begin with no `previous` does:
    // the address stays held and nothing is mailed.
    const tries = [
      { requestId: first.requestId, retireSecret: WRONG_SECRET },
      { requestId: "signup_0123456789ab", retireSecret: first.retireSecret },
      { requestId: first.requestId, retireSecret: first.claimSecret },
    ];
    const bare = await beginThroughRoutes(
      h.app,
      { email, handle: "previous" },
      { "x-forwarded-for": "10.0.8.7" },
    );
    for (const [n, previous] of tries.entries()) {
      // eslint-disable-next-line no-await-in-loop -- each refusal is checked before the next
      const refused = await beginThroughRoutes(
        h.app,
        { email, handle: "previous", previous },
        { "x-forwarded-for": `10.0.8.${n}` },
      );
      expect(refused.res.status).toBe(bare.res.status);
      expect(Object.keys(refused.body).toSorted()).toEqual(Object.keys(bare.body).toSorted());
    }
    // The right secret with a begin for another address: that begin goes on
    // as any begin for a free address, and the first request is left alone.
    const elsewhere = "previous-elsewhere@example.com";
    await beginThroughRoutes(
      h.app,
      {
        email: elsewhere,
        handle: "previouselse",
        previous: { requestId: first.requestId, retireSecret: first.retireSecret },
      },
      { "x-forwarded-for": "10.0.8.8" },
    );
    expect(linksTo(h.recorded(), elsewhere)).toHaveLength(1);
    expect(linksTo(h.recorded(), email)).toHaveLength(1);
    const stillLive = await statusThroughRoutes(h.app, first.requestId, first.claimSecret);
    expect(await stillLive.json()).toEqual({ status: "pending", pairingCode: first.pairingCode });

    const owned = await beginThroughRoutes(
      h.app,
      {
        email,
        handle: "previous2",
        previous: { requestId: first.requestId, retireSecret: first.retireSecret },
      },
      { "x-forwarded-for": "10.0.8.9" },
    );
    const links = linksTo(h.recorded(), email);
    expect(links).toHaveLength(2);
    expect(
      await (
        await confirmThroughRoutes(h.app, first.requestId, first.link.linkSecret, first.pairingCode)
      ).json(),
    ).toEqual({ status: "expired" });

    const next = links[1]!;
    expect(next.requestId).toBe(owned.body.requestId);
    await confirmThroughRoutes(h.app, next.requestId, next.linkSecret, owned.body.pairingCode);
    const done = await statusThroughRoutes(h.app, owned.body.requestId, owned.body.claimSecret);
    expect(done.status).toBe(201);
    expect(((await done.json()) as { handle: string }).handle).toBe("previous2");
  });

  it("retires a request whose link was confirmed but never claimed, and the new begin mails at once", async () => {
    // The tab that began closed after the link was confirmed on another
    // device; a new tab of the same browser begins again for the address.
    const h = harness();
    const email = "confirmed-left@example.com";
    const first = await begun(h, email, "confirmedleft");
    const confirmed = await confirmThroughRoutes(
      h.app,
      first.requestId,
      first.link.linkSecret,
      first.pairingCode,
    );
    expect(await confirmed.json()).toEqual({ status: "confirmed" });

    const again = await beginThroughRoutes(h.app, {
      email,
      handle: "confirmedleft",
      previous: { requestId: first.requestId, retireSecret: first.retireSecret },
    });
    const links = linksTo(h.recorded(), email);
    expect(links).toHaveLength(2);
    expect(links[1]!.requestId).toBe(again.body.requestId);

    // The retired request makes no account for whoever holds its claim secret.
    const old = await statusThroughRoutes(h.app, first.requestId, first.claimSecret);
    expect(await old.json()).toEqual({ status: "expired" });
    await confirmThroughRoutes(
      h.app,
      links[1]!.requestId,
      links[1]!.linkSecret,
      again.body.pairingCode,
    );
    const done = await statusThroughRoutes(h.app, again.body.requestId, again.body.claimSecret);
    expect(done.status).toBe(201);
  });
});

describe("the retire secret", () => {
  it("is refused exactly as a wrong secret on the status, resend, candidates and confirm routes", async () => {
    const h = harness();
    const email = "retire-only@example.com";
    const s = await begun(h, email, "retireonly");
    await confirmThroughRoutes(h.app, s.requestId, s.link.linkSecret, s.pairingCode);

    /** One call made with the retire secret, and the same call with a wrong secret. */
    const both = async (call: (secret: string) => Promise<Response>) => {
      const read = async (res: Response) => ({
        status: res.status,
        body: await res.json(),
        cookies: res.headers.getSetCookie(),
      });
      return {
        retire: await read(await call(s.retireSecret)),
        wrong: await read(await call(WRONG_SECRET)),
      };
    };

    // The poll that would make the account and hand out its session.
    const status = await both((secret) => statusThroughRoutes(h.app, s.requestId, secret));
    expect(status.retire).toEqual(status.wrong);
    expect(status.retire).toEqual({ status: 200, body: { status: "expired" }, cookies: [] });

    const resend = await both((secret) => resendThroughRoutes(h.app, s.requestId, secret));
    expect(resend.retire).toEqual(resend.wrong);
    expect(resend.retire.body).toEqual({ status: "expired" });
    expect(linksTo(h.recorded(), email)).toHaveLength(1);

    const candidates = await both((secret) => candidatesThroughRoutes(h.app, s.requestId, secret));
    expect(candidates.retire).toEqual(candidates.wrong);
    expect(candidates.retire.body).toEqual({ status: "expired" });

    const confirm = await both((secret) =>
      confirmThroughRoutes(h.app, s.requestId, secret, s.pairingCode),
    );
    expect(confirm.retire).toEqual(confirm.wrong);
    expect(confirm.retire.body).toEqual({ status: "expired" });

    // None of it spent the request: its own claim secret still finishes it.
    const owner = await statusThroughRoutes(h.app, s.requestId, s.claimSecret);
    expect(owner.status).toBe(201);
  });

  it("is handed out for a taken address as for a free one, and retiring either answers alike", async () => {
    const h = harness();
    await registerThroughRoutes(h.app, h.recorded, "retire-taken@example.com", "retiretaken");
    const free = await begun(h, "retire-free@example.com", "retirefree");
    const taken = await beginThroughRoutes(h.app, {
      email: "retire-taken@example.com",
      handle: "retiretakentwo",
    });
    for (const body of [free, taken.body]) {
      expect(body.retireSecret).toMatch(/^[a-f0-9]{64}$/);
      expect(body.retireSecret).not.toBe(body.claimSecret);
    }

    const a = await beginThroughRoutes(
      h.app,
      {
        email: "retire-free@example.com",
        handle: "retirenexta",
        previous: { requestId: free.requestId, retireSecret: free.retireSecret },
      },
      { "x-forwarded-for": "10.0.9.1" },
    );
    const b = await beginThroughRoutes(
      h.app,
      {
        email: "retire-taken@example.com",
        handle: "retirenextb",
        previous: { requestId: taken.body.requestId, retireSecret: taken.body.retireSecret },
      },
      { "x-forwarded-for": "10.0.9.2" },
    );
    expect(b.res.status).toBe(a.res.status);
    expect(Object.keys(b.body).toSorted()).toEqual(Object.keys(a.body).toSorted());
    // Both retired: each one's poll now reads as an unknown request's.
    const aPoll = await statusThroughRoutes(h.app, free.requestId, free.claimSecret);
    const bPoll = await statusThroughRoutes(h.app, taken.body.requestId, taken.body.claimSecret);
    expect(await aPoll.json()).toEqual({ status: "expired" });
    expect(await bPoll.json()).toEqual({ status: "expired" });
  });
});

/** A candidate that is not `code`. */
async function wrongPickFor(
  h: ReturnType<typeof harness>,
  s: { requestId: string; pairingCode: string; link: { linkSecret: string } },
): Promise<string> {
  const read = await candidatesThroughRoutes(h.app, s.requestId, s.link.linkSecret);
  const { pairingCandidates } = (await read.json()) as { pairingCandidates: string[] };
  return pairingCandidates.find((c) => c !== s.pairingCode)!;
}

describe("input the routes refuse", () => {
  const SHORT_SECRET = "a".repeat(63);

  async function stillPending(
    h: ReturnType<typeof harness>,
    s: { requestId: string; claimSecret: string; pairingCode: string },
  ) {
    expect(await (await statusThroughRoutes(h.app, s.requestId, s.claimSecret)).json()).toEqual({
      status: "pending",
      pairingCode: s.pairingCode,
    });
  }

  function expectRefused(res: Response) {
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  }

  it("refuses a 63-character secret on every route, counting no guess, and the request stays pending", async () => {
    const h = harness();
    const s = await begun(h, "short-secret@example.com", "shortsecret");

    expectRefused(await candidatesThroughRoutes(h.app, s.requestId, SHORT_SECRET));
    expectRefused(await confirmThroughRoutes(h.app, s.requestId, SHORT_SECRET, s.pairingCode));
    expectRefused(await statusThroughRoutes(h.app, s.requestId, SHORT_SECRET));
    expectRefused(await resendThroughRoutes(h.app, s.requestId, SHORT_SECRET));
    expect(linksTo(h.recorded(), "short-secret@example.com")).toHaveLength(1);

    // Five more refused reads would have wiped the request had each counted.
    for (let n = 0; n < MAX_OTP_ATTEMPTS; n++) {
      expectRefused(await candidatesThroughRoutes(h.app, s.requestId, SHORT_SECRET));
    }
    await stillPending(h, s);
    const confirmed = await confirmThroughRoutes(
      h.app,
      s.requestId,
      s.link.linkSecret,
      s.pairingCode,
    );
    expect(await confirmed.json()).toEqual({ status: "confirmed" });
  });

  it.each([
    ["a request id of the wrong shape", { requestId: "signup_zz", retireSecret: "a".repeat(64) }],
    ["another flow's prefix", { requestId: "recover_0123456789ab", retireSecret: "a".repeat(64) }],
    [
      "a 63-character retire secret",
      { requestId: "signup_0123456789ab", retireSecret: SHORT_SECRET },
    ],
    [
      "a claim secret in the retire secret's place",
      { requestId: "signup_0123456789ab", claimSecret: "a".repeat(64) },
    ],
  ])(
    "refuses begin's `previous` with %s before Turnstile and before any store call",
    async (_, previous) => {
      const fake = createFakeNamespace();
      const stores = createDurableCoordination(fake.ns, () => {});
      const turnstileCalls: unknown[] = [];
      const verifier: TurnstileVerifier = {
        async verify(token) {
          turnstileCalls.push(token);
          return { ok: true, errorCodes: [] };
        },
      };
      const app = createAuthRoutes(
        { ...config, ceremonyStores: stores.ceremonyStores },
        Layer.merge(createTestLayer(), makeLogEmailLive().layer),
        Layer.empty,
        undefined,
        { secure: false },
        undefined,
        undefined,
        verifier,
      );
      const { res } = await beginThroughRoutes(app, {
        email: "bad-previous@example.com",
        handle: "badprevious",
        // Sent as the body would carry it, whatever its shape.
        previous: previous as { requestId: string; retireSecret: string },
        turnstileToken: "good",
      });
      expectRefused(res);
      expect(turnstileCalls).toEqual([]);
      expect(fake.calls).toEqual([]);
    },
  );

  it("refuses a pick that is not two digits or `none`, with no strike, and the right pick still confirms", async () => {
    const h = harness();
    const s = await begun(h, "bad-pick@example.com", "badpick");

    // Checked against the flow's format before any store call, and answered
    // as every other refusal is.
    for (const pick of ["100", "7", "abc", "1.5", "NONE"]) {
      // eslint-disable-next-line no-await-in-loop -- each refusal is checked before the next
      const res = await confirmThroughRoutes(h.app, s.requestId, s.link.linkSecret, pick);
      expect(res.status).toBe(200);
      // eslint-disable-next-line no-await-in-loop -- each refusal is checked before the next
      expect(await res.json()).toEqual({ status: "expired" });
    }
    await stillPending(h, s);
    const confirmed = await confirmThroughRoutes(
      h.app,
      s.requestId,
      s.link.linkSecret,
      s.pairingCode,
    );
    expect(await confirmed.json()).toEqual({ status: "confirmed" });
  });

  it("answers a poll 200 conflict when the handle was taken while the person waited", async () => {
    const h = harness();
    const s = await begun(h, "route-conflict@example.com", "routeconflict");
    const confirmed = await confirmThroughRoutes(
      h.app,
      s.requestId,
      s.link.linkSecret,
      s.pairingCode,
    );
    expect(await confirmed.json()).toEqual({ status: "confirmed" });
    await Effect.runPromise(
      createAuthService(config)
        .registerProfile("someone-else@example.com", "routeconflict")
        .pipe(Effect.provide(h.db)),
    );

    const poll = await statusThroughRoutes(h.app, s.requestId, s.claimSecret);
    expect(poll.status).toBe(200);
    expect(await poll.json()).toEqual({ status: "conflict" });
  });
});

describe("the number on the waiting screen", () => {
  it("is among the candidates, which are distinct, sorted and the same on every read and after a Resend", async () => {
    const h = harness();
    const s = await begun(h, "pairing@example.com", "pairing");

    const first = (await (
      await candidatesThroughRoutes(h.app, s.requestId, s.link.linkSecret)
    ).json()) as { status: string; pairingCandidates: string[] };
    expect(first.status).toBe("ready");
    const list = first.pairingCandidates;
    expect(list).toHaveLength(EMAIL_LINK_PAIRING_CANDIDATES);
    expect(new Set(list).size).toBe(list.length);
    expect(list.every((c) => /^[1-9][0-9]$/.test(c))).toBe(true);
    expect(list.toSorted((a, b) => Number(a) - Number(b))).toEqual(list);
    expect(list).toContain(s.pairingCode);

    await resendThroughRoutes(h.app, s.requestId, s.claimSecret);
    const resent = linksTo(h.recorded(), "pairing@example.com").at(-1)!;
    const again = (await (
      await candidatesThroughRoutes(h.app, s.requestId, resent.linkSecret)
    ).json()) as { pairingCandidates: string[] };
    expect(again.pairingCandidates).toEqual(list);
  });

  it("confirms the request when picked", async () => {
    const h = harness();
    const s = await begun(h, "right-pick@example.com", "rightpick");
    const res = await confirmThroughRoutes(h.app, s.requestId, s.link.linkSecret, s.pairingCode);
    expect(await res.json()).toEqual({ status: "confirmed" });
    expect((await statusThroughRoutes(h.app, s.requestId, s.claimSecret)).status).toBe(201);
  });

  it("ends the request at once when another number is picked; the right one then answers as unknown", async () => {
    const h = harness();
    const email = "wrong-pick@example.com";
    const s = await begun(h, email, "wrongpick");
    const wrong = await wrongPickFor(h, s);

    const res = await confirmThroughRoutes(h.app, s.requestId, s.link.linkSecret, wrong);
    expect(await res.json()).toEqual({ status: "expired" });
    const right = await confirmThroughRoutes(h.app, s.requestId, s.link.linkSecret, s.pairingCode);
    expect(await right.json()).toEqual({ status: "expired" });
    // The tab that began reads it as a request nobody acted on.
    expect(await (await statusThroughRoutes(h.app, s.requestId, s.claimSecret)).json()).toEqual({
      status: "pending",
      pairingCode: s.pairingCode,
    });

    // The address is free again at once.
    const again = await begun(h, email, "wrongpick");
    expect(again.requestId).not.toBe(s.requestId);
  });

  it("ends the request when the reader did not ask for it, and says so again when the decline is repeated", async () => {
    const h = harness();
    const email = "decline@example.com";
    const s = await begun(h, email, "decline");

    // A decline whose answer was lost is sent again by the page's Try again,
    // and must come back as the same answer.
    for (let n = 0; n < 2; n++) {
      const res = await confirmThroughRoutes(h.app, s.requestId, s.link.linkSecret, "none");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: "declined" });
    }

    const right = await confirmThroughRoutes(h.app, s.requestId, s.link.linkSecret, s.pairingCode);
    expect(await right.json()).toEqual({ status: "expired" });
    // The tab that began reads it as a request nobody acted on, and its
    // Resend mails nothing.
    expect(await (await statusThroughRoutes(h.app, s.requestId, s.claimSecret)).json()).toEqual({
      status: "pending",
      pairingCode: s.pairingCode,
    });
    expect(await (await resendThroughRoutes(h.app, s.requestId, s.claimSecret)).json()).toEqual({
      status: "sent",
    });
    expect(
      await (await candidatesThroughRoutes(h.app, s.requestId, s.link.linkSecret)).json(),
    ).toEqual({ status: "expired" });
    expect(linksTo(h.recorded(), email)).toHaveLength(1);

    // The address is free again at once.
    const again = await begun(h, email, "decline");
    expect(again.link.requestId).toBe(again.requestId);
    expect(again.requestId).not.toBe(s.requestId);
  });

  it("ends an already-confirmed request when the reader declines, and no account is made", async () => {
    const h = harness();
    const s = await begun(h, "late-decline@example.com", "latedecline");
    await confirmThroughRoutes(h.app, s.requestId, s.link.linkSecret, s.pairingCode);

    const res = await confirmThroughRoutes(h.app, s.requestId, s.link.linkSecret, "none");
    expect(await res.json()).toEqual({ status: "declined" });
    expect(await (await statusThroughRoutes(h.app, s.requestId, s.claimSecret)).json()).toEqual({
      status: "pending",
      pairingCode: s.pairingCode,
    });
    const handle = await h.app.handle(new Request("http://localhost/handle/latedecline"));
    expect(await handle.json()).toEqual({ available: true });
  });

  it("is given back to the tab that began on every pending poll, so a reloaded tab can show it", async () => {
    const h = harness();
    const s = await begun(h, "poll-number@example.com", "pollnumber");
    for (let n = 0; n < 2; n++) {
      const poll = await statusThroughRoutes(h.app, s.requestId, s.claimSecret);
      expect(await poll.json()).toEqual({ status: "pending", pairingCode: s.pairingCode });
    }
    await resendThroughRoutes(h.app, s.requestId, s.claimSecret);
    const afterResend = await statusThroughRoutes(h.app, s.requestId, s.claimSecret);
    expect(await afterResend.json()).toEqual({ status: "pending", pairingCode: s.pairingCode });
  });

  it("ends an already-confirmed request when another number is picked, and no account is made", async () => {
    const h = harness();
    const s = await begun(h, "late-wrong@example.com", "latewrong");
    const wrong = await wrongPickFor(h, s);
    await confirmThroughRoutes(h.app, s.requestId, s.link.linkSecret, s.pairingCode);

    const res = await confirmThroughRoutes(h.app, s.requestId, s.link.linkSecret, wrong);
    expect(await res.json()).toEqual({ status: "expired" });
    expect(await (await statusThroughRoutes(h.app, s.requestId, s.claimSecret)).json()).toEqual({
      status: "pending",
      pairingCode: s.pairingCode,
    });
    const handle = await h.app.handle(new Request("http://localhost/handle/latewrong"));
    expect(await handle.json()).toEqual({ available: true });
  });

  it("makes no account when a right and a wrong pick land together", async () => {
    const h = harness();
    const s = await begun(h, "pick-race@example.com", "pickrace");
    const wrong = await wrongPickFor(h, s);

    await Promise.all([
      confirmThroughRoutes(h.app, s.requestId, s.link.linkSecret, s.pairingCode),
      confirmThroughRoutes(h.app, s.requestId, s.link.linkSecret, wrong),
    ]);
    expect(await (await statusThroughRoutes(h.app, s.requestId, s.claimSecret)).json()).toEqual({
      status: "pending",
      pairingCode: s.pairingCode,
    });
    const handle = await h.app.handle(new Request("http://localhost/handle/pickrace"));
    expect(await handle.json()).toEqual({ available: true });
  });

  it("is required: a confirm without a pick is refused before it touches the request", async () => {
    const h = harness();
    const s = await begun(h, "no-pick@example.com", "nopick");
    const res = await h.app.handle(
      new Request(`http://localhost/email-link/${s.requestId}/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ linkSecret: s.link.linkSecret }),
      }),
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(await (await statusThroughRoutes(h.app, s.requestId, s.claimSecret)).json()).toEqual({
      status: "pending",
      pairingCode: s.pairingCode,
    });
  });

  it(`stops links to an address after ${REGISTRATION_LINK_LOCKOUT_THRESHOLD} wrong picks`, async () => {
    const h = harness();
    const email = "strikes@example.com";
    for (let n = 0; n < REGISTRATION_LINK_LOCKOUT_THRESHOLD; n++) {
      const s = await begun(h, email, "strikes");
      await confirmThroughRoutes(h.app, s.requestId, s.link.linkSecret, await wrongPickFor(h, s));
    }
    const mailed = linksTo(h.recorded(), email).length;
    const after = await beginThroughRoutes(h.app, { email, handle: "strikes" });
    expect(after.res.status).toBe(200);
    expect(linksTo(h.recorded(), email)).toHaveLength(mailed);
  });

  it("counts wrong picks against the address as typed: a +tag variant keeps its own count", async () => {
    const h = harness();
    const struck = "splitstrike+x@custom.example";
    for (let n = 0; n < REGISTRATION_LINK_LOCKOUT_THRESHOLD; n++) {
      const s = await begun(h, struck, "splitstrike");
      await confirmThroughRoutes(h.app, s.requestId, s.link.linkSecret, await wrongPickFor(h, s));
    }
    // Another +tag variant of the same local part still gets its link.
    const variant = await begun(h, "splitstrike+y@custom.example", "splitstrike");
    expect(variant.link.requestId).toBe(variant.requestId);
    // The struck address does not.
    const mailed = linksTo(h.recorded(), struck).length;
    await beginThroughRoutes(h.app, { email: struck, handle: "splitstrike" });
    expect(linksTo(h.recorded(), struck)).toHaveLength(mailed);
  });

  it("counts wrong picks against the address as typed: Gmail's other forms keep their own count", async () => {
    const h = harness();
    const struck = "g.strike@gmail.com";
    for (let n = 0; n < REGISTRATION_LINK_LOCKOUT_THRESHOLD; n++) {
      const s = await begun(h, struck, "gstrike");
      await confirmThroughRoutes(h.app, s.requestId, s.link.linkSecret, await wrongPickFor(h, s));
    }
    for (const [n, email] of ["gstrike+z@googlemail.com", "gstrike@gmail.com"].entries()) {
      await beginThroughRoutes(
        h.app,
        { email, handle: "gstrike" },
        { "x-forwarded-for": `10.0.5.${n + 1}` },
      );
      expect(linksTo(h.recorded(), email)).toHaveLength(1);
    }
  });

  it("counts nothing against an address for declining requests it did not start", async () => {
    const h = harness();
    const email = "declines@example.com";
    for (let n = 0; n < REGISTRATION_LINK_LOCKOUT_THRESHOLD; n++) {
      const s = await begun(h, email, "declines");
      await confirmThroughRoutes(h.app, s.requestId, s.link.linkSecret, "none");
    }
    const after = await begun(h, email, "declines");
    expect(after.link.requestId).toBe(after.requestId);
  });
});

describe("the candidates read", () => {
  it("answers as unknown without the link's secret, and five wrong secrets spend the request", async () => {
    const h = harness();
    const s = await begun(h, "read-wrong@example.com", "readwrong");
    for (let n = 0; n < MAX_OTP_ATTEMPTS; n++) {
      const res = await candidatesThroughRoutes(h.app, s.requestId, WRONG_SECRET);
      expect(await res.json()).toEqual({ status: "expired" });
    }
    // Past the count no confirm is compared, the right one included.
    const right = await confirmThroughRoutes(h.app, s.requestId, s.link.linkSecret, s.pairingCode);
    expect(await right.json()).toEqual({ status: "expired" });
  });

  it("counts nothing for the right secret: a page read many times still confirms", async () => {
    const h = harness();
    const s = await begun(h, "read-many@example.com", "readmany");
    for (let n = 0; n < MAX_OTP_ATTEMPTS + 1; n++) {
      const res = await candidatesThroughRoutes(h.app, s.requestId, s.link.linkSecret);
      expect(((await res.json()) as { status: string }).status).toBe("ready");
    }
    const res = await confirmThroughRoutes(h.app, s.requestId, s.link.linkSecret, s.pairingCode);
    expect(await res.json()).toEqual({ status: "confirmed" });
  });

  it("offers no list once the request is confirmed", async () => {
    const h = harness();
    const s = await begun(h, "read-done@example.com", "readdone");
    await confirmThroughRoutes(h.app, s.requestId, s.link.linkSecret, s.pairingCode);
    const res = await candidatesThroughRoutes(h.app, s.requestId, s.link.linkSecret);
    expect(await res.json()).toEqual({ status: "confirmed" });
  });

  it("has no GET", async () => {
    const h = harness();
    const s = await begun(h, "read-get@example.com", "readget");
    const res = await h.app.handle(
      new Request(`http://localhost/email-link/${s.requestId}/candidates`),
    );
    expect(res.status).toBe(404);
  });
});

/**
 * The tab that began is answered alike whatever the link's reader does: a
 * request its reader declined or mis-picked reads as a taken address's,
 * which is never mailed, until both expire.
 */
describe("a request its reader ended", () => {
  const scenario = async (act: "decline" | "wrong pick") => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const h = harness();
    const tag = act === "decline" ? "d" : "w";
    await registerThroughRoutes(
      h.app,
      h.recorded,
      `ended-taken-${tag}@example.com`,
      `endtaken${tag}`,
    );
    const free = await begun(h, `ended-free-${tag}@example.com`, `endfree${tag}`);
    const taken = await beginThroughRoutes(h.app, {
      email: `ended-taken-${tag}@example.com`,
      handle: `endtakentwo${tag}`,
    });
    const pick = act === "decline" ? "none" : await wrongPickFor(h, free);
    await confirmThroughRoutes(h.app, free.requestId, free.link.linkSecret, pick);
    const mailed = h.recorded().length;

    const answers = async () => {
      const from = { "x-forwarded-for": `10.0.8.${Math.floor(Date.now() / MINUTE) % 200}` };
      const a = await statusThroughRoutes(h.app, free.requestId, free.claimSecret, from);
      const b = await statusThroughRoutes(
        h.app,
        taken.body.requestId,
        taken.body.claimSecret,
        from,
      );
      const c = await resendThroughRoutes(h.app, free.requestId, free.claimSecret, from);
      const d = await resendThroughRoutes(
        h.app,
        taken.body.requestId,
        taken.body.claimSecret,
        from,
      );
      return {
        free: {
          poll: { status: a.status, body: pollShape(await a.json()) },
          resend: { status: c.status, body: await c.json() },
        },
        taken: {
          poll: { status: b.status, body: pollShape(await b.json()) },
          resend: { status: d.status, body: await d.json() },
        },
      };
    };

    vi.setSystemTime(Date.now() + MINUTE);
    const soon = await answers();
    vi.setSystemTime(Date.now() + 10 * MINUTE);
    const after = await answers();

    expect(soon.free).toEqual(soon.taken);
    expect(after.free).toEqual(after.taken);
    expect(soon.free.poll.body).toEqual({ status: "pending", pairingCode: "two digits" });
    expect(soon.free.resend.body).toEqual({ status: "sent" });
    expect(after.free.poll.body).toEqual({ status: "expired" });
    expect(after.free.resend.body).toEqual({ status: "expired" });
    // Nothing went out after the reader acted.
    expect(h.recorded().length).toBe(mailed);
  };

  it("after a decline, answers poll and Resend as for a taken address's request", async () => {
    await expect(scenario("decline")).resolves.toBeUndefined();
  });

  it("after a wrong pick, answers poll and Resend as for a taken address's request", async () => {
    await expect(scenario("wrong pick")).resolves.toBeUndefined();
  });
});

/**
 * Every first sign-up link counts against the mailbox's window, whatever form
 * of the address was typed: `+tag` variants, and Gmail's dots and
 * googlemail.com, share one. The mailbox's first link of the hour always goes;
 * a begin past the window answers as a mailed one does, and nothing is sent.
 * A carried `previous` and a decline count as every first link does.
 */
describe("the first-link window", () => {
  const ip = (n: number) => ({ "x-forwarded-for": `10.1.${Math.floor(n / 200)}.${n % 200}` });
  const MAX = REGISTRATION_FIRST_LINKS_MAX;

  it(`mails at most ${MAX} first links an hour to the +tag variants of one mailbox`, async () => {
    const h = harness();
    const forms = Array.from({ length: MAX + 1 }, (_, n) => `name+${n}@x.example`);
    for (const [n, email] of forms.entries()) {
      await beginThroughRoutes(h.app, { email, handle: `plusvar${n}` }, ip(n));
    }
    const mailed = forms.filter((email) => linksTo(h.recorded(), email).length > 0);
    expect(mailed).toHaveLength(MAX);
    expect(linksTo(h.recorded(), forms.at(-1)!)).toHaveLength(0);
    // Another mailbox on the same domain has a window of its own.
    await begun(h, "other@x.example", "plusother");
  });

  it(`mails at most ${MAX} first links an hour to the Gmail forms of one mailbox`, async () => {
    const h = harness();
    const forms = [
      "n.ame@gmail.com",
      "name@googlemail.com",
      "na.me+a@gmail.com",
      "name+b@googlemail.com",
      "nam.e@gmail.com",
      "n.a.m.e@gmail.com",
      "name+c@gmail.com",
      "na.me@googlemail.com",
      "name+d@gmail.com",
      "n.ame+e@googlemail.com",
      "name+f@gmail.com",
    ];
    expect(forms).toHaveLength(MAX + 1);
    for (const [n, email] of forms.entries()) {
      await beginThroughRoutes(h.app, { email, handle: `gmailform${n}` }, ip(n));
    }
    const mailed = forms.filter((email) => linksTo(h.recorded(), email).length > 0);
    expect(mailed).toHaveLength(MAX);
  });

  it("answers a begin past the window as a mailed one, sends it nothing, and polls it pending", async () => {
    const h = harness();
    const forms = Array.from({ length: MAX + 1 }, (_, n) => `held+${n}@x.example`);
    const begins = [];
    for (const [n, email] of forms.entries()) {
      begins.push(await beginThroughRoutes(h.app, { email, handle: `heldform${n}` }, ip(n)));
    }
    const first = begins[0]!;
    const held = begins.at(-1)!;
    expect(linksTo(h.recorded(), forms.at(-1)!)).toHaveLength(0);
    expect(held.res.status).toBe(first.res.status);
    expect(Object.keys(held.body).toSorted()).toEqual(Object.keys(first.body).toSorted());
    const poll = await statusThroughRoutes(h.app, held.body.requestId, held.body.claimSecret);
    expect(poll.status).toBe(200);
    expect(pollShape(await poll.json())).toEqual({ status: "pending", pairingCode: "two digits" });
  });

  it(`counts a loop of begin and decline, and of begins that retire the last, as first links`, async () => {
    const h = harness();
    const email = "loop-decline@example.com";
    for (let n = 0; n < MAX + 3; n++) {
      const { body } = await beginThroughRoutes(h.app, { email, handle: "loopdecline" }, ip(n));
      const link = latestLinkTo(h.recorded(), email);
      if (link?.requestId === body.requestId) {
        await confirmThroughRoutes(h.app, link.requestId, link.linkSecret, "none", ip(n));
      }
    }
    expect(linksTo(h.recorded(), email)).toHaveLength(MAX);

    const other = "loop-previous@example.com";
    let current = await beginThroughRoutes(h.app, { email: other, handle: "loopprev" }, ip(50));
    for (let n = 1; n <= MAX + 2; n++) {
      current = await beginThroughRoutes(
        h.app,
        {
          email: other,
          handle: "loopprev",
          previous: { requestId: current.body.requestId, retireSecret: current.body.retireSecret },
        },
        ip(50 + n),
      );
    }
    expect(linksTo(h.recorded(), other)).toHaveLength(MAX);
  });

  it("always mails the mailbox's first begin of a fresh hour", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const h = harness();
    for (let n = 0; n <= MAX; n++) {
      await beginThroughRoutes(
        h.app,
        { email: `fresh+${n}@x.example`, handle: `fresh${n}` },
        ip(n),
      );
    }
    const late = "fresh+late@x.example";
    await beginThroughRoutes(h.app, { email: late, handle: "freshlate" }, ip(100));
    expect(linksTo(h.recorded(), late)).toHaveLength(0);

    vi.setSystemTime(Date.now() + 61 * MINUTE);
    const next = "fresh+next@x.example";
    await begun(h, next, "freshnext");
    expect(linksTo(h.recorded(), next)).toHaveLength(1);
  });
});
