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
import { Layer } from "effect";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  EMAIL_LINK_PAIRING_CANDIDATES,
  MAX_OTP_ATTEMPTS,
  REGISTRATION_LINK_LOCKOUT_THRESHOLD,
} from "../../src/services/auth/constants";
import { makeTestAuthConfig } from "../helpers/auth-config";
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
  const app = createAuthRoutes(config, Layer.merge(createTestLayer(), mail.layer));
  return { app, recorded: () => mail.recorded() };
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
    expect(await poll.json()).toEqual({ status: "pending" });
  });
});

describe("wrong secrets", () => {
  it(`wipes the request at the ${MAX_OTP_ATTEMPTS}th; the next, even right, answers as unknown`, async () => {
    const h = harness();
    const s = await begun(h, "wipe@example.com", "wipe");

    for (let n = 0; n < MAX_OTP_ATTEMPTS; n++) {
      const res = await confirmThroughRoutes(h.app, s.requestId, WRONG_SECRET, s.pairingCode);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: "expired" });
    }
    const sixth = await confirmThroughRoutes(h.app, s.requestId, s.link.linkSecret, s.pairingCode);
    expect(await sixth.json()).toEqual({ status: "expired" });

    const poll = await statusThroughRoutes(h.app, s.requestId, s.claimSecret);
    expect(await poll.json()).toEqual({ status: "expired" });

    // The wipe freed the address: a new begin mails a new link that works.
    const again = await begun(h, "wipe@example.com", "wipe");
    expect(again.link.requestId).not.toBe(s.requestId);
    expect(
      await (
        await confirmThroughRoutes(
          h.app,
          again.link.requestId,
          again.link.linkSecret,
          again.pairingCode,
        )
      ).json(),
    ).toEqual({ status: "confirmed" });
    expect((await statusThroughRoutes(h.app, again.requestId, again.claimSecret)).status).toBe(201);
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
    expect(await takenPoll.json()).toEqual(await freePoll.json());

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
        free: { status: a.status, body: await a.json() },
        taken: { status: b.status, body: await b.json() },
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
    expect(atStart.free.body).toEqual({ status: "pending" });
    expect(midway.free.body).toEqual({ status: "pending" });
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

  it("mails one address no more than six links an hour, across requests", async () => {
    const h = harness();
    const email = "address-cap@example.com";
    let current = await beginThroughRoutes(h.app, { email, handle: "addrcap" });
    for (let round = 0; round < 2; round++) {
      await resendThroughRoutes(h.app, current.body.requestId, current.body.claimSecret);
      await resendThroughRoutes(h.app, current.body.requestId, current.body.claimSecret);
      current = await beginThroughRoutes(h.app, {
        email,
        handle: "addrcap",
        previous: { requestId: current.body.requestId, claimSecret: current.body.claimSecret },
      });
    }
    // Two rounds of three links, then a seventh begin: six mailed, not seven.
    expect(current.res.status).toBe(200);
    expect(linksTo(h.recorded(), email)).toHaveLength(6);
  });
});

describe("previous on begin", () => {
  it("retires the earlier request only for the holder of its claim secret", async () => {
    const h = harness();
    const email = "previous@example.com";
    const first = await begun(h, email, "previous");

    const forged = await beginThroughRoutes(h.app, {
      email,
      handle: "previous",
      previous: { requestId: first.requestId, claimSecret: WRONG_SECRET },
    });
    expect(forged.res.status).toBe(200);
    expect(linksTo(h.recorded(), email)).toHaveLength(1);

    const owned = await beginThroughRoutes(h.app, {
      email,
      handle: "previous2",
      previous: { requestId: first.requestId, claimSecret: first.claimSecret },
    });
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
    expect([...list].sort((a, b) => Number(a) - Number(b))).toEqual(list);
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
    expect(await (await statusThroughRoutes(h.app, s.requestId, s.claimSecret)).json()).toEqual({
      status: "expired",
    });

    // The address is free again at once.
    const again = await begun(h, email, "wrongpick");
    expect(again.requestId).not.toBe(s.requestId);
  });

  it("ends the request when the reader says the number is not among the candidates", async () => {
    const h = harness();
    const s = await begun(h, "decline@example.com", "decline");
    const res = await confirmThroughRoutes(h.app, s.requestId, s.link.linkSecret, "none");
    expect(await res.json()).toEqual({ status: "expired" });
    const right = await confirmThroughRoutes(h.app, s.requestId, s.link.linkSecret, s.pairingCode);
    expect(await right.json()).toEqual({ status: "expired" });
  });

  it("ends an already-confirmed request when another number is picked, and no account is made", async () => {
    const h = harness();
    const s = await begun(h, "late-wrong@example.com", "latewrong");
    const wrong = await wrongPickFor(h, s);
    await confirmThroughRoutes(h.app, s.requestId, s.link.linkSecret, s.pairingCode);

    const res = await confirmThroughRoutes(h.app, s.requestId, s.link.linkSecret, wrong);
    expect(await res.json()).toEqual({ status: "expired" });
    expect(await (await statusThroughRoutes(h.app, s.requestId, s.claimSecret)).json()).toEqual({
      status: "expired",
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
      status: "expired",
    });
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
    });
  });

  it(`stops links to an address after ${REGISTRATION_LINK_LOCKOUT_THRESHOLD} wrong picks or declines`, async () => {
    const h = harness();
    const email = "strikes@example.com";
    for (let n = 0; n < REGISTRATION_LINK_LOCKOUT_THRESHOLD; n++) {
      const s = await begun(h, email, "strikes");
      await confirmThroughRoutes(h.app, s.requestId, s.link.linkSecret, "none");
    }
    const mailed = linksTo(h.recorded(), email).length;
    const after = await beginThroughRoutes(h.app, { email, handle: "strikes" });
    expect(after.res.status).toBe(200);
    expect(linksTo(h.recorded(), email)).toHaveLength(mailed);
  });
});

describe("the candidates read", () => {
  it("answers as unknown without the link's secret, and five wrong secrets wipe the request", async () => {
    const h = harness();
    const s = await begun(h, "read-wrong@example.com", "readwrong");
    for (let n = 0; n < MAX_OTP_ATTEMPTS; n++) {
      const res = await candidatesThroughRoutes(h.app, s.requestId, WRONG_SECRET);
      expect(await res.json()).toEqual({ status: "expired" });
    }
    const right = await candidatesThroughRoutes(h.app, s.requestId, s.link.linkSecret);
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
