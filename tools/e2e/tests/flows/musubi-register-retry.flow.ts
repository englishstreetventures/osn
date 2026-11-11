/**
 * Musubi: a sign-up whose first link the mail provider refuses, then declined,
 * then started again.
 *
 * The person is told a link was sent, as every sign-up is told. A refused send
 * leaves the request live, so "Resend link" sends a new link for the same
 * request. That link opens on another device and offers the numbers, which a
 * dead link would not, and "I didn't ask for this" there is answered
 * "Cancelled": the request ends and no account is made. The tab that began
 * keeps waiting, as it would for an address nobody was mailed, and its
 * "Start again" goes back to the details, where a new begin mails a new link.
 * osn-api's log says why the first send failed — the status, Resend's error
 * code and what its message meant — and never the address it was for or the
 * key it was sent with.
 *
 * The mail stand-in refuses the first send the way Resend refuses a sender
 * domain it has not verified (`tools/e2e/src/mail.ts`).
 */

import { E2E_RESEND_KEY, ORIGINS, PEOPLE } from "../../src/config";
import {
  declineLinkOnPage,
  expect,
  linkFor,
  mailFor,
  osnDispatchFailureLog,
  refusedMailCount,
  refuseNextMailTo,
  test,
  waitingScreenNumber,
} from "../support/fixtures";

const grace = PEOPLE.musubiRetry;

// Musubi's forms load Turnstile, which the fixtures stand in for.
test.use({ turnstile: true });

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

  const pairingCode = await waitingScreenNumber(page);
  const link = await linkFor(grace.email);

  const phoneContext = await browser.newContext();
  const phone = await flow.newPage(phoneContext);
  await flow.step("phone: the resent link offers the waiting screen's number", async () => {
    await phone.goto(link.url);
    await expect(phone.getByRole("heading", { name: "Confirm this email" })).toBeVisible();
    await expect(phone.getByRole("button", { name: pairingCode, exact: true })).toBeVisible();
  });

  await flow.step("phone: I didn't ask for this", async () => {
    await declineLinkOnPage(phone);
    await expect(phone.getByRole("heading", { name: "Cancelled" })).toBeVisible();
  });
  flow.check(
    "the decline was answered",
    true,
    flow.saw("POST osn-api /email-link/:id/confirm 200"),
  );
  await phoneContext.close();

  const statusPolls = "POST osn-api /register/:id/status";
  const pollsBeforeWait = flow.count(statusPolls);
  await flow.step("register: the first browser polls again and still waits", async () => {
    await page.clock.runFor(10_000);
    await expect
      .poll(() => flow.count(statusPolls) > pollsBeforeWait, { timeout: 20_000 })
      .toBe(true);
    await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
  });
  flow.check(
    "the waiting tab is not told of the decline",
    0,
    await page.getByRole("heading", { name: "Your link has expired" }).count(),
  );
  flow.check("one link reached the inbox, the resent one", 1, (await mailFor(grace.email)).length);

  await flow.step("register: start again, and send a new link", async () => {
    await page.getByRole("button", { name: "Start again" }).click();
    await expect(page.getByLabel("Email")).toHaveValue(grace.email);
    await page.getByRole("button", { name: "Send verification link" }).click();
    await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
  });
  await expect.poll(async () => (await mailFor(grace.email)).length, { timeout: 15_000 }).toBe(2);
  const restarted = await linkFor(grace.email, 1);
  flow.check("the new link is a new request", true, restarted.requestId !== link.requestId);
  flow.check("sign-up begun twice", 2, flow.count("POST osn-api /register/begin "));
  flow.check("the begin answered 200", true, flow.saw("POST osn-api /register/begin 200"));
  flow.check("the link resent", true, flow.saw("POST osn-api /register/:id/resend 200"));
  flow.check(
    "a declined sign-up made no account",
    false,
    flow.saw("POST osn-api /register/:id/status 201"),
  );
  flow.check(
    "no Content-Security-Policy message on a Musubi page",
    "",
    flow.cspMessages(ORIGINS.musubi).join("\n"),
  );
});
