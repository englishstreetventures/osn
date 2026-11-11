/**
 * Musubi's dev profile proves it is itself through a link emailed to its own
 * address, and exports its data with the step-up token that link's claim
 * hands over. Then it moves to a new address: a link to the new address proves
 * the inbox, a passkey step-up for `email_change` authorises the move, and the
 * account holds the new address.
 *
 * No app hosts an export button or `ChangeEmailForm` yet, so the tab that
 * began is driven through osn-api with the token Musubi holds, as those views
 * call it; each link is opened and confirmed in a second browser on Musubi's
 * `/verify` page, as a person does. A step-up link's reader types the number
 * (the link goes to the account's own address at whoever's asking); an email
 * change's reader picks it.
 *
 * The step-up token reaches only the tab holding the claim secret, once: the
 * browser that confirms holds no session, and the poll after the claim reads
 * `expired`.
 */

import { DB_FILES, ORIGINS } from "../../src/config";
import {
  addVirtualAuthenticator,
  confirmLinkOnPage,
  cookieNamed,
  expect,
  linkFor,
  mailFor,
  queryOne,
  signInToMusubiAsDev,
  test,
  typeNumberOnPage,
} from "../support/fixtures";

/** The dev principal `/dev/login` signs in as (`DEV_PRINCIPAL` in osn/api/src/routes/auth/dev-login.ts). */
const DEV = {
  accountId: "acc_dev_bootstrap",
  profileId: "usr_dev_bootstrap_owner",
  email: "dev@seed.osn.dev",
} as const;

const NEW_EMAIL = "dev-moved@e2e.test";

/** What a step-up or email-change begin answers the tab that began. */
interface Begun {
  readonly requestId: string;
  readonly claimSecret: string;
  readonly pairingCode: string;
}

