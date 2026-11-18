/**
 * Musubi: get back into an account whose only passkey is lost, through an
 * emailed link — opened in a second browser, which types the number the first
 * shows — then add a passkey in the first, and sign in with it.
 *
 * Before that, the first link is spent the wrong way: a `GET` on its routes
 * approves nothing, and a number that is not the one shown ends the request.
 * The second link is turned down ("I didn't ask for this"). Each time the
 * waiting tab keeps waiting, as it would for an address with no account, and
 * its "Start again" goes back to the address. The third is the one confirmed.
 * The wait also survives a reload of the first browser.
 *
 * The restricted recovery session reaches only the first browser, the one
 * holding the claim secret: the second never gets a session cookie.
 */

import { ORIGINS, RECOVERY_PERSON } from "../../src/config";
import {
  addVirtualAuthenticator,
  cookieNamed,
  declineLinkOnPage,
  expect,
  linkFor,
  mailFor,
  test,
  typeNumberOnPage,
  waitingScreenNumber,
} from "../support/fixtures";

// Musubi's forms load Turnstile, which the fixtures stand in for.
test.use({ turnstile: true });

const person = RECOVERY_PERSON;

/** A two-digit number that is not `shown`. */
const otherThan = (shown: string): string => (shown === "00" ? "01" : "00");

