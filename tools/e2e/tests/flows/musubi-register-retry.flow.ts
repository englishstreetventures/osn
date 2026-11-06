/**
 * Musubi: a sign-up whose first link the mail provider refuses.
 *
 * The person is told a link was sent, as every sign-up is told. A refused send
 * leaves the request live, so "Resend link" sends a new link for the same
 * request, and confirming that link — on another device, picking the number
 * the waiting screen shows — creates the account in the tab that began.
 * osn-api's log says why the first send failed — the status, Resend's error
 * code and what its message meant — and never the address it was for or the
 * key it was sent with.
 *
 * The mail stand-in refuses the first send the way Resend refuses a sender
 * domain it has not verified (`tools/e2e/src/mail.ts`).
 */

import { E2E_RESEND_KEY, ORIGINS, PEOPLE } from "../../src/config";
import {
  confirmLinkOnPage,
  expect,
  linkFor,
  mailFor,
  osnDispatchFailureLog,
  refusedMailCount,
  refuseNextMailTo,
  test,
} from "../support/fixtures";

const grace = PEOPLE.musubiRetry;

test("musubi-register-retry", async ({ page, browser, flow }) => {
  await flow.step("open Musubi", async () => {
    await page.goto(ORIGINS.musubi);
    await expect(page.getByRole("button", { name: "Create account" }).first()).toBeVisible();
  });

  await refuseNextMailTo(grace.email);

  await flow.step("register: details, and the first send is refused", async () => {
    await page.getByRole("button", { name: "Create account" }).first().click();
    await page.getByLabel("Email").fill(grace.email);
    await page.getByLabel("Handle").fill(grace.handle);
    await page.getByLabel("Date of birth").fill("1990-01-01");
    await page.getByLabel("Display name (optional)").fill(grace.name);
    await page.getByRole("button", { name: "Send verification link" }).click();
    await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
  });
  // osn-api sends the link after it answers, so the refusal can land just
  // after the screen moves on.
  await expect.poll(() => refusedMailCount(grace.email), { timeout: 15_000 }).toBe(1);
  flow.check("the stand-in refused the first send", 1, await refusedMailCount(grace.email));

  const entry = await flow.step("osn-api logs why the send failed", () => osnDispatchFailureLog());
  const lines = entry.split("\n");
  flow.check("log names the template", true, lines.includes("template: link-registration"));
  flow.check("log names the status", true, lines.includes("status: 403"));
  flow.check(
    "log names Resend's error code",
    true,
    lines.includes("resendError: validation_error"),
  );
  flow.check(
    "log reads Resend's message as an unverified domain",
    true,
    lines.includes("resendDetail: domain_not_verified"),
  );
  flow.check("log holds no recipient address", false, entry.includes(grace.email));
  flow.check("log holds no Resend key", false, entry.includes(E2E_RESEND_KEY));

  await flow.step("register: resend once the wait has run", async () => {
    await page.clock.runFor(30_000);
    await page.getByRole("button", { name: "Resend link" }).click();
    await expect(page.getByText(/We sent a new link/)).toBeVisible();
  });

  const number = page.locator("p", { hasText: "Your number:" }).locator('span[translate="no"]');
  const pairingCode = ((await number.textContent()) ?? "").trim();
  const link = await linkFor(grace.email);

  const phoneContext = await browser.newContext();
  const phone = await flow.newPage(phoneContext);
  await flow.step("phone: confirm the resent link", async () => {
    await phone.goto(link.url);
    await confirmLinkOnPage(phone, pairingCode);
    await expect(phone.getByRole("heading", { name: "Confirmed" })).toBeVisible();
  });
  await phoneContext.close();

  await flow.step("register: the first browser finishes on its own", async () => {
    await expect(page.getByRole("button", { name: "Enroll credential" })).toBeVisible({
      timeout: 20_000,
    });
  });

  flow.check("one link reached the inbox, the resent one", 1, (await mailFor(grace.email)).length);
  flow.check("sign-up begun once", 1, flow.count("POST osn-api /register/begin "));
  flow.check("the begin answered 200", true, flow.saw("POST osn-api /register/begin 200"));
  flow.check("the link resent", true, flow.saw("POST osn-api /register/:id/resend 200"));
  flow.check("account created", true, flow.saw("POST osn-api /register/:id/status 201"));
});
