/**
 * Musubi: create an account with a passkey, sign out, sign back in with the
 * passkey, and keep the session across a reload.
 *
 * The session cookie is set by osn-api (`localhost:4000`) on responses to
 * Musubi's (`localhost:1422`) cross-origin fetches, so it only lands — and only
 * rides on later calls — when those fetches pass `credentials: "include"`.
 */

import { ORIGINS, PEOPLE } from "../../src/config";
import { addVirtualAuthenticator, cookieNamed, expect, otpFor, test } from "../support/fixtures";

const ada = PEOPLE.musubi;

test("musubi-passkey", async ({ page, context, flow }) => {
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

  await flow.step("register: details", async () => {
    await page.getByRole("button", { name: "Create account" }).first().click();
    await page.getByLabel("Email").fill(ada.email);
    await page.getByLabel("Handle").fill(ada.handle);
    await page.getByLabel("Date of birth").fill("1990-01-01");
    await page.getByLabel("Display name (optional)").fill(ada.name);
    await page.getByRole("button", { name: "Send verification code" }).click();
  });

  await flow.step("register: verify email", async () => {
    const code = await otpFor(ada.email);
    await page.getByLabel("Digit 1").pressSequentially(code);
    await page.getByRole("button", { name: "Verify email" }).click();
  });

  await flow.step("register: enroll passkey", async () => {
    await page.getByRole("button", { name: "Enroll credential" }).click();
    await expect(page.getByRole("button", { name: `@${ada.handle}` })).toBeVisible();
  });

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