test("musubi-recovery", async ({ page, context, browser, flow }) => {
  const authenticator = await addVirtualAuthenticator(page);
  // As in `musubi-passkey`: the virtual authenticator would answer an
  // autofill request on its own, which a person never does.
  await page.addInitScript(() => {
    PublicKeyCredential.isConditionalMediationAvailable = () => Promise.resolve(false);
  });

  /** From the address field, asks for a link and reads the number shown. */
  const askForLink = async (step: string) => {
    await flow.step(step, async () => {
      await expect(page.getByLabel("Email address on the account")).toHaveValue(person.email);
      await page.getByRole("button", { name: "Send the link" }).click();
      await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
    });
    return waitingScreenNumber(page);
  };

  await flow.step("open Musubi and ask to get back in", async () => {
    await page.goto(ORIGINS.musubi);
    await page.getByRole("button", { name: "Sign in" }).first().click();
    await page.getByRole("button", { name: "Lost your passkey?" }).click();
    await page.getByRole("button", { name: "Email me a link" }).click();
    await page.getByLabel("Email address on the account").fill(person.email);
  });
  const first = await askForLink("laptop: send the first link");
  flow.check("the waiting screen shows a two-digit number", true, /^\d{2}$/.test(first));
  const resendLabel = (await page.getByRole("button", { name: /^Resend in/ }).textContent()) ?? "";
  const resendSeconds = Number(/(\d+)/.exec(resendLabel)?.[1] ?? "0");
  flow.check("Resend waits more than a minute", true, resendSeconds > 60);

  await flow.step("laptop: a reload resumes the wait", async () => {
    await page.reload();
    await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
  });
  // A boolean, not the number: the number differs every run, and
  // `results.json` must match byte for byte on a rerun.
  const again = await flow.step("laptop: read the number again", () => waitingScreenNumber(page));
  flow.check("the reloaded wait shows the same number", true, again === first);

  const link = await linkFor(person.email);
  const [mail] = await mailFor(person.email);
  flow.check("recovery email subject", "Recover your Musubi account", mail?.subject ?? "");
  flow.check(
    "the link opens Musubi",
    true,
    link.url.startsWith(`${ORIGINS.musubi}/verify/recovery_`),
  );
  flow.check("the secret rides in the fragment", false, link.url.includes("?"));

  // A second browser: the device the email is opened on.
  const phoneContext = await browser.newContext();
  const phone = await flow.newPage(phoneContext);
  const confirms = () => flow.count("POST osn-api /email-link/:id/confirm");

  const getStatuses = await flow.step("phone: a GET on the link's routes", async () => {
    const statuses: number[] = [];
    for (const url of [
      `${ORIGINS.osnApi}/email-link/${link.requestId}/confirm`,
      `${ORIGINS.osnApi}/email-link/${link.requestId}/candidates`,
      `${ORIGINS.osnApi}/login/recovery/email/${link.requestId}/status`,
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- one request after the other
      const response = await phone.request.get(url);
      flow.recordRequest("GET", url, response.status());
      statuses.push(response.status());
    }
    return statuses;
  });
  flow.check("GETs on the link's routes are not found", "404,404,404", getStatuses.join(","));
  flow.check("the GETs confirmed nothing", 0, confirms());
  flow.check(
    "the laptop still waits",
    true,
    await page.getByRole("heading", { name: "Check your email" }).isVisible(),
  );

  await flow.step("phone: type a number that is not the one shown", async () => {
    await phone.goto(link.url);
    await typeNumberOnPage(phone, otherThan(first));
    await expect(phone.getByRole("heading", { name: "This link no longer works" })).toBeVisible();
  });
  flow.check("the secret left the address bar", false, phone.url().includes("#"));
  flow.check(
    "the page read no candidates",
    0,
    flow.count("POST osn-api /email-link/:id/candidates"),
  );

  const statusPolls = "POST osn-api /login/recovery/email/:id/status";
  /** Waits for the laptop's next poll, which finds it still waiting, then starts again. */
  const stillWaitsThenStartsAgain = async (step: string) => {
    const before = flow.count(statusPolls);
    await flow.step(step, async () => {
      await expect.poll(() => flow.count(statusPolls) > before, { timeout: 20_000 }).toBe(true);
      await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
    });
    const told = await page.getByRole("heading", { name: "Your link has expired" }).count();
    await flow.step(`${step}: start again`, async () => {
      await page.getByRole("button", { name: "Start again" }).click();
    });
    return told;
  };

  flow.check(
    "the laptop is not told of the wrong number",
    0,
    await stillWaitsThenStartsAgain("laptop: still waits after the wrong number"),
  );
  const second = await askForLink("laptop: send the second link");
  const secondLink = await linkFor(person.email, 1);
  flow.check("the second link is a new request", true, secondLink.requestId !== link.requestId);

  await flow.step("phone: turn the second link down", async () => {
    await phone.goto(secondLink.url);
    await declineLinkOnPage(phone);
    await expect(phone.getByRole("heading", { name: "Cancelled" })).toBeVisible();
  });
  flow.check("the number shown is two digits", true, /^\d{2}$/.test(second));

  flow.check(
    "the laptop is not told of the decline",
    0,
    await stillWaitsThenStartsAgain("laptop: still waits after the decline"),
  );
  const third = await askForLink("laptop: send the third link");
  const thirdLink = await linkFor(person.email, 2);

  await flow.step("phone: type the number and confirm", async () => {
    await phone.goto(thirdLink.url);
    await typeNumberOnPage(phone, third);
    await expect(phone.getByRole("heading", { name: "Confirmed" })).toBeVisible();
  });
  flow.check(
    "the phone holds no session",
    false,
    (await cookieNamed(phoneContext, ORIGINS.osnApi, "osn_session")) !== undefined,
  );
  await phoneContext.close();

  await flow.step("laptop: gets the recovery session on its own", async () => {
    await expect(page.getByRole("heading", { name: "Add a passkey to get back in" })).toBeVisible({
      timeout: 20_000,
    });
  });
  flow.check(
    "the session went to the laptop's poll",
    true,
    flow.saw("POST osn-api /login/recovery/email/:id/status 201"),
  );
  flow.check(
    "the laptop holds the session cookie",
    true,
    (await cookieNamed(context, ORIGINS.osnApi, "osn_session")) !== undefined,
  );
  flow.check(
    "recovery begun three times",
    3,
    flow.count("POST osn-api /login/recovery/email/begin "),
  );

  await flow.step("laptop: add a passkey", async () => {
    await page.getByRole("button", { name: "Add a passkey" }).click();
    await expect(page.getByRole("heading", { name: "You're back in" })).toBeVisible();
  });
  const credentials = await authenticator.credentials();
  flow.check("authenticator holds one passkey", 1, credentials.length);

  const notices = await mailFor(person.email, (m) => m.subject.includes("was recovered"));
  flow.check(
    "recovery notice subject",
    "Your Musubi account was recovered",
    notices.find((m) => m.subject.includes("was recovered"))?.subject ?? "",
  );

  await flow.step("sign in with the new passkey", async () => {
    await page.getByRole("button", { name: "Sign in with your new passkey" }).click();
    await page.getByLabel("Email or @handle").fill(`@${person.handle}`);
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByRole("button", { name: `@${person.handle}` })).toBeVisible();
  });
});
