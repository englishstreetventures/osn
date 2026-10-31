/**
 * Musubi: a sign-up whose first code the mail provider refuses.
 *
 * The person is told a code was sent, as every sign-up is told. A refused send
 * leaves nothing pending, so "Resend code" sends a new code, and that code
 * creates the account. osn-api's log says why the first send failed — the
 * status, Resend's error code and what its message meant — and never the
 * address it was for or the key it was sent with.
 *
 * The mail stand-in refuses the first send the way Resend refuses a sender
 * domain it has not verified (`tools/e2e/src/mail.ts`).
 */

import { E2E_RESEND_KEY, ORIGINS, PEOPLE } from "../../src/config";
import {
  expect,
  mailFor,
  osnDispatchFailureLog,
  otpFor,
  refusedMailCount,
  refuseNextMailTo,
  test,
} from "../support/fixtures";

const grace = PEOPLE.musubiRetry;

test("musubi-register-retry", async ({ page, flow }) => {
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
    await page.getByRole("button", { name: "Send verification code" }).click();
    await expect(page.getByRole("button", { name: "Verify email" })).toBeVisible();
  });
  // osn-api sends the code after it answers, so the refusal can land just
  // after the screen moves on.
  await expect.poll(() => refusedMailCount(grace.email), { timeout: 15_000 }).toBe(1);
  flow.check("the stand-in refused the first send", 1, await refusedMailCount(grace.email));

  const entry = await flow.step("osn-api logs why the send failed", () => osnDispatchFailureLog());
  const lines = entry.split("\n");
  flow.check("log names the template", true, lines.includes("template: otp-registration"));
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

  await flow.step("register: resend once the cooldown has run", async () => {
    await page.clock.runFor(30_000);
    await page.getByRole("button", { name: "Resend code" }).click();
    await expect(page.getByText("New code sent")).toBeVisible();
  });

  await flow.step("register: verify email with the resent code", async () => {
    const code = await otpFor(grace.email);
    await page.getByLabel("Digit 1").pressSequentially(code);
    await page.getByRole("button", { name: "Verify email" }).click();
    await expect(page.getByRole("button", { name: "Enroll credential" })).toBeVisible();
  });

  flow.check("one code reached the inbox, the resent one", 1, (await mailFor(grace.email)).length);
  flow.check("sign-up begun twice", 2, flow.count("POST osn-api /register/begin "));
  flow.check(
    "both begins answered 200, as sent",
    2,
    flow.count("POST osn-api /register/begin 200"),
  );
  flow.check("account created", true, flow.saw("POST osn-api /register/complete 201"));
});
