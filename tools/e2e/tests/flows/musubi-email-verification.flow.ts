/**
 * Musubi: sign up with a browser Email Verification API token — no email, no
 * number to match — then the passkey step; and with the flag off, no token
 * field at all.
 *
 * The flag is osn-api's (`OSN_EMAIL_VERIFICATION_API`), so this flow signs up
 * against the stack's second osn-api, which has it on
 * (`throughEmailVerificationApi`); its verifier reaches the issuer stand-in
 * (`src/issuer.ts`). The bundled Chromium has no Email Verification API, so
 * the flow does what a browser with it does when the form is submitted: it
 * puts the token, minted for the form's nonce and Musubi's origin, in the
 * hidden field.
 *
 * First a control on the same osn-api: a sign-up whose field stays empty gets
 * the emailed link as ever, which also shows the mail stand-in hears this
 * osn-api. Then "Start again", and the token sign-up.
 */

import { DB_FILES, ORIGINS, PEOPLE } from "../../src/config";
import {
  addVirtualAuthenticator,
  cookieNamed,
  emailVerificationTokenFor,
  expect,
  linkFor,
  queryOne,
  signUpLinksTo,
  test,
  throughEmailVerificationApi,
} from "../support/fixtures";

const hedy = PEOPLE.musubiVerified;
const joan = PEOPLE.musubiVerifiedControl;
const TOKEN_FIELD = 'input[type="hidden"][autocomplete="email-verification-token"]';

// Musubi's forms load Turnstile, which the fixtures stand in for.
test.use({ turnstile: true });

test("musubi-email-verification", async ({ page, context, browser, flow }) => {
  await throughEmailVerificationApi(context);
  const authenticator = await addVirtualAuthenticator(page);
  // As in `musubi-passkey`: the virtual authenticator would answer a
  // conditional-UI request on its own the moment the dialog opens.
  await page.addInitScript(() => {
    PublicKeyCredential.isConditionalMediationAvailable = () => Promise.resolve(false);
  });

  await flow.step("open Musubi", async () => {
    await page.goto(ORIGINS.musubi);
    await expect(page.getByRole("button", { name: "Create account" }).first()).toBeVisible();
  });

  await flow.step("control: a sign-up whose token field stays empty", async () => {
    await page.getByRole("button", { name: "Create account" }).first().click();
    await expect(page.locator(TOKEN_FIELD)).toBeAttached();
    await page.getByLabel("Email").fill(joan.email);
    await page.getByLabel("Handle").fill(joan.handle);
    await page.getByLabel("Date of birth").fill("1990-01-01");
    await page.getByRole("button", { name: "Send verification link" }).click();
    await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
  });
  const control = await linkFor(joan.email);
  flow.check(
    "with no token the link goes",
    true,
    control.url.startsWith(`${ORIGINS.musubi}/verify/`),
  );

  await flow.step("register: details again, with the browser's token", async () => {
    await page.getByRole("button", { name: "Start again" }).click();
    await page.getByLabel("Email").fill(hedy.email);
    await page.getByLabel("Handle").fill(hedy.handle);
    await page.getByLabel("Display name (optional)").fill(hedy.name);
    await expect(page.getByRole("button", { name: "Send verification link" })).toBeEnabled();
    await expect(page.locator(TOKEN_FIELD)).toBeAttached();
  });

  const nonce = await page
    .locator(TOKEN_FIELD)
    .evaluate((el) => (el as HTMLInputElement).nonce || el.getAttribute("nonce") || "");
  flow.check("the field carries a nonce", true, nonce.length > 0);
  const token = await emailVerificationTokenFor(hedy.email, nonce);

  await flow.step("register: submit; the browser fills the field", async () => {
    // Set when the waiting screen would show, which a verified sign-up skips.
    await page.evaluate(() => {
      const w = window as unknown as { sawCheckEmail: boolean };
      w.sawCheckEmail = false;
      new MutationObserver(() => {
        if (document.body.innerText.includes("Check your email")) w.sawCheckEmail = true;
      }).observe(document.body, { subtree: true, childList: true, characterData: true });
    });
    await page.locator(TOKEN_FIELD).evaluate((el, value) => {
      (el as HTMLInputElement).value = value;
    }, token);
    await page.getByRole("button", { name: "Send verification link" }).click();
    await expect(page.getByRole("button", { name: "Add a passkey" })).toBeVisible();
  });

  flow.check(
    "no waiting screen was shown",
    false,
    await page.evaluate(() => (window as unknown as { sawCheckEmail: boolean }).sawCheckEmail),
  );
  flow.check(
    "the account was made by the first poll",
    true,
    flow.saw("POST osn-api /register/:id/status 201") ||
      flow.saw("POST osn-api-evt /register/:id/status 201"),
  );
  flow.check(
    "the browser holds the session cookie",
    true,
    (await cookieNamed(context, ORIGINS.osnApi, "osn_session")) !== undefined,
  );
  const evtAccount = queryOne<{ email: string }>(
    DB_FILES.osnEvt,
    "SELECT email FROM accounts WHERE email = ?",
    hedy.email,
  );
  flow.check("the account is on the osn-api with the flag on", hedy.email, evtAccount?.email ?? "");
  flow.check(
    "and not on the other",
    false,
    queryOne(DB_FILES.osn, "SELECT email FROM accounts WHERE email = ?", hedy.email) !== undefined,
  );

  await flow.step("register: enroll passkey", async () => {
    await page.getByRole("button", { name: "Add a passkey" }).click();
    await expect(page.getByRole("button", { name: `@${hedy.handle}` })).toBeVisible();
  });
  flow.check("authenticator holds one passkey", 1, (await authenticator.credentials()).length);
  // A link would have gone right after the begin, seconds ago.
  flow.check("no sign-up link was mailed", 0, await signUpLinksTo(hedy.email));

  // The first osn-api has the flag off, as every deployed tier does today.
  const offContext = await browser.newContext();
  const off = await flow.newPage(offContext);
  const nonceAnswer = await flow.step("flag off: the sign-up form", async () => {
    await off.goto(ORIGINS.musubi);
    const answered = off.waitForResponse((r) =>
      r.url().endsWith("/register/email-verification-nonce"),
    );
    await off.getByRole("button", { name: "Create account" }).first().click();
    await expect(off.getByLabel("Email")).toBeVisible();
    return (await answered).status();
  });
  flow.check("osn-api with the flag off hands out no nonce", 404, nonceAnswer);
  flow.check("and the form has no token field", 0, await off.locator(TOKEN_FIELD).count());
  await offContext.close();
});
