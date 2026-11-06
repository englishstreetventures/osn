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
  // A flow claims by pressing "Open invitation", or by opening the invitation
  // at a `code=` link, which claims on load (the organiser's "Preview invite").
  // A flow that calls `claimFromOrganiserAddress` sends its claims from the
  // organiser's own address and counts in that window instead. It may claim
  // only through a link: a press in a second, unrouted context would spend the
  // guests' window while being counted in the organiser's.
  //
  // The press is counted in any letter case: Playwright matches a role's name
  // without regard to case, so `name: "Open Invitation"` presses the same
  // button and spends the same claim.
  test("the flows claim no more invitation codes than cire-api allows in a minute, per address", () => {
    // The support modules too: a flow's checks there run in its session.
    const sources = dirs.flatMap((dir) =>
      readdirSync(dir)
        .filter((file) => file.endsWith(".ts"))
        .map((file) => readFileSync(join(dir, file), "utf8")),
    );
    const count = (source: string, pattern: RegExp) => source.match(pattern)?.length ?? 0;
    const press = /name: "Open invitation" \}\)\.click\(/gi;
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
  // `/authorize` (20 a minute, `oidcAuthorize` in
  // osn/api/src/routes/auth/limiters.ts). A Pulse sign-in, `signInToPulse`,
  // spends one `/authorize` too. A Musubi sign-in as the dev profile,
  // `signInToMusubiAsDev`, spends one `/dev/login` and nothing else. All of it
  // from the suite's one address, in fixed windows, so a sign-in past the
  // budget fails only on a fast machine. Seven organiser sign-ins, one Musubi
  // one and two Pulse ones keep every window with room: 14 of the 15 redirect
  // legs, 8 of the 10 dev logins, 9 of the 20 authorizes.
  test("the flows sign an organiser in no more often than the sign-in limits allow", () => {
    // The support modules too, less the helpers' own definitions.
    const sources = dirs.flatMap((dir) =>
      readdirSync(dir)
        .filter((file) => file.endsWith(".ts"))
        .map((file) => readFileSync(join(dir, file), "utf8")),
    );
    const count = (pattern: RegExp) =>
      sources.reduce((sum, source) => sum + (source.match(pattern)?.length ?? 0), 0);
    const signIns = count(/(?<!function )signInToCireHost\(|\/dev\/login\?/g);
    const pulseSignIns = count(/(?<!function )signInToPulse\(/g);
    const musubiDevSignIns = count(/(?<!function )signInToMusubiAsDev\(/g);
    expect(signIns).toBeGreaterThan(0);
    expect(signIns).toBeLessThanOrEqual(7);
    expect(signIns + pulseSignIns).toBeLessThanOrEqual(9);
    expect(signIns + musubiDevSignIns).toBeLessThanOrEqual(9);
  });

  // osn-api allows 5 sign-up begins, 5 link Resends and 10 link confirms a
  // minute per client address (`registerBegin`, `registerResend` and
  // `emailLinkConfirm` in `AUTH_RATE_LIMITS`, osn/api/src/routes/auth/limiters.ts,
  // in-memory on this stack), each one window shared by the whole run, so one
  // more is a 429 only on a machine fast enough to fit them in one minute. A
  // flow begins a sign-up by pressing "Send verification link" in Musubi's
  // dialog, resends with "Resend link", and confirms by pressing a number on
  // the link's page, written exactly as the patterns below; `registerThroughApi`
  // does one begin and one confirm.
  const countIn = (pattern: RegExp): number =>
    readdirSync(join(import.meta.dirname, "flows"))
      .map((file) => readFileSync(join(import.meta.dirname, "flows", file), "utf8"))
      .reduce((sum, source) => sum + (source.match(pattern)?.length ?? 0), 0);

  test("the flows begin no more sign-ups than osn-api allows in a minute", () => {
    const begins = countIn(/name: "Send verification link" \}\)\.click\(|registerThroughApi\(/g);
    expect(begins).toBeGreaterThan(0);
    expect(begins).toBeLessThanOrEqual(5);
  });

  test("the flows resend and confirm no more links than osn-api allows in a minute", () => {
    const resends = countIn(/name: "Resend link" \}\)\.click\(/g);
    const confirms = countIn(/confirmLinkOnPage\(|registerThroughApi\(/g);
    expect(resends).toBeLessThanOrEqual(5);
    expect(confirms).toBeGreaterThan(0);
    expect(confirms).toBeLessThanOrEqual(10);
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
