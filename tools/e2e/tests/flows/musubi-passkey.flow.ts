/**
 * Musubi: create an account through the emailed link — confirmed in a second
 * browser, picking the number the first shows (a wrong pick on a first link
 * before it) — then a passkey; sign out,
 * sign back in with the passkey (a rate-limited try first), keep the session
 * across a reload, keep the shell when the profile list or a page fails to
 * load, add and remove an authenticator app behind passkey step-ups, keep the
 * session past its access token's expiry, list the connected apps (then
 * authorise Pulse through the API and revoke it there), sign the
 * page out — and say so — when the issuer refuses to renew it, sign out a
 * reload that has no cookie, sign in to Pulse through Musubi's `/authorize`,
 * then open a third-party client's consent screen and leave it undecided.
 * Signed in, before the authenticator steps, it measures and shoots Musubi's
 * base styles and the notices the shell draws (`musubi-surfaces.ts`); signed
 * out by the refused renewal, the signed-out note's Sign in; on Pulse's
 * consent screen, its first-party mark and the chosen profile's name; on the
 * third-party one, its "Third-party app" chip and its scope rows. On the way it
 * reads the shared parts the auth views draw: the create-account dialog's
 * plain field labels and the date of birth's hint, the sign-in dialog's label
 * and its standalone "Lost your passkey?" link, Continue busy while
 * `/login/passkey/begin` is held, `/authorize`'s "Create one" link inside
 * its sentence, and Discover's "Search for someone" inside its empty note. It
 * holds the register send and enrol calls, the step-up's begin, the
 * authenticator's confirm and Pulse's revoke long enough to read each busy
 * button and see the ways out beside it disabled, and reads the authenticator
 * setup's two span labels.
 *
 * The failures are made by answering one osn-api route in the page
 * (`refuse`), so no limiter or session on the stack is spent on them. Every
 * error line reads a sentence from `describeAuthError`, never the error's own
 * text.
 *
 * Musubi is served as it deploys, its Content-Security-Policy included
 * (`appSpecs` in `src/stack.ts`): the flow checks the policy it is served and
 * that no Musubi page logs a refusal under it, Turnstile's widget among them.
 * Access tokens live only in the page's memory; the flow checks that storage
 * never holds one.
 *
 * The first sign-up link is spent the wrong way: a `GET` on its routes
 * approves nothing, and a number that is not the one shown ends the request,
 * which the waiting tab learns on its own. A new link from the details, with
 * a new number, is the one confirmed, after its page's first read fails once.
 *
 * The session cookie is set by osn-api (`localhost:4000`) on responses to
 * Musubi's (`localhost:1422`) cross-origin fetches, so it only lands — and only
 * rides on later calls — when those fetches pass `credentials: "include"`.
 */

import type { Request, Response, Route } from "@playwright/test";

import { ORIGINS, PEOPLE, PULSE_OIDC, THIRD_PARTY_OIDC, TURNSTILE_ORIGIN } from "../../src/config";
import {
  addVirtualAuthenticator,
  cookieNamed,
  expect,
  confirmLinkOnPage,
  holdMethod,
  linkFor,
  mailFor,
  offeredNumbers,
  pickWrongNumberOnPage,
  test,
  totpCode,
  waitingScreenNumber,
} from "../support/fixtures";
import {
  authorizeSignInSurfaces,
  authorizeThirdPartySurfaces,
  authorizeVerifiedSurfaces,
  busyButtonHeld,
  busyButtonSurfaces,
  discoverEmptySurfaces,
  musubiNotice,
  musubiSurfaces,
  onPhone,
  otpDigitSurfaces,
  phoneTall,
  registerFieldSurfaces,
  securityLoadingSurfaces,
  signedOutSurfaces,
  signInLinkSurfaces,
  totpSetupSurfaces,
} from "../support/musubi-surfaces";

const ada = PEOPLE.musubi;

/** Where `@osn/client` keeps the stored account: never a token. */
const ACCOUNT_KEY = "@osn/client:account_session";

/** The stored account: whether a session is held, the profile the page is on and the sign-in's id, nothing else. */
const STORED_ACCOUNT =
  /^\{"hasSession":true,"activeProfileId":"usr_[a-z0-9_]+","signInId":"[0-9a-f-]{36}"\}$/;

/** A JSON Web Token, as any access or ID token osn-api issues is written. */
const JWT = /eyJ[\w-]+\.[\w-]+\./;

/**
 * The access-token lifetime osn-api issues on this stack, which sets no
 * `OSN_ACCESS_TOKEN_TTL` (`osn/api/src/build-deps.ts`).
 */
const ACCESS_TOKEN_TTL_MS = 300_000;

/**
 * The policy the build writes (`contentSecurityPolicy` in
 * `musubi/social/vite.config.ts`), with each inline-script hash written as
 * `'sha256-…'`: scripts from Musubi itself, its two inline scripts and
 * Turnstile; connections to Musubi itself and osn-api.
 */
const MUSUBI_POLICY = `frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'self'; script-src 'self' 'sha256-…' 'sha256-…' ${TURNSTILE_ORIGIN}; connect-src 'self' ${ORIGINS.osnApi}`;

/** `describeAuthError`'s sentences the flow reads (`osn/client/src/error-copy.ts`). */
const WAIT = "Too many attempts. Wait a while, then try again.";

/**
 * A route handler that answers an osn-api request with `status` and the
 * error `code` osn-api would send, as a cross-origin answer the page can read
 * (a preflight included), so the page meets the refusal and not a network
 * failure. Only `method` is refused; anything else goes on to osn-api.
 */
