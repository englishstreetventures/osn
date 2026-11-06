/**
 * Musubi: create an account through the emailed link — confirmed in a second
 * browser, picking the number the first shows — then a passkey; sign out, sign
 * back in with the passkey, and keep the session across a reload.
 *
 * Before that, the first link is spent the wrong way: a `GET` on its routes
 * approves nothing, and a number that is not the one shown ends the request,
 * which the waiting tab learns on its own. A new link from the details, with
 * a new number, is the one confirmed.
 *
 * The session cookie is set by osn-api (`localhost:4000`) on responses to
 * Musubi's (`localhost:1422`) cross-origin fetches, so it only lands — and only
 * rides on later calls — when those fetches pass `credentials: "include"`.
 */

import { ORIGINS, PEOPLE } from "../../src/config";
import {
  addVirtualAuthenticator,
  confirmLinkOnPage,
  cookieNamed,
  expect,
  linkFor,
  mailFor,
  pickWrongNumberOnPage,
  test,
  waitingScreenNumber,
} from "../support/fixtures";

const ada = PEOPLE.musubi;

test("musubi-passkey", async ({ page, context, browser, flow }) => {
  const authenticator = await addVirtualAuthenticator(page);
  // The virtual authenticator answers a conditional-UI (autofill) request on
  // its own, which a person never does: it would sign in the moment the dialog
  // opens, racing the "@handle → Continue" path this flow drives. Report
  // conditional mediation as unavailable, as on a browser without it.
  await page.addInitScript(() => {
    PublicKeyCredential.isConditionalMediationAvailable = () => Promise.resolve(false);
  });

  await flow.step("open Musubi", async () => {
    await page.goto(ORIGINS.musubi);
    await expect(page.getByRole("button", { name: "Create account" }).first()).toBeVisible();
  });
  flow.check("tab title", "Musubi", await page.title());

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

  await flow.step("register: details", async () => {
    await page.getByRole("button", { name: "Create account" }).first().click();
    await page.getByLabel("Email").fill(ada.email);
    await page.getByLabel("Handle").fill(ada.handle);
    await page.getByLabel("Date of birth").fill("1990-01-01");
    await page.getByLabel("Display name (optional)").fill(ada.name);
    await page.getByRole("button", { name: "Send verification link" }).click();
    await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
  });

  // The number the waiting screen shows, which the link's page asks for.
  const pairingCode = await flow.step("register: read the number on the waiting screen", () =>
    waitingScreenNumber(page),
  );
  flow.check("the waiting screen shows a two-digit number", true, /^\d{2}$/.test(pairingCode));

  const link = await linkFor(ada.email);
  const [verification] = await mailFor(ada.email);
  flow.check("registration email subject", "Verify your Musubi email", verification?.subject ?? "");
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
  const secondLink = await linkFor(ada.email, 1);
  flow.check("the new link is a new request", true, secondLink.requestId !== link.requestId);

  await flow.step("phone: open the new link", async () => {
    await phone.goto(secondLink.url);
    await expect(phone.getByRole("heading", { name: "Confirm this email" })).toBeVisible();
  });

  await flow.step("phone: pick the number and confirm", async () => {
    await confirmLinkOnPage(phone, secondCode);
    await expect(phone.getByRole("heading", { name: "Confirmed" })).toBeVisible();
  });
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

  await flow.step("register: enroll passkey", async () => {
    await page.getByRole("button", { name: "Enroll credential" }).click();
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
    await expect(page.getByRole("button", { name: "Sign in" }).first()).toBeVisible();
  });
  flow.check(
    "session cookie cleared on sign-out",
    false,
    (await cookieNamed(context, ORIGINS.osnApi, "osn_session")) !== undefined,
  );

  await flow.step("sign in with passkey", async () => {
    await page.getByRole("button", { name: "Sign in" }).first().click();
    await page.getByLabel("Email or @handle").fill(`@${ada.handle}`);
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByRole("button", { name: `@${ada.handle}` })).toBeVisible();
  });

  const cookie = await cookieNamed(context, ORIGINS.osnApi, "osn_session");
  flow.check("osn_session cookie set by osn-api", true, cookie !== undefined);
  flow.check("osn_session is HttpOnly", true, cookie?.httpOnly ?? false);
  flow.check("osn_session is SameSite=Lax", "Lax", cookie?.sameSite ?? "");

  await flow.step("reload restores the session from the cookie alone", async () => {
    // Drop the client's cached account, so the only way back to a session is
    // the HttpOnly cookie riding on a credentialed `POST /token`.
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await expect(page.getByRole("button", { name: `@${ada.handle}` })).toBeVisible();
  });
  flow.check("session restored through POST /token", true, flow.saw("POST osn-api /token 200"));

  await flow.step("without the cookie, the reload is signed out", async () => {
    await context.clearCookies();
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await expect(page.getByRole("button", { name: "Sign in" }).first()).toBeVisible();
  });
  flow.check(
    "signed out with no cookie",
    false,
    await page.getByRole("button", { name: `@${ada.handle}` }).isVisible(),
  );
});
