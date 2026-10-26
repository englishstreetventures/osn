import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { appSpecs } from "../src/stack";

// Flows wait on what the page shows or the network returns, never on time: a
// fixed sleep is a flake on a slow runner and dead time on a fast one, and
// `networkidle` never settles on a dev server holding an HMR socket open.
const FORBIDDEN = [/waitForTimeout\(/, /\bsetTimeout\(/, /networkidle/, /\.only\(/];

const dirs = [join(import.meta.dirname, "flows"), join(import.meta.dirname, "support")];

describe("flow sources", () => {
  for (const dir of dirs) {
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
      test(`${file} waits on state, not time`, () => {
        const source = readFileSync(join(dir, file), "utf8");
        for (const pattern of FORBIDDEN) expect(source).not.toMatch(pattern);
      });
    }
  }

  test("every flow file is named *.flow.ts, the only files Playwright collects", () => {
    const files = readdirSync(join(import.meta.dirname, "flows"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) expect(file).toEndWith(".flow.ts");
  });

  // cire-api allows 5 claims a minute per client address (`defaultClaimLimiter`
  // in cire/api/src/app.ts), one window per address shared by the whole run. A
  // sixth claim gets 429 only when it lands inside the first one's minute,
  // which depends on how fast the machine is: a run that passes locally and
  // fails in CI, in a flow nobody touched. Counted here, so the commit that
  // adds it goes red.
  //
  // A flow claims by pressing "Open Invitation", or by opening the invitation
  // at a `code=` link, which claims on load (the organiser's "Preview invite").
  // A flow that calls `claimFromOrganiserAddress` sends its claims from the
  // organiser's own address and counts in that window instead. It may claim
  // only through a link: a press in a second, unrouted context would spend the
  // guests' window while being counted in the organiser's.
  test("the flows claim no more invitation codes than cire-api allows in a minute, per address", () => {
    const dir = join(import.meta.dirname, "flows");
    const sources = readdirSync(dir).map((file) => readFileSync(join(dir, file), "utf8"));
    const count = (source: string, pattern: RegExp) => source.match(pattern)?.length ?? 0;
    const press = /name: "Open Invitation" \}\)\.click\(/g;
    const link = /[?&]code=/g;
    const fromOrganiser = (source: string) => source.includes("claimFromOrganiserAddress(");

    const guests = sources
      .filter((source) => !fromOrganiser(source))
      .reduce((sum, source) => sum + count(source, press) + count(source, link), 0);
    const organiser = sources.filter(fromOrganiser);
    for (const source of organiser) expect(count(source, press)).toBe(0);
    const organiserClaims = organiser.reduce((sum, source) => sum + count(source, link), 0);

    expect(guests).toBeGreaterThan(0);
    expect(guests).toBeLessThanOrEqual(5);
    expect(organiserClaims).toBeLessThanOrEqual(5);
  });

  // An organiser flow signs in with `signInToCireHost`, or itself through
  // osn-api's `/dev/login?…` as `cire-event-details` does. Either way a sign-in
  // spends two of cire-api's OIDC redirect legs (15 a minute per address,
  // `defaultOidcStartLimiter` in cire/api/src/app.ts), one osn-api `/dev/login`
  // (10 a minute, osn/api/src/routes/auth/dev-login.ts) and one osn-api
  // `/authorize` (20 a minute, shared with the Pulse flow's two sign-ins). All
  // of it from the suite's one address, in fixed windows, so a sign-in past the
  // budget fails only on a fast machine. Six keeps every window with room:
  // 12 of the 15 redirect legs, 6 of the 10 dev logins, 8 of the 20 authorizes.
  test("the flows sign an organiser in no more often than the sign-in limits allow", () => {
    const dir = join(import.meta.dirname, "flows");
    const signIns = readdirSync(dir)
      .map((file) => readFileSync(join(dir, file), "utf8"))
      .reduce(
        (sum, source) => sum + (source.match(/signInToCireHost\(|\/dev\/login\?/g)?.length ?? 0),
        0,
      );
    expect(signIns).toBeGreaterThan(0);
    expect(signIns).toBeLessThanOrEqual(6);
  });

  // osn-api allows 5 sign-up begins a minute per client address
  // (`registerBegin` in osn/api/src/lib/redis-rate-limiters.ts, in-memory on
  // this stack), one window shared by the whole run, so a sixth begin is a 429
  // only on a machine fast enough to fit them in one minute. A flow begins a
  // sign-up by pressing "Send verification code" or "Resend code" in Musubi's
  // dialog, written exactly as the patterns below, or by `registerThroughApi`.
  test("the flows begin no more sign-ups than osn-api allows in a minute", () => {
    const dir = join(import.meta.dirname, "flows");
    const begins = readdirSync(dir)
      .map((file) => readFileSync(join(dir, file), "utf8"))
      .reduce(
        (sum, source) =>
          sum +
          (source.match(
            /name: "(?:Send verification code|Resend code)" \}\)\.click\(|registerThroughApi\(/g,
          )?.length ?? 0),
        0,
      );
    expect(begins).toBeGreaterThan(0);
    expect(begins).toBeLessThanOrEqual(5);
  });

  // The organiser's window exists only because the stack's cire-api keeps a
  // client address the request sends. Without that, every claim would land in
  // one window again, and fail only on a fast machine. What keeping it does is
  // tested beside the function, in cire/api/tests/lib/local-client-address.test.ts.
  test("the stack's cire-api keeps the client address a request sends", () => {
    const cireApi = appSpecs().find((spec) => spec.name === "cireApi");
    expect(cireApi?.env?.CIRE_E2E_CLIENT_ADDRESS).toBe("1");
    const local = readFileSync(
      join(import.meta.dirname, "..", "..", "..", "cire", "api", "src", "local.ts"),
      "utf8",
    );
    expect(local).toContain('process.env.CIRE_E2E_CLIENT_ADDRESS === "1"');
    expect(local).toContain("localClientAddress(");
  });
});