function refuse(method: string, status: number, code: string) {
  const cors = {
    "access-control-allow-origin": ORIGINS.musubi,
    "access-control-allow-credentials": "true",
    "access-control-allow-headers": "authorization, content-type",
    "access-control-allow-methods": method,
  };
  return (route: Route) => {
    const sent = route.request().method();
    if (sent === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    if (sent !== method) return route.fallback();
    return route.fulfill({
      status,
      headers: cors,
      contentType: "application/json",
      body: JSON.stringify({ error: code }),
    });
  };
}

// Musubi's forms load Turnstile, which the fixtures stand in for.
test.use({ turnstile: true });

test("musubi-passkey", async ({ page, context, browser, flow }) => {
  const authenticator = await addVirtualAuthenticator(page);
  // The shell's Sign in, in the rail or the top bar: a signed-out page draws
  // its own in its note as well.
  const shellSignIn = () => page.locator("aside, header").getByRole("button", { name: "Sign in" });
  // The virtual authenticator answers a conditional-UI (autofill) request on
  // its own, which a person never does: it would sign in the moment the dialog
  // opens, racing the "@handle → Continue" path this flow drives. Report
  // conditional mediation as unavailable, as on a browser without it.
  await page.addInitScript(() => {
    PublicKeyCredential.isConditionalMediationAvailable = () => Promise.resolve(false);
  });

  let servedPolicy = "";
  await flow.step("open Musubi", async () => {
    const response = await page.goto(ORIGINS.musubi);
    servedPolicy = (await response?.headerValue("content-security-policy")) ?? "";
    await expect(page.getByRole("button", { name: "Create account" }).first()).toBeVisible();
    // The page names the tab once it has rendered; the shell can land first.
    await expect(page.getByRole("heading", { level: 1, name: "Connections" })).toBeVisible();
  });
  flow.check("tab title", "Connections · Musubi", await page.title());
  flow.check(
    "Musubi is served the policy its build wrote",
    MUSUBI_POLICY,
    servedPolicy.replace(/'sha256-[A-Za-z0-9+/]+=*'/g, "'sha256-…'"),
  );

  // Every value Musubi keeps in the browser's storage, none of which may be a token.
  const storedValues = () =>
    page.evaluate(() => [...Object.values(localStorage), ...Object.values(sessionStorage)]);
  const storedAccount = () => page.evaluate((key) => localStorage.getItem(key) ?? "", ACCOUNT_KEY);

  // The narrowest phone: the signed-out top bar must hold the wordmark, the
  // theme toggle, "Sign in" and "Create account" without running off the right
  // edge.
  const viewport = page.viewportSize();
  let createAccountRight = Number.POSITIVE_INFINITY;
  await flow.step("signed-out top bar at 320px", async () => {
    await page.setViewportSize({ width: 320, height: 640 });
    const box = await page
      .getByRole("button", { name: "Create account" })
      .filter({ visible: true })
      .boundingBox();
    createAccountRight = box ? box.x + box.width : createAccountRight;
    if (viewport) await page.setViewportSize(viewport);
  });
  flow.check("Create account fits a 320px screen", true, createAccountRight <= 320);

  await flow.step("register: open the dialog", async () => {
    await page.getByRole("button", { name: "Create account" }).first().click();
    await expect(page.getByLabel("Date of birth")).toBeVisible();
  });
  await registerFieldSurfaces(flow, page);

  // Each register call below is held until its busy button has been read: the
  // button keeps focus through the wait, and the dialog's ways out wait too.
  const registerDialog = page.getByRole("dialog");
  const registerCancel = registerDialog.getByRole("button", { name: "Cancel", exact: true });
  const registerBegin = `${ORIGINS.osnApi}/register/begin`;
  const sendHeld = holdMethod("POST");
  await page.route(registerBegin, sendHeld.handler);
  try {
    await flow.step("register: details", async () => {
      await page.getByLabel("Email").fill(ada.email);
      await page.getByLabel("Handle").fill(ada.handle);
      await page.getByLabel("Date of birth").fill("1990-01-01");
      await page.getByLabel("Display name (optional)").fill(ada.name);
      await page.getByRole("button", { name: "Send verification link" }).click();
      await expect(registerDialog.getByRole("button", { name: "Sending…" })).toBeVisible();
    });
    await busyButtonHeld(
      flow,
      registerDialog.getByRole("button", { name: "Sending…" }),
      "Sending…",
      "register send busy",
    );
    flow.check("register send busy: Cancel waits", true, await registerCancel.isDisabled());
  } finally {
    sendHeld.release();
    await page.unroute(registerBegin, sendHeld.handler);
  }

  await flow.step("register: the link is sent", async () => {
    await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
  });
  const dialogAlert = page.getByRole("dialog").getByRole("alert");

  // The number the waiting screen shows, which the link's page asks for.
  const pairingCode = await flow.step("register: read the number on the waiting screen", () =>
    waitingScreenNumber(page),
  );
  flow.check("the waiting screen shows a two-digit number", true, /^\d{2}$/.test(pairingCode));

  const link = await linkFor(ada.email);
  const [verification] = await mailFor(ada.email);
  flow.check(
    "registration email subject",
    "Confirm your Musubi email",
    verification?.subject ?? "",
  );
  flow.check(
    "the email names the handle",
    true,
    verification?.text.includes(`@${ada.handle}`) ?? false,
  );
  flow.check(
    "the link opens Musubi",
    true,
    link.url.startsWith(`${ORIGINS.musubi}/verify/signup_`),
  );
  flow.check("the secret rides in the fragment", false, link.url.includes("?"));

  // A second browser: the device the email is opened on.
  const phoneContext = await browser.newContext();
  const phone = await flow.newPage(phoneContext);
  const confirms = () => flow.count("POST osn-api /email-link/:id/confirm");

  await flow.step(
    "phone: a link cut short and an unknown link are dead, and confirm nothing",
    async () => {
      await phone.goto(link.url.slice(0, link.url.indexOf("#")));
      await expect(phone.getByRole("heading", { name: "This link no longer works" })).toBeVisible();
      await phone.goto(`${ORIGINS.musubi}/verify/nothing_here`);
      await expect(phone.getByRole("heading", { name: "This link no longer works" })).toBeVisible();
    },
  );
  flow.check("no confirm sent for a dead link", 0, confirms());

  await flow.step("phone: open the link", async () => {
    await phone.goto(link.url);
    await expect(phone.getByRole("heading", { name: "Confirm this email" })).toBeVisible();
  });
  flow.check("the secret left the address bar", false, phone.url().includes("#"));
  flow.check("opening the link confirmed nothing", 0, confirms());
  flow.check(
    "the page offers the waiting screen's number",
    1,
    await phone.getByRole("button", { name: pairingCode, exact: true }).count(),
  );

  // A mail scanner fetches what it finds; no route of the link's answers a GET.
  const getStatuses = await flow.step("phone: a GET on the link's routes", async () => {
    const statuses: number[] = [];
    for (const route of ["confirm", "candidates"]) {
      const url = `${ORIGINS.osnApi}/email-link/${link.requestId}/${route}`;
      // oxlint-disable-next-line no-await-in-loop -- one request after the other
      const response = await phone.request.get(url);
      flow.recordRequest("GET", url, response.status());
      statuses.push(response.status());
    }
    return statuses;
  });
  flow.check("a GET on the confirm route is not found", 404, getStatuses[0] ?? 0);
  flow.check("a GET on the candidates route is not found", 404, getStatuses[1] ?? 0);
  flow.check("the GETs confirmed nothing", 0, confirms());
  flow.check(
    "the first browser still waits",
    true,
    await page.getByRole("heading", { name: "Check your email" }).isVisible(),
  );

  const wrong = await flow.step("phone: pick a number that is not the one shown", async () => {
    const picked = await pickWrongNumberOnPage(phone, pairingCode);
    await expect(phone.getByRole("heading", { name: "This link no longer works" })).toBeVisible();
    return picked;
  });
  flow.check("the number picked was not the one shown", true, wrong !== pairingCode);
  flow.check(
    "the wrong pick was answered",
    true,
    flow.saw("POST osn-api /email-link/:id/confirm 200"),
  );

  await flow.step("register: the first browser learns the link is gone", async () => {
    await expect(page.getByRole("heading", { name: "Your link has expired" })).toBeVisible({
      timeout: 20_000,
    });
  });
  flow.check(
    "a wrong pick made no account",
    false,
    flow.saw("POST osn-api /register/:id/status 201"),
  );

  await flow.step("register: a new link from the details", async () => {
    await page.getByRole("button", { name: "Send a new link" }).click();
    await expect(page.getByLabel("Email")).toHaveValue(ada.email);
    await expect(page.getByRole("button", { name: "Send verification link" })).toBeEnabled();
    await page.getByRole("button", { name: "Send verification link" }).click();
    await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
  });
  const secondCode = await flow.step("register: read the new number", () =>
    waitingScreenNumber(page),
  );
  flow.check("the new waiting screen shows a two-digit number", true, /^\d{2}$/.test(secondCode));

  // A reload loses the tab's page state; the stored wait brings it back, with
  // the number the poll gives again.
  await flow.step("register: a reload returns to the same wait", async () => {
    await page.reload();
    await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
  });
  // The number is drawn at random per request, so the record holds whether
  // the two match, never the number: a rerun must write the same results.
  flow.check(
    "the reloaded waiting screen shows the same number",
    true,
    (await waitingScreenNumber(page)) === secondCode,
  );
  const secondLink = await linkFor(ada.email, 1);
  flow.check("the new link is a new request", true, secondLink.requestId !== link.requestId);

  // The first candidates read fails with a 503; the page says so, and Try
  // again reads once more. The route stays installed (it passes every later
  // request on), and only the first read is refused.
  let refusedReads = 0;
  await phone.route("**/email-link/*/candidates", async (route) => {
    if (route.request().method() !== "POST" || refusedReads > 0) return route.fallback();
    refusedReads += 1;
    return route.fulfill({ status: 503, contentType: "application/json", body: "{}" });
  });
  await flow.step("phone: open the new link, and read again after a failed read", async () => {
    await phone.goto(secondLink.url);
    await expect(
      phone.getByRole("heading", { name: "We couldn't open this link just now" }),
    ).toBeVisible();
    await phone.getByRole("button", { name: "Try again" }).click();
    await expect(phone.getByRole("heading", { name: "Confirm this email" })).toBeVisible();
  });
  flow.check("the failed read was refused once", 1, refusedReads);

  await flow.step("phone: pick the number and confirm", async () => {
    await confirmLinkOnPage(phone, secondCode);
    await expect(phone.getByRole("heading", { name: "Confirmed" })).toBeVisible();
  });

  // The same link again, after the request is confirmed: a fresh page load
  // (the address differs from the open page's only by its fragment, which
  // would not reload it), one candidates read and no pick offered.
  await flow.step("phone: the same link again says Confirmed and offers no number", async () => {
    await phone.goto("about:blank");
    await phone.goto(secondLink.url);
    await expect(phone.getByRole("heading", { name: "Confirmed" })).toBeVisible();
  });
  flow.check("a confirmed link offers no number", 0, await offeredNumbers(phone).count());
  flow.check(
    "the phone is offered no Continue",
    0,
    await phone.getByRole("button", { name: "Continue" }).count(),
  );
  flow.check(
    "the phone holds no session",
    false,
    (await cookieNamed(phoneContext, ORIGINS.osnApi, "osn_session")) !== undefined,
  );

  await flow.step("register: the first browser finishes on its own", async () => {
    await expect(page.getByRole("button", { name: "Enroll credential" })).toBeVisible({
      timeout: 20_000,
    });
  });
  flow.check(
    "account created by the waiting tab",
    true,
    flow.saw("POST osn-api /register/:id/status 201"),
  );
  flow.check("sign-up begun twice", 2, flow.count("POST osn-api /register/begin "));
  flow.check(
    "the first browser holds the session cookie",
    true,
    (await cookieNamed(context, ORIGINS.osnApi, "osn_session")) !== undefined,
  );
  await phoneContext.close();

  const passkeyRegisterBegin = `${ORIGINS.osnApi}/passkey/register/begin`;
  const enrollHeld = holdMethod("POST");
  await page.route(passkeyRegisterBegin, enrollHeld.handler);
  try {
    await flow.step("register: enroll passkey waits on begin", async () => {
      await page.getByRole("button", { name: "Enroll credential" }).click();
      await expect(registerDialog.getByRole("button", { name: "Setting up…" })).toBeVisible();
    });
    await busyButtonHeld(
      flow,
      registerDialog.getByRole("button", { name: "Setting up…" }),
      "Setting up…",
      "register enroll busy",
    );
    flow.check("register enroll busy: Cancel waits", true, await registerCancel.isDisabled());
  } finally {
    enrollHeld.release();
    await page.unroute(passkeyRegisterBegin, enrollHeld.handler);
  }
  await flow.step("register: enroll passkey", async () => {
    await expect(page.getByRole("button", { name: `@${ada.handle}` })).toBeVisible();
  });

  const notices = await mailFor(ada.email, (m) => m.subject.startsWith("A passkey was added"));
  flow.check(
    "passkey-added notice subject",
    "A passkey was added to your Musubi account",
    notices.find((m) => m.subject.startsWith("A passkey was added"))?.subject ?? "",
  );

  const credentials = await authenticator.credentials();
  flow.check("authenticator holds one passkey", 1, credentials.length);
  flow.check("passkey RP ID", "localhost", credentials[0]?.rpId ?? "");

  await flow.step("sign out", async () => {
    await page.getByRole("button", { name: `@${ada.handle}` }).click();
    await page.getByRole("menuitem", { name: "Log out" }).click();
    await expect(shellSignIn()).toBeVisible();
  });
  flow.check(
    "session cookie cleared on sign-out",
    false,
    (await cookieNamed(context, ORIGINS.osnApi, "osn_session")) !== undefined,
  );

  const passkeyBegin = `${ORIGINS.osnApi}/login/passkey/begin`;
  const identifierField = page.getByLabel("Email or @handle");
  let rateLimitedLine = "";
  let describedByLine = false;
  await flow.step("sign in: open the dialog", async () => {
    await shellSignIn().click();
    await expect(identifierField).toBeVisible();
  });
  await signInLinkSurfaces(flow, page);

  await flow.step("sign in: a rate-limited try says to wait", async () => {
    const handler = refuse("POST", 429, "rate_limited");
    await page.route(passkeyBegin, handler);
    try {
      await identifierField.fill(`@${ada.handle}`);
      await page.getByRole("button", { name: "Continue" }).click();
      await expect(dialogAlert).toContainText(WAIT);
      // Read with the field, not only announced when it appears.
      await expect(identifierField).toHaveAccessibleDescription(
        `Error: ${WAIT} Lost your passkey?`,
      );
      rateLimitedLine = (await dialogAlert.textContent()) ?? "";
      const lineId = (await dialogAlert.getAttribute("id")) ?? "";
      describedByLine =
        lineId !== "" &&
        ((await identifierField.getAttribute("aria-describedby")) ?? "")
          .split(" ")
          .includes(lineId);
    } finally {
      await page.unroute(passkeyBegin, handler);
    }
  });
  flow.check(
    "a rate-limited sign-in reads the wait sentence, beside the way out",
    `Error: ${WAIT} Lost your passkey?`,
    rateLimitedLine,
  );
  flow.check("the line is the field's description", true, describedByLine);
  flow.check(
    "the way out is a button inside the line",
    1,
    await dialogAlert.getByRole("button", { name: "Lost your passkey?" }).count(),
  );
  flow.check("no toast repeats the error", 0, await page.locator("[data-sonner-toast]").count());

  // Begin is held until the busy button has been read and shot, then goes on
  // to osn-api; the preflight is never held.
  let releaseBegin = () => {};
  const beginHeld = new Promise<void>((resolve) => (releaseBegin = resolve));
  const holdBegin = async (route: Route) => {
    if (route.request().method() === "POST") await beginHeld;
    await route.fallback();
  };
  const verifying = page.getByRole("dialog").getByRole("button", { name: "Verifying…" });
  await page.route(passkeyBegin, holdBegin);
  try {
    await flow.step("sign in with passkey: Continue waits on begin", async () => {
      // The refused try spent the verification token; the widget hands the
      // form a fresh one before Continue works again.
      await page.getByRole("button", { name: "Continue" }).click();
      await expect(verifying).toBeVisible();
    });
    await busyButtonSurfaces(flow, page, verifying, "Verifying…");
  } finally {
    releaseBegin();
    await page.unroute(passkeyBegin, holdBegin);
  }
  await flow.step("sign in with passkey", async () => {
    await expect(page.getByRole("button", { name: `@${ada.handle}` })).toBeVisible();
  });

  const cookie = await cookieNamed(context, ORIGINS.osnApi, "osn_session");
  flow.check("osn_session cookie set by osn-api", true, cookie !== undefined);
  flow.check("osn_session is HttpOnly", true, cookie?.httpOnly ?? false);
  flow.check("osn_session is SameSite=Lax", "Lax", cookie?.sameSite ?? "");
  flow.check(
    "signed in, no stored value holds a token",
    false,
    (await storedValues()).some((v) => JWT.test(v)),
  );
  flow.check(
    "the stored account is its two fields",
    true,
    STORED_ACCOUNT.test(await storedAccount()),
  );

  const grantsBeforeReload = flow.count("POST osn-api /token 200");
  await flow.step("reload restores the session from the cookie alone", async () => {
    // The stored account holds no token, so the only way back to a session is
    // the HttpOnly cookie riding on a credentialed `POST /token`.
    await page.reload();
    await expect(page.getByRole("button", { name: `@${ada.handle}` })).toBeVisible();
  });
  flow.check(
    "one POST /token restores the session",
    1,
    flow.count("POST osn-api /token 200") - grantsBeforeReload,
  );

  // Signed in, after the check above has read the request log: the surfaces
  // reload the page for the legal routes, and each reload posts to /token.
  await musubiSurfaces(flow, page, ada.name);

  const nav = page.getByRole("link", { name: "Settings" }).first();
  const profilesList = `${ORIGINS.osnApi}/profiles/list`;
  const profilesNotice = page.getByRole("alert").filter({ hasText: "Your profiles didn't load." });
  await flow.step("a failed profile list keeps the shell", async () => {
    const handler = refuse("GET", 500, "internal_error");
    await page.route(profilesList, handler);
    try {
      await page.reload();
      await expect(profilesNotice).toBeVisible();
      await expect(nav).toBeVisible();
    } finally {
      await page.unroute(profilesList, handler);
    }
  });
  flow.check(
    "the failed list says so, and nothing more for a 500",
    "Error: Your profiles didn't load. Try again",
    (await profilesNotice.textContent()) ?? "",
  );
  await musubiNotice(flow, page, "profiles-failed", profilesNotice, "--ui-danger");
  let rateLimitedList = "";
  await flow.step("a rate-limited retry of the profile list says to wait", async () => {
    const handler = refuse("GET", 429, "rate_limited");
    await page.route(profilesList, handler);
    try {
      await profilesNotice.getByRole("button", { name: "Try again" }).click();
      await expect(profilesNotice).toContainText(WAIT);
      // Try again is back once the retry has settled.
      await expect(profilesNotice.getByRole("button", { name: "Try again" })).toBeVisible();
      rateLimitedList = (await profilesNotice.textContent()) ?? "";
    } finally {
      await page.unroute(profilesList, handler);
    }
  });
  flow.check(
    "a rate-limited list names the wait",
    `Error: Your profiles didn't load. ${WAIT} Try again`,
    rateLimitedList,
  );
  const listsBeforeRetry = flow.count("GET osn-api /profiles/list 200");
  await flow.step("the profile list's Try again lists again", async () => {
    await profilesNotice.getByRole("button", { name: "Try again" }).click();
    await expect(profilesNotice).toHaveCount(0);
  });
  flow.check(
    "Try again sent one list",
    1,
    flow.count("GET osn-api /profiles/list 200") - listsBeforeRetry,
  );

  // `ConnectionsPage` reads its list without catching, so a failed list
  // throws while the page renders: the case the shell's boundary is for.
  const connectionsList = `${ORIGINS.osnApi}/graph/connections`;
  const pageNotice = page.getByRole("alert").filter({ hasText: "This page didn't load." });
  const connectionsLink = page.getByRole("link", { name: "Connections" }).first();
  let pageLine = "";
  await flow.step("a failed page keeps the shell, and the nav leaves it", async () => {
    const handler = refuse("GET", 500, "internal_error");
    await page.route(connectionsList, handler);
    try {
      await connectionsLink.click();
      await expect(pageNotice).toBeVisible();
      await expect(nav).toBeVisible();
      pageLine = (await pageNotice.textContent()) ?? "";
      await musubiNotice(flow, page, "page-failed", pageNotice, "--ui-danger");
      await nav.click();
      await expect(page.getByText("Handles cannot be changed.", { exact: true })).toBeVisible();
      await connectionsLink.click();
      await expect(pageNotice).toBeVisible();
    } finally {
      await page.unroute(connectionsList, handler);
    }
    await pageNotice.getByRole("button", { name: "Try again" }).click();
    await expect(pageNotice).toHaveCount(0);
    await expect(page.getByRole("navigation", { name: "Connection filters" })).toBeVisible();
  });
  flow.check(
    "the failed page says so in its own words, with Try again",
    "Error: This page didn't load. Try again",
    pageLine,
  );

  // A new account shares no organisation and has no connection, so Discover
  // has nothing to suggest and points at search.
  await flow.step("Discover with nothing to suggest", async () => {
    await page.getByRole("link", { name: "Discover" }).first().click();
    await expect(page.getByText("No suggestions yet.", { exact: false })).toBeVisible();
  });
  await discoverEmptySurfaces(flow, page);

  const settingsTab = (name: string) =>
    page
      .getByRole("navigation", { name: "Settings sections" })
      .getByRole("button", { name, exact: true });

  // The passkey list's read, held: the list's own placeholder is on screen in
  // its place, not Settings' fallback for the whole tab.
  const passkeysList = `${ORIGINS.osnApi}/passkeys`;
  const listHeld = holdMethod("GET");
  let placeholderHeight = "";
  await page.route(passkeysList, listHeld.handler);
  try {
    await flow.step("Settings → Security while the passkey list loads", async () => {
      await page.getByRole("link", { name: "Settings" }).first().click();
      await settingsTab("Security").click();
      await expect(page.getByRole("heading", { name: "Passkeys", exact: true })).toBeVisible();
    });
    placeholderHeight = await securityLoadingSurfaces(flow, page);
  } finally {
    listHeld.release();
    await page.unroute(passkeysList, listHeld.handler);
  }
  let rowHeight = "";
  await flow.step("Settings → Security once the passkey list lands", async () => {
    await expect(page.getByRole("button", { name: "Rename" })).toBeVisible();
    rowHeight = await page
      .locator("li")
      .filter({ has: page.getByRole("button", { name: "Rename" }) })
      .evaluate((el) => getComputedStyle(el).height);
  });
  // Nothing below the list moves when it lands.
  flow.check("a passkey row is as tall as its loading placeholder", placeholderHeight, rowHeight);

  // Each step-up below is a passkey assertion the virtual authenticator
  // answers. The code is computed from the setup key the page shows, on the
  // suite clock the servers run on.
  // The step-up's begin and the enrolment's confirm are each held until the
  // button that started them has been read.
  const stepUpBegin = `${ORIGINS.osnApi}/step-up/passkey/begin`;
  const stepUpHeld = holdMethod("POST");
  const stepUpCancel = page.getByRole("button", { name: "Cancel", exact: true });
  await page.route(stepUpBegin, stepUpHeld.handler);
  try {
    await flow.step("add an authenticator app: the step-up waits on begin", async () => {
      await page.getByRole("link", { name: "Settings" }).first().click();
      await settingsTab("Security").click();
      await page.getByRole("button", { name: "Add an authenticator app" }).click();
      await page.getByRole("button", { name: "Use passkey" }).click();
      await expect(page.getByRole("button", { name: "Waiting for your passkey…" })).toBeVisible();
    });
    await busyButtonHeld(
      flow,
      page.getByRole("button", { name: "Waiting for your passkey…" }),
      "Waiting for your passkey…",
      "step-up passkey busy",
    );
    flow.check("step-up passkey busy: Cancel waits", true, await stepUpCancel.isDisabled());
  } finally {
    stepUpHeld.release();
    await page.unroute(stepUpBegin, stepUpHeld.handler);
  }
  let secret = "";
  await flow.step("add an authenticator app: the setup key", async () => {
    secret = (await page.getByLabel("Or enter this setup key by hand").textContent()) ?? "";
  });
  await totpSetupSurfaces(flow, page);
  await otpDigitSurfaces(
    flow,
    page,
    page.getByRole("textbox", { name: "Code from the app Digit 1" }),
  );
  const totpConfirm = `${ORIGINS.osnApi}/totp/enroll/complete`;
  const confirmHeld = holdMethod("POST");
  await page.route(totpConfirm, confirmHeld.handler);
  try {
    await flow.step("add an authenticator app: Confirm waits on the check", async () => {
      // Named after the label above the boxes, so Playwright's `getByLabel`
      // does not find it by its own "Digit 1".
      await page
        .getByRole("textbox", { name: "Code from the app Digit 1" })
        .pressSequentially(totpCode(secret));
      await page.getByRole("button", { name: "Confirm" }).click();
      await expect(page.getByRole("button", { name: "Checking…" })).toBeVisible();
    });
    await busyButtonHeld(
      flow,
      page.getByRole("button", { name: "Checking…" }),
      "Checking…",
      "totp confirm busy",
    );
    flow.check("totp confirm busy: Cancel waits", true, await stepUpCancel.isDisabled());
  } finally {
    confirmHeld.release();
    await page.unroute(totpConfirm, confirmHeld.handler);
  }
  await flow.step("add an authenticator app", async () => {
    await expect(page.getByRole("button", { name: "Remove" })).toBeVisible();
  });
  flow.check(
    "the authenticator app was enrolled",
    true,
    flow.saw("POST osn-api /totp/enroll/complete 200"),
  );

  await flow.step("remove the authenticator app", async () => {
    page.once("dialog", (dialog) => void dialog.accept());
    await page.getByRole("button", { name: "Remove" }).click();
    await page.getByRole("button", { name: "Use passkey" }).click();
    await expect(page.getByRole("button", { name: "Add an authenticator app" })).toBeVisible();
    // Leave the Security tab, so the next step's visit mounts its views again.
    await settingsTab("Profile").click();
  });
  flow.check("the authenticator app was removed", true, flow.saw("DELETE osn-api /totp 200"));
  flow.check(
    "each step-up passed with the passkey",
    2,
    flow.count("POST osn-api /step-up/passkey/complete 200"),
  );

  // From here the page's clock runs ahead of the servers'. osn-api still takes
  // the old access token, so only the client can know it is stale. Each step
  // moves the page past its token's expiry and opens the Security tab, whose
  // three views each make an authenticated GET. The checks are counts and
  // sets, never request order across the three, which varies by run.
  const SECURITY_GETS = ["/passkeys", "/totp/status", "/recovery/status"];
  const securityGets = (suffix = "") =>
    SECURITY_GETS.map((path) => flow.count(`GET osn-api ${path}${suffix}`));
  const sum = (counts: number[]) => counts.reduce((a, b) => a + b, 0);
  // The token lives only in the page's memory, so its expiry cannot be read;
  // any token the page holds was issued at or before the page's now.
  const pastExpiry = () => page.clock.fastForward(ACCESS_TOKEN_TTL_MS + 60_000);
  const grantsBefore = flow.count("POST osn-api /token 200");
  const okBefore = securityGets(" 200");
  const refusedGetsBefore = sum(securityGets(" 401"));
  // Whether the grant answered before any of the three GETs left the page.
  const seen: string[] = [];
  const onRequest = (request: Request) => {
    const url = new URL(request.url());
    if (url.origin === ORIGINS.osnApi && SECURITY_GETS.includes(url.pathname)) seen.push("get");
  };
  const onResponse = (response: Response) => {
    const url = new URL(response.url());
    if (url.origin === ORIGINS.osnApi && url.pathname === "/token") seen.push("grant");
  };
  await flow.step("the session outlives its access token", async () => {
    page.on("request", onRequest);
    page.on("response", onResponse);
    await pastExpiry();
    await page.getByRole("link", { name: "Settings" }).first().click();
    await settingsTab("Security").click();
    await expect(page.getByRole("button", { name: "Rename" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Recovery codes" })).toBeVisible();
    page.off("request", onRequest);
    page.off("response", onResponse);
  });
  flow.check(
    "one grant renews the stale token",
    1,
    flow.count("POST osn-api /token 200") - grantsBefore,
  );
  flow.check(
    "each Security GET answered 200",
    true,
    securityGets(" 200").every((n, i) => n > okBefore[i]!),
  );
  flow.check("no Security GET refused", 0, sum(securityGets(" 401")) - refusedGetsBefore);
  flow.check("the grant answered before any GET left", "grant", seen[0] ?? "");

  await flow.step("list the connected apps", async () => {
    await settingsTab("Connected apps").click();
    await expect(
      page.getByText("You haven't connected any apps to your Musubi account yet."),
    ).toBeVisible();
  });
  flow.check(
    "connected apps listed through authFetch",
    true,
    flow.saw("GET osn-api /oidc/connections 200"),
  );
  // What the page stores while signed in, kept for the no-cookie reload below.
  const signedInAccount = await storedAccount();
  flow.check(
    "renewed, no stored value holds a token",
    false,
    (await storedValues()).some((v) => JWT.test(v)),
  );
  flow.check("still the stored account's three fields", true, STORED_ACCOUNT.test(signedInAccount));

  // Pulse is first-party, so a signed-in `/authorize` records its consent and
  // answers with a code, no screen shown. It is asked from the browser's cookie
  // jar rather than the page, so no page load lists profiles again (the budget
  // at the end), and the code is never redeemed. Connected apps then lists
  // Pulse, and the revoke's DELETE is held until Revoke has been read busy at
  // the phone width.
  await flow.step("authorise Pulse through the API", async () => {
    const request = new URLSearchParams({
      client_id: PULSE_OIDC.clientId,
      redirect_uri: PULSE_OIDC.redirectUri,
      response_type: "code",
      scope: "openid profile",
      state: "e2e-revoke",
      nonce: "e2e-revoke",
      // RFC 7636's example challenge, as the third-party request below.
      code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
      code_challenge_method: "S256",
    });
    const url = `${ORIGINS.osnApi}/authorize?${request}`;
    const response = await context.request.get(url, { maxRedirects: 0 });
    flow.recordRequest("GET", url, response.status());
    const location = response.headers()["location"] ?? "";
    expect(location.startsWith(`${PULSE_OIDC.redirectUri}?`), location).toBe(true);
    expect(new URL(location).searchParams.has("code"), location).toBe(true);
  });
  await flow.step("Connected apps lists Pulse", async () => {
    await settingsTab("Profile").click();
    await settingsTab("Connected apps").click();
    await expect(page.getByText("Pulse", { exact: true })).toBeVisible();
  });
  const pulseConnection = `${ORIGINS.osnApi}/oidc/connections/${PULSE_OIDC.clientId}`;
  const appsList = `${ORIGINS.osnApi}/oidc/connections`;
  const revokeHeld = holdMethod("DELETE");
  const rereadHeld = holdMethod("GET");
  await page.route(pulseConnection, revokeHeld.handler);
  await page.route(appsList, rereadHeld.handler);
  try {
    await onPhone(page, async () => {
      await phoneTall(flow, page.getByRole("button", { name: "Revoke" }), "revoke");
      await flow.step("revoke Pulse: Revoke waits on the DELETE", async () => {
        await page.getByRole("button", { name: "Revoke" }).click();
        await expect(page.getByRole("button", { name: "Revoking…" })).toBeVisible();
      });
      const revoking = page.getByRole("button", { name: "Revoking…" });
      await busyButtonHeld(flow, revoking, "Revoking…", "revoke busy");
      await phoneTall(flow, revoking, "revoke busy");
      // The DELETE lands and the list is read again: the row stays, its
      // Revoke still busy, and no placeholder takes its place.
      await flow.step("revoke Pulse: the row stays while the list is read again", async () => {
        const reread = page.waitForRequest(
          (request) => request.url() === appsList && request.method() === "GET",
        );
        revokeHeld.release();
        await reread;
        await expect(revoking).toBeVisible();
      });
      flow.check(
        "revoke Pulse: no placeholder while the list is read again",
        0,
        await page
          .getByText(/^Apps you have signed in to/)
          .locator("..")
          .locator('div[aria-hidden="true"]')
          .count(),
      );
    });
  } finally {
    revokeHeld.release();
    rereadHeld.release();
    await page.unroute(pulseConnection, revokeHeld.handler);
    await page.unroute(appsList, rereadHeld.handler);
  }
  await flow.step("revoke Pulse", async () => {
    await expect(
      page.getByText("You haven't connected any apps to your Musubi account yet."),
    ).toBeVisible();
  });
  flow.check(
    "one revoke sent for Pulse",
    1,
    flow.count(`DELETE osn-api /oidc/connections/${PULSE_OIDC.clientId} `),
  );

  const refusedGrantsBefore = flow.count("POST osn-api /token 400");
  const sentBefore = sum(securityGets());
  const signedOutNotice = page.getByRole("alert").filter({ hasText: "You've been signed out." });
  await flow.step("a refused refresh signs the page out", async () => {
    // The issuer no longer holds a session for this browser; the page still
    // holds the account and its stale token.
    await context.clearCookies({ name: "osn_session" });
    await pastExpiry();
    await settingsTab("Profile").click();
    await settingsTab("Security").click();
    await expect(page.getByText("Sign in to manage your settings.")).toBeVisible();
    await expect(shellSignIn()).toBeVisible();
    await expect(signedOutNotice).toBeVisible();
  });
  flow.check(
    "the page says it was signed out, once",
    1,
    await page.getByText("You've been signed out.", { exact: true }).count(),
  );
  flow.check("the signed-out notice is announced", 1, await signedOutNotice.count());
  await musubiNotice(flow, page, "signed-out", signedOutNotice, "--ui-ink-secondary");
  flow.check(
    "the refused grant was sent once",
    1,
    flow.count("POST osn-api /token 400") - refusedGrantsBefore,
  );
  flow.check("no Security GET sent after the refusal", 0, sum(securityGets()) - sentBefore);
  flow.check("the stored account is gone", "", await storedAccount());
  await signedOutSurfaces(flow, page, "Sign in to manage your settings.");

  // A phone mounts the top bar in place of the rail; both open their dialogs
  // from one store, which the notice opens too.
  const signInHeading = page.getByRole("heading", { name: "Sign in to Musubi" });
  const registerHeading = page.getByRole("heading", { name: "Create your Musubi account" });
  let phoneSignIn = false;
  let phoneRegister = "";
  await flow.step("on a phone, the notice and the top bar open their dialogs", async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    try {
      await signedOutNotice.getByRole("button", { name: "Sign in" }).click();
      await expect(signInHeading).toBeVisible();
      phoneSignIn = true;
      await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
      await expect(page.getByRole("dialog")).toHaveCount(0);

      await page.getByRole("button", { name: "Create account" }).filter({ visible: true }).click();
      await expect(registerHeading).toBeVisible();
      phoneRegister = `${await registerHeading.count()} register, ${await signInHeading.count()} sign-in`;
      await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
    } finally {
      if (viewport) await page.setViewportSize(viewport);
    }
  });
  flow.check("on a phone, the notice's Sign in opens sign-in", true, phoneSignIn);
  flow.check(
    "on a phone, the top bar's Create account opens only the register dialog",
    "1 register, 0 sign-in",
    phoneRegister,
  );

  await flow.step("signing in from the notice clears it", async () => {
    await signedOutNotice.getByRole("button", { name: "Sign in" }).click();
    await expect(signInHeading).toBeVisible();
    await identifierField.fill(`@${ada.handle}`);
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByRole("button", { name: `@${ada.handle}` })).toBeVisible();
  });
  flow.check(
    "signed in again, the page no longer says it was signed out",
    0,
    await page.getByText("You've been signed out.", { exact: true }).count(),
  );

  const refusedBeforeReload = flow.count("POST osn-api /token 400");
  await flow.step(
    "without the cookie, a reload with the stored account is signed out",
    async () => {
      await context.clearCookies();
      // What the page stored while signed in: an account and no token.
      await page.evaluate(([key, value]) => localStorage.setItem(key, value), [
        ACCOUNT_KEY,
        signedInAccount,
      ] as const);
      await page.reload();
      await expect(shellSignIn()).toBeVisible();
    },
  );
  flow.check(
    "signed out with no cookie",
    false,
    await page.getByRole("button", { name: `@${ada.handle}` }).isVisible(),
  );
  flow.check(
    "a cold load with no session says nothing about signing out",
    0,
    await page.getByText("You've been signed out.", { exact: true }).count(),
  );
  flow.check(
    "the reload's grant was refused once",
    1,
    flow.count("POST osn-api /token 400") - refusedBeforeReload,
  );
  flow.check("the refused reload forgot the stored account", "", await storedAccount());

  // Pulse is a first-party app, so osn-api sends a browser with no session to
  // Musubi's `/authorize` to sign in, then on to consent, and back to Pulse.
  const authorizePages: string[] = [];
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame() && frame.url().startsWith(`${ORIGINS.musubi}/authorize`)) {
      authorizePages.push(frame.url());
    }
  });
  const contextReadsBefore = flow.count("GET osn-api /authorize/context 200");
  const turnstileBefore = flow.turnstileServed();
  await flow.step("open Musubi's /authorize from Pulse", async () => {
    await page.goto(ORIGINS.pulseWeb);
    await page.getByRole("button", { name: "Continue with musubi" }).click();
    await expect(page.getByLabel("Email or @handle")).toBeVisible();
  });
  await authorizeSignInSurfaces(flow, page);
  await flow.step("sign in to Pulse through Musubi's /authorize", async () => {
    await page.getByLabel("Email or @handle").fill(`@${ada.handle}`);
    await page.getByRole("button", { name: "Continue" }).click();
    // The sign-in screen draws the client card too, mark and all; Allow is
    // what says the consent screen has replaced it, so nothing read below is
    // swapped out mid-read.
    await expect(page.getByRole("button", { name: "Allow" })).toBeVisible();
    await expect(page.getByText("Verified by Musubi")).toBeVisible();
    await authorizeVerifiedSurfaces(flow, page, ada.name);
    await page.getByRole("button", { name: "Allow" }).click();
    await expect(page).toHaveURL(`${ORIGINS.pulseWeb}/welcome`);
  });
  const turnstileAfter = flow.turnstileServed();
  flow.check("Musubi's /authorize page shown", true, authorizePages.length > 0);
  flow.check(
    "the consent screen read its context",
    true,
    flow.count("GET osn-api /authorize/context 200") > contextReadsBefore,
  );
  flow.check(
    "/authorize loaded Turnstile's script and frame",
    true,
    turnstileAfter.script > turnstileBefore.script && turnstileAfter.frame > turnstileBefore.frame,
  );

  // A third-party client always asks for consent. Signed in to OSN by the step
  // above, the browser goes from osn-api straight to the consent screen. The
  // flow reads it and leaves without deciding, so the client's redirect URI is
  // never loaded.
  await flow.step("open a third-party client's consent screen", async () => {
    const request = new URLSearchParams({
      client_id: THIRD_PARTY_OIDC.clientId,
      redirect_uri: THIRD_PARTY_OIDC.redirectUri,
      response_type: "code",
      scope: "openid profile",
      state: "e2e-third-party",
      // RFC 7636's example challenge: any 43-character S256 value is accepted
      // here, and no code is ever redeemed against it.
      code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
      code_challenge_method: "S256",
    });
    await page.goto(`${ORIGINS.osnApi}/authorize?${request}`);
    await expect(page).toHaveURL(new RegExp(`^${ORIGINS.musubi}/authorize\\?`));
    await expect(page.getByRole("button", { name: "Allow" })).toBeVisible();
    await expect(page.getByText("Third-party app", { exact: true })).toBeVisible();
  });
  await authorizeThirdPartySurfaces(flow, page);

  flow.check(
    "no Content-Security-Policy message on a Musubi page",
    "",
    flow.cspMessages(ORIGINS.musubi).join("\n"),
  );
  // osn-api allows 10 profile lists a minute per client address
  // (`profileList`, osn/api/src/routes/auth/limiters.ts), in memory and shared
  // by the whole run. Two short of it leaves room for musubi-org-detail's one
  // and musubi-recovery's one; musubi-step-up-email lists none.
  flow.check(
    "the flow lists profiles no more than eight times",
    true,
    flow.count("GET osn-api /profiles/list 200") <= 8,
  );
});