test("musubi-step-up-email", async ({ page, browser, flow }) => {
  await addVirtualAuthenticator(page);
  // As in `musubi-passkey`: the virtual authenticator would answer an
  // autofill request on its own, which a person never does.
  await page.addInitScript(() => {
    PublicKeyCredential.isConditionalMediationAvailable = () => Promise.resolve(false);
  });
  const token = await signInToMusubiAsDev(flow, page, "/settings");

  /** The signed-in tab's call to osn-api, with Musubi's token and cookie. */
  const call = async (path: string, data: unknown) => {
    const url = `${ORIGINS.osnApi}${path}`;
    const response = await page.context().request.post(url, {
      headers: { Authorization: `Bearer ${token}`, Origin: ORIGINS.musubi },
      data,
    });
    flow.recordRequest("POST", url, response.status());
    return response;
  };

  // A second browser: the device the email is opened on.
  const phoneContext = await browser.newContext();
  const phone = await flow.newPage(phoneContext);

  // -------------------------------------------------------------------------
  // Step-up for the export, through a link to the account's own address.
  // -------------------------------------------------------------------------
  const stepUp = await flow.step("ask for a step-up link to export the account", async () => {
    const response = await call("/step-up/email/begin", { purpose: "account_export" });
    expect(response.status(), "step-up begin").toBe(200);
    return (await response.json()) as Begun;
  });
  flow.check("the step-up number is two digits", true, /^\d{2}$/.test(stepUp.pairingCode));

  const stepUpLink = await linkFor(DEV.email);
  flow.check("the step-up link is this request's", true, stepUpLink.requestId === stepUp.requestId);
  flow.check(
    "the step-up link opens Musubi",
    true,
    stepUpLink.url.startsWith(`${ORIGINS.musubi}/verify/stepup_`),
  );
  const stepUpMail = (
    await mailFor(DEV.email, (m) => m.subject.startsWith("Confirm it's you"))
  ).find((m) => m.subject.startsWith("Confirm it's you"));
  flow.check("step-up email subject", "Confirm it's you on Musubi", stepUpMail?.subject ?? "");
  flow.check(
    "the step-up email names what it allows",
    true,
    stepUpMail?.text.includes("asked to download a copy of the account's data") ?? false,
  );

  const getStatuses = await flow.step("phone: a GET on the link's routes", async () => {
    const statuses: number[] = [];
    for (const url of [
      `${ORIGINS.osnApi}/email-link/${stepUp.requestId}/confirm`,
      `${ORIGINS.osnApi}/email-link/${stepUp.requestId}/candidates`,
      `${ORIGINS.osnApi}/step-up/email/${stepUp.requestId}/status`,
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- one request after the other
      const response = await phone.request.get(url);
      flow.recordRequest("GET", url, response.status());
      statuses.push(response.status());
    }
    return statuses;
  });
  flow.check("GETs on the link's routes are not found", "404,404,404", getStatuses.join(","));

  const pending = await flow.step("the tab still waits", async () => {
    const response = await call(`/step-up/email/${stepUp.requestId}/status`, {
      claimSecret: stepUp.claimSecret,
    });
    return ((await response.json()) as { status: string }).status;
  });
  flow.check("the GETs confirmed nothing", "pending", pending);

  await flow.step("phone: type the number and confirm", async () => {
    await phone.goto(stepUpLink.url);
    await typeNumberOnPage(phone, stepUp.pairingCode);
    await expect(phone.getByRole("heading", { name: "Confirmed" })).toBeVisible();
  });
  flow.check(
    "the phone holds no session",
    false,
    (await cookieNamed(phoneContext, ORIGINS.osnApi, "osn_session")) !== undefined,
  );

  const claimed = await flow.step("the tab's poll gets the step-up token", async () => {
    const response = await call(`/step-up/email/${stepUp.requestId}/status`, {
      claimSecret: stepUp.claimSecret,
    });
    expect(response.status(), "step-up status").toBe(200);
    return (await response.json()) as { status: string; step_up_token?: string };
  });
  flow.check("the poll completes", "complete", claimed.status);
  const again = await flow.step("the tab polls again", async () => {
    const response = await call(`/step-up/email/${stepUp.requestId}/status`, {
      claimSecret: stepUp.claimSecret,
    });
    return ((await response.json()) as { status: string }).status;
  });
  flow.check("the token is handed over once", "expired", again);

  const exported = await flow.step("export the account with the token", async () => {
    const url = `${ORIGINS.osnApi}/account/export`;
    const response = await page.context().request.get(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Step-Up-Token": claimed.step_up_token ?? "",
        Origin: ORIGINS.musubi,
      },
    });
    flow.recordRequest("GET", url, response.status());
    expect(response.status(), "account export").toBe(200);
    return (await response.text()).trim().split("\n");
  });
  const header = JSON.parse(exported[0] ?? "{}") as { version?: number };
  flow.check("the export opens with its header", 1, header.version ?? 0);
  flow.check(
    "the export holds the account",
    true,
    exported.some((line) => line.startsWith('{"section":"account"')),
  );
  flow.check("the export runs to its end", '{"end":true}', exported.at(-1) ?? "");

  // -------------------------------------------------------------------------
  // Email change, through a link to the new address, authorised by a passkey.
  // -------------------------------------------------------------------------
  // The account's first passkey needs no step-up; Settings' "Add passkey"
  // always asks for one, so it is enrolled straight through osn-api here.
  const enrolled = await flow.step("add the account's first passkey", () =>
    page.evaluate(
      async ({ api, bearer, profileId }) => {
        const headers = { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" };
        const begin = await fetch(`${api}/passkey/register/begin`, {
          method: "POST",
          credentials: "include",
          headers,
          body: JSON.stringify({ profileId }),
        });
        if (!begin.ok) return `begin ${begin.status}`;
        const created = await navigator.credentials.create({
          publicKey: PublicKeyCredential.parseCreationOptionsFromJSON(await begin.json()),
        });
        if (!(created instanceof PublicKeyCredential)) return "no credential";
        const complete = await fetch(`${api}/passkey/register/complete`, {
          method: "POST",
          credentials: "include",
          headers,
          body: JSON.stringify({ profileId, attestation: created.toJSON() }),
        });
        return `complete ${complete.status}`;
      },
      { api: ORIGINS.osnApi, bearer: token, profileId: DEV.profileId },
    ),
  );
  flow.check("the passkey enrols", "complete 200", enrolled);

  const change = await flow.step("ask to move to a new address", async () => {
    const response = await call("/account/email/begin", { new_email: NEW_EMAIL });
    expect(response.status(), "email change begin").toBe(200);
    return (await response.json()) as Begun;
  });

  const changeLink = await linkFor(NEW_EMAIL);
  flow.check(
    "the new address's link is this request's",
    true,
    changeLink.requestId === change.requestId,
  );
  const [changeMail] = await mailFor(NEW_EMAIL);
  flow.check("email change subject", "Confirm your new Musubi email", changeMail?.subject ?? "");
  flow.check(
    "the old address got no email-change link",
    0,
    (await mailFor(DEV.email)).filter((m) => m.text.includes("/verify/emailchange_")).length,
  );

  await flow.step("phone: pick the number at the new address", async () => {
    await phone.goto(changeLink.url);
    await confirmLinkOnPage(phone, change.pairingCode);
    await expect(phone.getByRole("heading", { name: "Confirmed" })).toBeVisible();
  });
  await phoneContext.close();

  const confirmed = await flow.step("the tab learns the new address is proven", async () => {
    const response = await call(`/account/email/${change.requestId}/status`, {
      claimSecret: change.claimSecret,
    });
    return ((await response.json()) as { status: string }).status;
  });
  flow.check("the change is confirmed, not yet made", "confirmed", confirmed);
  flow.check("the account keeps its address until the change completes", DEV.email, accountEmail());

  const changeToken = await flow.step("step up with the passkey for the change", () =>
    page.evaluate(
      async ({ api, bearer }) => {
        const headers = { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" };
        const begin = await fetch(`${api}/step-up/passkey/begin`, {
          method: "POST",
          credentials: "include",
          headers,
          body: "{}",
        });
        if (!begin.ok) return "";
        const { options } = (await begin.json()) as {
          options: PublicKeyCredentialRequestOptionsJSON;
        };
        const asserted = await navigator.credentials.get({
          publicKey: PublicKeyCredential.parseRequestOptionsFromJSON(options),
        });
        if (!(asserted instanceof PublicKeyCredential)) return "";
        const complete = await fetch(`${api}/step-up/passkey/complete`, {
          method: "POST",
          credentials: "include",
          headers,
          body: JSON.stringify({ assertion: asserted.toJSON(), purpose: "email_change" }),
        });
        if (!complete.ok) return "";
        return ((await complete.json()) as { step_up_token: string }).step_up_token;
      },
      { api: ORIGINS.osnApi, bearer: token },
    ),
  );
  flow.check("the passkey mints a step-up token", true, changeToken.length > 0);

  const moved = await flow.step("complete the change", async () => {
    const response = await call(`/account/email/${change.requestId}/complete`, {
      claimSecret: change.claimSecret,
      step_up_token: changeToken,
    });
    expect(response.status(), "email change complete").toBe(200);
    return (await response.json()) as { email: string };
  });
  flow.check("the change answers the new address", NEW_EMAIL, moved.email);
  flow.check("the account holds the new address", NEW_EMAIL, accountEmail());
});

/** The dev account's address, read from osn-api's database. */
function accountEmail(): string {
  const row = queryOne<{ email: string }>(
    DB_FILES.osn,
    "SELECT email FROM accounts WHERE id = ?",
    DEV.accountId,
  );
  return row?.email ?? "";
}
