import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { appSpecs } from "../src/stack";

// Flows wait on what the page shows or the network returns, never on time: a
// fixed sleep is a flake on a slow runner and dead time on a fast one, and
// `networkidle` never settles on a dev server holding an HMR socket open.
const FORBIDDEN = [/waitForTimeout\(/, /\bsetTimeout\(/, /networkidle/, /\.only\(/];

const dirs = [join(import.meta.dirname, "flows"), join(import.meta.dirname, "support")];

// The run against Stripe's test mode runs its one flow alone, so its sign-in
// and claim spend no window the suite's flows share and are not counted below;
// it still waits on state.
const testModeDir = join(import.meta.dirname, "stripe-test-mode");

describe("flow sources", () => {
  for (const dir of [...dirs, testModeDir]) {
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
  // guests' window while being counted in the organiser's. A flow that calls
  // `throughKeyOnlyCireApi` sends every cire-api request to the stack's second
  // cire-api, whose windows are its own, and counts there, presses and links
  // alike. The two routes do not chain, so no source calls both.
  //
  // The press is counted in any letter case: Playwright matches a role's name
  // without regard to case, so `name: "Open Invitation"` presses the same
  // button and spends the same claim. A link is counted only as the literal
  // text, so a flow writes it out rather than building it with `searchParams`.
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
    // A call, not the helper's own definition in the fixtures.
    const calls = (source: string, helper: string) =>
      new RegExp(`(?<!function )${helper}\\(`).test(source);
    const fromOrganiser = (source: string) => calls(source, "claimFromOrganiserAddress");
    const toKeyOnly = (source: string) => calls(source, "throughKeyOnlyCireApi");

    for (const source of sources) expect(fromOrganiser(source) && toKeyOnly(source)).toBe(false);
    const claims = (group: string[]) =>
      group.reduce((sum, source) => sum + count(source, press) + count(source, link), 0);

    const guests = claims(sources.filter((source) => !fromOrganiser(source) && !toKeyOnly(source)));
    const organiser = sources.filter(fromOrganiser);
    for (const source of organiser) expect(count(source, press)).toBe(0);
    const keyOnly = claims(sources.filter(toKeyOnly));

    expect(guests).toBeGreaterThan(0);
    expect(guests).toBeLessThanOrEqual(5);
    expect(claims(organiser)).toBeLessThanOrEqual(5);
    expect(keyOnly).toBeGreaterThan(0);
    expect(keyOnly).toBeLessThanOrEqual(5);
  });

  // An organiser flow signs in with `signInToCireHost`, or itself through
  // osn-api's `/dev/login?…` as `cire-event-details` does. Either way a sign-in
  // spends two of cire-api's OIDC redirect legs (15 a minute per address,
  // `defaultOidcStartLimiter` in cire/api/src/app.ts), one osn-api `/dev/login`
  // (10 a minute, osn/api/src/routes/auth/dev-login.ts) and one osn-api
  // `/authorize` (20 a minute, `oidcAuthorize` in
  // osn/api/src/routes/auth/limiters.ts). A Pulse sign-in, `signInToPulse`,
  // spends one `/authorize` too. A Musubi sign-in as the dev profile,
  // `signInToMusubiAsDev` or `signInToMusubiAsDevWithoutApp`, spends one
  // `/dev/login` and nothing else. All of it
  // from the suite's one address, in fixed windows, so a sign-in past the
  // budget fails only on a fast machine. Seven organiser sign-ins, two Musubi
  // ones and two Pulse ones keep every window with room: 14 of the 15 redirect
  // legs, 9 of the 10 dev logins, 9 of the 20 authorizes. A flow that starts an
  // app's sign-in itself through `routeOidcLegsFrom`, as
  // `musubi-account-deletion` does, sends cire-api's legs and the `/authorize`
  // they lead to from its own address, and checks that each leg went so; it
  // spends none of these windows. pulse-api keys its own legs (`authStart`,
  // 20 a minute) on the socket, so a Pulse start made that way still spends
  // the suite's Pulse window, which this test does not count.
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
    const musubiDevSignIns = count(/(?<!function )signInToMusubiAsDev(?:WithoutApp)?\(/g);
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
  // the link's page, right or wrong, or "I didn't ask for this" there, written
  // exactly as the patterns below; `registerThroughApi` does one begin and one
  // confirm. A recovery or step-up link's confirm, typing the number, and an
  // email change's, picking it, spend the same confirm budget.
  //
  // A flow that calls `throughEmailVerificationApi` sends its osn-api calls to
  // the stack's second osn-api, whose windows are its own, so its begins are
  // counted against that one's five and not the first's.
  const flowSources = () =>
    readdirSync(join(import.meta.dirname, "flows")).map((file) =>
      readFileSync(join(import.meta.dirname, "flows", file), "utf8"),
    );
  const toSecondApi = (source: string) => /throughEmailVerificationApi\(/.test(source);
  const countIn = (pattern: RegExp, second = false): number =>
    flowSources()
      .filter((source) => toSecondApi(source) === second)
      .reduce((sum, source) => sum + (source.match(pattern)?.length ?? 0), 0);
  const BEGINS = /name: "Send verification link" \}\)\.click\(|registerThroughApi\(/g;

  test("the flows begin no more sign-ups than osn-api allows in a minute", () => {
    const begins = countIn(BEGINS);
    expect(begins).toBeGreaterThan(0);
    expect(begins).toBeLessThanOrEqual(5);
  });

  test("the flows routed to the second osn-api begin no more sign-ups than it allows in a minute", () => {
    const begins = countIn(BEGINS, true);
    expect(begins).toBeGreaterThan(0);
    expect(begins).toBeLessThanOrEqual(5);
  });

  test("the flows resend and confirm no more links than osn-api allows in a minute", () => {
    const resends = countIn(/name: "Resend link" \}\)\.click\(/g);
    const confirms = countIn(
      /confirmLinkOnPage\(|pickWrongNumberOnPage\(|declineLinkOnPage\(|typeNumberOnPage\(|registerThroughApi\(/g,
    );
    expect(resends).toBeLessThanOrEqual(5);
    expect(confirms).toBeGreaterThan(0);
    expect(confirms).toBeLessThanOrEqual(10);
  });

  // osn-api sends one account at most three recovery links a day from one
  // client address, first links and Resends together (`recoveryLinkAddressCap`,
  // osn/api/src/routes/auth/limiters.ts), and takes five recovery begins an
  // hour per address (`recoveryEmailBegin`). The whole run asks from one
  // address, so a fourth link is held back without an error: the begin still
  // answers 202 and the flow waits for mail that never comes. A flow asks for
  // a recovery link with "Send the link" and resends with "Resend link";
  // `musubi-recovery` presses the first through its `askForLink` helper, so
  // there each call of the helper is the press that counts. A recovery flow is
  // one that presses "Send the link", the recovery begin's own words: the
  // step-up sheet's "Email me a link" shares the recovery chooser's, so it
  // cannot tell the two apart.
  test("the flows send no more recovery links than osn-api allows one account a day", () => {
    const recovery = readdirSync(join(import.meta.dirname, "flows"))
      .map((file) => readFileSync(join(import.meta.dirname, "flows", file), "utf8"))
      .filter((source) => source.includes('name: "Send the link"'));
    const count = (source: string, pattern: RegExp) => source.match(pattern)?.length ?? 0;
    const begins = recovery.reduce(
      (sum, source) =>
        sum +
        count(source, /name: "Send the link" \}\)\.click\(/g) *
          (source.includes("askForLink(") ? 0 : 1) +
        count(source, /askForLink\("/g),
      0,
    );
    const resends = recovery.reduce(
      (sum, source) => sum + count(source, /name: "Resend link" \}\)\.click\(/g),
      0,
    );
    expect(recovery.length).toBeGreaterThan(0);
    expect(begins).toBeGreaterThan(0);
    expect(begins + resends).toBeLessThanOrEqual(3);
  });

  // osn-api takes five step-up email begins a minute per client address
  // (`stepUpEmailBegin`, osn/api/src/routes/auth/limiters.ts), one window for
  // the whole run. A flow begins one by pressing the step-up sheet's "Email me
  // a link" (outside a recovery flow, where the same words choose recovery's
  // emailed link), or through osn-api's `/step-up/email/begin` as
  // `musubi-step-up-email` does.
  test("the flows begin no more step-up email links than osn-api allows in a minute", () => {
    const sources = readdirSync(join(import.meta.dirname, "flows")).map((file) =>
      readFileSync(join(import.meta.dirname, "flows", file), "utf8"),
    );
    const count = (source: string, pattern: RegExp) => source.match(pattern)?.length ?? 0;
    const begins = sources
      .filter((source) => !source.includes('name: "Send the link"'))
      .reduce(
        (sum, source) =>
          sum +
          count(source, /name: "Email me a link" \}\)\.click\(/g) +
          count(source, /"\/step-up\/email\/begin"/g),
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

  // `musubi-account-deletion` reaches osn-api from its own address
  // (`callOsnApiFrom`), so its sign-ins, step-ups and profile lists leave the
  // suite's windows to the other Musubi flows, which run inside one minute and
  // between them come close to `/profiles/list`'s ten. That holds only while
  // the stack's osn-api keeps the address a request sends; what keeping it
  // does is tested beside the function, in
  // osn/api/tests/lib/local-client-address.test.ts.
  test("the stack's osn-api keeps the client address a request sends", () => {
    const osnApi = appSpecs().find((spec) => spec.name === "osnApi");
    expect(osnApi?.env?.OSN_E2E_CLIENT_ADDRESS).toBe("1");
    const local = readFileSync(
      join(import.meta.dirname, "..", "..", "..", "osn", "api", "src", "local.ts"),
      "utf8",
    );
    expect(local).toContain('process.env.OSN_E2E_CLIENT_ADDRESS === "1"');
    expect(local).toContain("keepSentClientAddress(");
  });

  // `musubi-passkey` moves the page clock to a second before the step-up's
  // deadline, then past it, by its own copy of `STEP_UP_DEADLINE_MS`. With a
  // copy above the client's, Cancel comes back before the "a second before"
  // check; with one below, that check reads a moment well short of the
  // deadline and passes without testing it.
  test("musubi-passkey's step-up deadline is the client's", () => {
    const declared = (...path: string[]) =>
      readFileSync(join(import.meta.dirname, ...path), "utf8").match(
        /\bconst STEP_UP_DEADLINE_MS = ([\d_]+);/,
      )?.[1];
    const client = declared("..", "..", "..", "osn", "client", "src", "step-up.ts");
    expect(client).toBeDefined();
    expect(declared("flows", "musubi-passkey.flow.ts")).toBe(client);
  });
});
