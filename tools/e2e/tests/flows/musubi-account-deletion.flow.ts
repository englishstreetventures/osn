/**
 * A person deletes their Musubi account, keeps it inside the seven days, and
 * deletes it again for good.
 *
 * `DELETION_PERSON` is seeded: an account with an open Pulse enrolment, a
 * live session this flow's browser holds the cookie of, and cire's
 * `wed_e2e_leaver`, which their profile alone owns. Seeded rather than signed
 * up, so the flow spends none of the run's sign-up and sign-in windows
 * (`tools/e2e/tests/flows.test.ts`); and its browsers reach osn-api from
 * `ACCOUNT_DELETION_ADDRESS` (`callOsnApiFrom`), so its step-ups and profile
 * lists spend their own windows too. It enrols the account's first passkey
 * through osn-api, as Settings would after a sign-up, and every step-up after
 * that is the passkey.
 *
 * The flow opens Settings → Account → Delete account, finds cire's wedding
 * among what needs an answer, answers it, types the handle and steps up; the
 * page gives way to the one screen a pending deletion shows, whose "Download
 * my data" works. Signed out, it starts a sign-in from Pulse: Musubi's
 * `/authorize` signs it in with the passkey and shows the same screen, naming
 * Pulse, with no code issued; "Back to Pulse" sends Pulse its plain refusal.
 * Opening Musubi, the same screen; "Keep my account" brings the app back, with
 * the handle, the passkey and the Pulse enrolment as they were and the wedding
 * untouched. Deleted again with "Delete everything", a sign-in started from
 * cire's organiser portal goes straight to the screen, since Musubi is still
 * signed in; "Keep my account" there carries the same sign-in on to consent
 * and into cire. Deleted a third time, which now ends that cire session too,
 * its job is moved past its window — the suite's clock runs in real time — and
 * the stack's sweeper (every 2 s here) reaches Pulse and cire and erases the
 * account. A gift on the wedding is disputed first, so cire's purge holds the
 * wedding and cire reports it as kept. The account is gone, the handle is
 * held, the wedding is deleted and names no profile of the person's, and the
 * account-deleted email reached the address it had, listing the held wedding. The person's
 * organisation passed to its admin, who opens the email's link signed in
 * through its own seeded session and declines it: it passes to the next
 * member, who is mailed in turn. Before any of it, "Send me a link" mails
 * the download page's address.
 *
 * cire's action links the wedding's download page (`<cire host>/#/w/<id>/settings/export`):
 * on this http stack too, since a local run follows an http link to this
 * machine. Following it to the download is `cire-remove-my-data`'s step.
 *
 * The person also connected the Stripe account of `wed_e2e_leaver_payout`,
 * which they own with the heir. The preview shows its payout line, asking for
 * no answer, with the Express Dashboard sign-in and a link to its Money gifts;
 * "Delete everything" keeps that line's own words in the scheduled email, since
 * it happens whatever is answered; and the erasure mails the heir, once,
 * naming no one, that money gifts there need a new Stripe account.
 */

import {
  ACCOUNT_DELETION_ADDRESS,
  DB_FILES,
  DELETION_PERSON as P,
  ORIGINS,
} from "../../src/config";
import {
  addVirtualAuthenticator,
  callOsnApiFrom,
  cookieNamed,
  expect,
  mailFor,
  queryOne,
  routeOidcLegsFrom,
  suiteNow,
  test,
  writeRow,
} from "../support/fixtures";

test.use({ turnstile: true });

const WINDOW_HEADING = "Your account is set to be deleted";

/** The household the flow gives the wedding, for its disputed gift. */
const LEAVER_HOUSEHOLD = "fam_e2e_leaver";

test("musubi-account-deletion", async ({ page, context, browser, flow }) => {
  // Six step-ups, two app sign-ins, two keeps, three deletions and a sweep.
  test.slow();
  await callOsnApiFrom(context, ACCOUNT_DELETION_ADDRESS);
  const authenticator = await addVirtualAuthenticator(page);

  /** The drawn box's corner, read the first time "Delete everything" is ticked. */
  let boxCorner: string | undefined;

  /** Deletes the account again from Settings, with "Delete everything". */
  const deleteEverything = (name: string) =>
    flow.step(name, async () => {
      await page.goto(`${ORIGINS.musubi}/settings/delete-account`);
      await page.getByRole("button", { name: "Continue" }).click();
      const everything = page.getByRole("checkbox", { name: "Delete everything" });
      await page.locator("label").filter({ has: everything }).click();
      await expect(everything).toBeChecked();
      // The box is drawn beside the input, which is visually hidden.
      boxCorner ??= await everything.evaluate(
        (input) => getComputedStyle(input.nextElementSibling!).borderTopLeftRadius,
      );
      await page.getByRole("button", { name: "Continue" }).click();
      await page.getByRole("textbox", { name: "Your handle" }).fill(P.handle);
      await page.getByRole("button", { name: "Delete my account" }).click();
      await page.getByRole("button", { name: "Use passkey" }).click();
      await expect(page.getByRole("heading", { level: 1, name: WINDOW_HEADING })).toBeVisible();
    });

  await flow.step("hold the seeded session's cookie, as a sign-in leaves it", async () => {
    await context.addCookies([
      {
        name: "osn_session",
        value: P.session.token,
        url: ORIGINS.osnApi,
        httpOnly: true,
        sameSite: "Lax",
      },
      { name: "osn_has_session", value: "1", url: ORIGINS.osnApi, sameSite: "Lax" },
    ]);
  });

  const token = await flow.step("open Musubi signed in", async () => {
    const granted = page.waitForResponse(
      (r) => r.url() === `${ORIGINS.osnApi}/token` && r.request().method() === "POST",
    );
    await page.goto(`${ORIGINS.musubi}/settings#account`);
    const body = (await (await granted).json()) as { access_token: string };
    await expect(page.getByRole("link", { name: "Delete account…" })).toBeVisible();
    return body.access_token;
  });

  // The account's first passkey needs no step-up; Settings' "Add a passkey"
  // always asks for one, so it is enrolled straight through osn-api, as
  // `musubi-step-up-email` does.
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
      { api: ORIGINS.osnApi, bearer: token, profileId: P.profileId },
    ),
  );
  flow.check("the passkey enrols", "complete 200", enrolled);
  flow.check("the authenticator holds one passkey", 1, (await authenticator.credentials()).length);

  // "Send me a link": an email with the download page's address, no data.
  await flow.step("ask for a link to the data by email", async () => {
    await page.getByRole("button", { name: "Send me a link" }).click();
    await expect(
      page.getByText("Check your email for a link to download your data."),
    ).toBeVisible();
  });
  const linkMail = (await mailFor(P.email, (m) => m.subject === "Download your Musubi data")).find(
    (m) => m.subject === "Download your Musubi data",
  );
  flow.check(
    "the link email carries the download page's address",
    true,
    linkMail?.text.includes(`${ORIGINS.musubi}/settings#account`) ?? false,
  );

  // -------------------------------------------------------------------------
  // The first deletion: answer cire's wedding, type the handle, step up.
  // -------------------------------------------------------------------------
  const weddingAnswer = page.getByRole("checkbox", { name: /^Deleted with its guests/ });
  await flow.step("open the deletion flow", async () => {
    await page.getByRole("link", { name: "Delete account…" }).click();
    await expect(
      page.getByRole("heading", { level: 1, name: "Delete your account" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByRole("heading", { name: "What needs an answer" })).toBeVisible();
    // The preview asks Pulse and cire before it draws their actions.
    await expect(weddingAnswer).toBeVisible();
  });
  flow.check(
    "cire's apps heading is shown",
    true,
    await page.getByRole("heading", { level: 3, name: "Cire" }).isVisible(),
  );
  flow.check(
    "cire's open action names the wedding",
    true,
    await page.getByText(`You are the only owner of "${P.wedding.name}"`).isVisible(),
  );
  flow.check("the wedding's answer offers its deletion", true, await weddingAnswer.isVisible());
  flow.check(
    "cire's action links the wedding's download page",
    `${ORIGINS.cireHost}/#/w/${P.wedding.id}/settings/export`,
    (await page
      .locator(`[data-action="cire:wedding:${P.wedding.id}"]`)
      .getByRole("link", { name: "Open in Cire" })
      .getAttribute("href")) ?? "no link",
  );
  const payoutCard = page.locator(`[data-action="cire:payout:${P.payoutWedding.id}"]`);
  flow.check(
    "cire's payout line names the wedding whose Stripe account the person connected",
    true,
    (await payoutCard.textContent())?.includes(
      `You connected the Stripe account for money gifts on "${P.payoutWedding.name}".`,
    ) ?? false,
  );
  flow.check(
    "cire's payout line asks for no answer",
    0,
    await payoutCard.getByRole("checkbox").count(),
  );
  flow.check(
    "cire's payout line names the Express Dashboard sign-in",
    true,
    (await payoutCard.textContent())?.includes("connect.stripe.com/express_login") ?? false,
  );
  flow.check(
    "cire's payout line links the wedding's Money gifts",
    `${ORIGINS.cireHost}/#/w/${P.payoutWedding.id}/registry/settings`,
    (await payoutCard.getByRole("link", { name: "Open in Cire" }).getAttribute("href")) ??
      "no link",
  );

  await flow.step("answer the wedding: delete it with the account", async () => {
    // The box is visually hidden under its words, which are its label.
    await page.locator("label").filter({ has: weddingAnswer }).click();
    await expect(weddingAnswer).toBeChecked();
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByRole("textbox", { name: "Your handle" }).fill(P.handle);
  });
  flow.check(
    "the confirm step offers the keep for the 7 days alone",
    true,
    await page
      .getByText(
        "We sign you out on your other devices now, and delete your account once 7 days have passed. Until then, you can sign in and keep it.",
      )
      .isVisible(),
  );

  await flow.step("delete, stepping up with the passkey", async () => {
    await page.getByRole("button", { name: "Delete my account" }).click();
    await page.getByRole("button", { name: "Use passkey" }).click();
    await expect(page.getByRole("heading", { level: 1, name: WINDOW_HEADING })).toBeVisible();
  });
  flow.check(
    "the window screen offers to keep the account",
    true,
    await page.getByRole("button", { name: "Keep my account" }).isVisible(),
  );
  // The day the job's window ends on, in the browser's zone, with no clock
  // time; and the keep offered only before that day. Compared in the page, so
  // the result does not depend on the date the suite runs on.
  const deletesAt = hardDeleteAt();
  flow.check(
    "the window screen gives the day the window ends on, with no clock time",
    true,
    await page.locator("main p:has(time)").evaluate((line, at) => {
      const end = new Date(at * 1_000);
      const pad = (n: number) => String(n).padStart(2, "0");
      const words = new Intl.DateTimeFormat(undefined, { dateStyle: "full" }).format(end);
      const date = `${end.getFullYear()}-${pad(end.getMonth() + 1)}-${pad(end.getDate())}`;
      return (
        line.textContent === `We delete it on or shortly after ${words}.` &&
        line.querySelector("time")?.getAttribute("datetime") === date
      );
    }, deletesAt),
  );
  flow.check(
    "the window screen offers the keep before that day",
    true,
    await page.getByText(/^Before that day, you can keep it\./).isVisible(),
  );
  flow.check("the shell gave way to it", 0, await page.locator("aside").count());
  flow.check("the account is tombstoned", true, deletedAt() !== null);
  flow.check(
    "the profile's handle is redacted",
    true,
    handleNow()?.startsWith("deleted_") ?? false,
  );
  flow.check(
    "the deletion's choice for the wedding is stored",
    true,
    (storedChoices() ?? "").includes(`cire:wedding:${P.wedding.id}`),
  );

  const scheduled = await mailFor(
    P.email,
    (m) => m.subject === "Your Musubi account is scheduled for deletion",
  );
  const scheduledMail = scheduled.find(
    (m) => m.subject === "Your Musubi account is scheduled for deletion",
  );
  flow.check(
    "the scheduled email names the wedding",
    true,
    scheduledMail?.text.includes(`"${P.wedding.name}"`) ?? false,
  );
  flow.check(
    "the scheduled email says how to keep the account",
    true,
    scheduledMail?.text.includes('"Keep my account"') ?? false,
  );
  flow.check(
    "the scheduled email gives the day in UTC, with no clock time",
    true,
    (scheduledMail?.text.includes(
      `It will be deleted on or shortly after ${utcDay(deletesAt)} (UTC).`,
    ) ??
      false) &&
      !/\bat \d{2}:\d{2} UTC\b/.test(scheduledMail?.text ?? ""),
  );
  flow.check(
    "the scheduled email says what happens to the wedding, in cire's words",
    true,
    scheduledMail?.text.includes("Deleted with its guests, replies and invite") ?? false,
  );
  flow.check(
    "the scheduled email says the organisation passes to its other admin",
    true,
    scheduledMail?.text.includes(`@${P.heir.handle} becomes the owner.`) ?? false,
  );

  // "Download my data" from the window screen: the pending session reaches
  // the export, and the browser can read the file name across the origin.
  const exported = await flow.step("download the data from the window screen", async () => {
    const answered = page.waitForResponse(
      (r) => r.url() === `${ORIGINS.osnApi}/account/export` && r.request().method() === "GET",
    );
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download my data" }).click();
    await page.getByRole("button", { name: "Use passkey" }).click();
    const response = await answered;
    return {
      status: response.status(),
      exposed: (await response.headerValue("access-control-expose-headers")) ?? "",
      file: (await download).suggestedFilename(),
    };
  });
  flow.check("the export answers the pending session", 200, exported.status);
  flow.check(
    "the export's file name is readable across the origin",
    true,
    exported.exposed.toLowerCase().includes("content-disposition"),
  );
  flow.check("the file is saved as the export", "musubi-account-export.ndjson", exported.file);

  // -------------------------------------------------------------------------
  // Signed out, then a sign-in started from Pulse: Musubi's /authorize shows
  // the window screen, and Pulse hears nothing until the person goes back.
  // -------------------------------------------------------------------------
  await flow.step("sign out from the window screen", async () => {
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(
      page.locator("aside, header").getByRole("button", { name: "Sign in" }),
    ).toBeVisible();
  });

  // Each app's two OIDC legs, and the osn-api `/authorize` the start leg
  // leads to, go from the flow's own address, so they spend none of the
  // windows `flows.test.ts` budgets for the suite's address.
  const pulseLegs = await routeOidcLegsFrom(context, ORIGINS.pulseApi, ACCOUNT_DELETION_ADDRESS);
  const cireLegs = await routeOidcLegsFrom(context, ORIGINS.cireApi, ACCOUNT_DELETION_ADDRESS);
  const consentsBefore = consents();

  // The sign-in panel offers the browser's passkeys as it opens (a
  // discoverable credential, `mediation: "conditional"`), and the virtual
  // authenticator answers at once: the sign-in a person makes by picking
  // their passkey from the browser's list.
  const profileListsBefore = flow.count("GET osn-api /profiles/list");
  await flow.step("Pulse: start a sign-in, and sign in on Musubi with the passkey", async () => {
    await page.goto(ORIGINS.pulseWeb);
    await page.getByRole("button", { name: "Continue with musubi" }).click();
    await expect(page.getByRole("heading", { name: WINDOW_HEADING })).toBeVisible();
  });
  flow.check(
    "Pulse's sign-in lands on Musubi's /authorize",
    `${ORIGINS.musubi}/authorize`,
    new URL(page.url()).origin + new URL(page.url()).pathname,
  );
  flow.check(
    "the window screen on /authorize says the person is not signed in to Pulse",
    true,
    await page.getByText("You're not signed in to Pulse.", { exact: false }).isVisible(),
  );
  flow.check(
    "the window screen on /authorize gives the day the window ends on",
    true,
    await page.locator("main p:has(time)").evaluate((line, at) => {
      const end = new Date(at * 1_000);
      const words = new Intl.DateTimeFormat(undefined, { dateStyle: "full" }).format(end);
      return line.textContent === `We delete it on or shortly after ${words}.`;
    }, hardDeleteAt()),
  );
  flow.check(
    "the window screen on /authorize offers to keep the account",
    true,
    await page.getByRole("button", { name: "Keep my account" }).isVisible(),
  );
  flow.check("no code was issued for the account", 0, codes());
  flow.check("no consent was recorded for the account", consentsBefore, consents());
  flow.check(
    "Pulse holds no session for the person",
    false,
    (await cookieNamed(context, ORIGINS.pulseApi, "pulse_web_session")) !== undefined,
  );
  flow.check(
    "signed in during the window, the pending session lists no profiles",
    0,
    flow.count("GET osn-api /profiles/list") - profileListsBefore,
  );

  await flow.step("go back to Pulse", async () => {
    await page.getByRole("button", { name: "Back to Pulse" }).click();
    await page.waitForURL(
      (url) =>
        url.origin === ORIGINS.pulseWeb &&
        url.searchParams.get("auth_error") === "sign_in_declined",
    );
  });
  flow.check("Pulse's two legs went from the flow's own address", 2, pulseLegs.sent());
  flow.check(
    "Pulse still holds no session for the person",
    false,
    (await cookieNamed(context, ORIGINS.pulseApi, "pulse_web_session")) !== undefined,
  );
  flow.check("still no code for the account", 0, codes());

  // -------------------------------------------------------------------------
  // Musubi itself, signed in on /authorize: the window screen. Keep the
  // account there, and the app comes back.
  // -------------------------------------------------------------------------
  await flow.step("open Musubi: the window screen", async () => {
    await page.goto(`${ORIGINS.musubi}/settings`);
    await expect(page.getByRole("heading", { level: 1, name: WINDOW_HEADING })).toBeVisible();
  });

  await flow.step("keep the account, stepping up with the passkey", async () => {
    await page.getByRole("button", { name: "Keep my account" }).click();
    await page.getByRole("button", { name: "Use passkey" }).click();
    await expect(page.getByRole("button", { name: `@${P.handle}` })).toBeVisible();
  });
  await mailFor(P.email, (m) => m.subject === "Your Musubi account will not be deleted");
  flow.check("the account is live again", true, deletedAt() === null);
  flow.check("the handle is back", P.handle, handleNow() ?? "");
  flow.check("the passkey stayed", 1, passkeys());
  flow.check("the Pulse enrolment is open again", true, enrolmentOpen());
  flow.check("the wedding is untouched", true, weddingDeletedAt() === null);
  flow.check("the wedding keeps its owner seat", 1, ownerSeats());

  // -------------------------------------------------------------------------
  // The second deletion, of everything; then a sign-in started from cire's
  // organiser portal while still signed in to Musubi: the window screen at
  // once, and after Keep my account the sign-in carries on into cire.
  // -------------------------------------------------------------------------
  await deleteEverything("delete again, choosing to delete everything");
  // `@shared/ui`'s drawn Checkbox keeps Musubi's 6px small corner: Musubi
  // rounds its menu rows at 8px through their own role, never by raising the
  // small corner, which would turn this 16px box round.
  flow.check("delete everything: the drawn box keeps the 6px small corner", "6px", boxCorner ?? "");
  flow.check("delete everything stores no answers", true, storedChoices() === null);
  const second = (
    await mailFor(P.email, (m) => m.text.includes("so Cire deletes this as soon as it can"))
  ).find((m) => m.text.includes("so Cire deletes this as soon as it can"));
  flow.check(
    "the second scheduled email says cire deletes the wedding as soon as it can",
    "Your Musubi account is scheduled for deletion",
    second?.subject ?? "",
  );
  flow.check(
    "the second scheduled email gives the payout line its own words, not a deletion",
    true,
    second?.text.includes(
      `You connected the Stripe account for money gifts on "${P.payoutWedding.name}". Once your account is deleted, guests cannot give money there until another owner connects an account. To avoid that, hand money gifts to another owner in Cire first.\n  Guests cannot give money on this wedding from when your account is deleted`,
    ) ?? false,
  );

  await flow.step("cire: start a sign-in while signed in to Musubi", async () => {
    await page.goto(`${ORIGINS.cireHost}/login/`);
    await page.getByRole("button", { name: "Continue with musubi" }).click();
    await expect(page.getByRole("heading", { name: WINDOW_HEADING })).toBeVisible();
  });
  flow.check(
    "the window screen on /authorize says the person is not signed in to Cire",
    true,
    await page.getByText("You're not signed in to Cire.", { exact: false }).isVisible(),
  );
  flow.check("no code was issued for the account in the second window", 0, codes());
  flow.check(
    "cire holds no organiser session for the person",
    false,
    (await cookieNamed(context, ORIGINS.cireApi, "cire_org_session")) !== undefined,
  );

  const listsBeforeKeep = flow.count("GET osn-api /profiles/list");
  await flow.step("keep the account on /authorize, then allow cire", async () => {
    await page.getByRole("button", { name: "Keep my account" }).click();
    await page.getByRole("button", { name: "Use passkey" }).click();
    // The portal's list read is the flow's only one, and the deletion below
    // leaves the page; awaited here, it is in the record on every run.
    const listRead = page.waitForResponse(
      (r) =>
        r.request().method() === "GET" &&
        r.url().startsWith(ORIGINS.cireApi) &&
        new URL(r.url()).pathname === "/api/organiser/weddings",
    );
    await page.getByRole("button", { name: "Allow" }).click();
    await expect(page).toHaveURL(`${ORIGINS.cireHost}/#/weddings`);
    await listRead;
  });
  await mailFor(P.email, (m) => m.subject === "Your Musubi account will not be deleted");
  flow.check("kept on /authorize, the account is live again", true, deletedAt() === null);
  // The consent context lists the profiles for the page; the deletion
  // screen's own session lists none, before the keep or after it.
  flow.check(
    "the keep on /authorize lists no profiles",
    0,
    flow.count("GET osn-api /profiles/list") - listsBeforeKeep,
  );
  flow.check("cire's two legs went from the flow's own address", 2, cireLegs.sent());
  const organiserCookie = await cookieNamed(context, ORIGINS.cireApi, "cire_org_session");
  flow.check("signed in to cire after the keep", true, organiserCookie !== undefined);
  flow.check("cire holds one organiser session for the person", 1, leaverOrganiserSessions());

  // -------------------------------------------------------------------------
  // The third deletion, of everything again, and the end of the window.
  // -------------------------------------------------------------------------
  await deleteEverything("delete a third time, choosing to delete everything");
  flow.check("the third deletion stores no answers either", true, storedChoices() === null);
  // The person has signed in to cire through Musubi now, so the deletion ends
  // their organiser session there too, in the background.
  await flow.step("cire ends the person's organiser session", () =>
    expect.poll(leaverOrganiserSessions, { timeout: 10_000 }).toBe(0),
  );
  flow.check("cire holds no organiser session for the person now", 0, leaverOrganiserSessions());

  // A gift on the wedding is disputed, so cire's purge holds the wedding once
  // the erasure deletes it, and cire reports it as kept. Two writes, a
  // household and its gift; each throws unless its one row went in.
  await flow.step("a gift on the wedding is disputed", async () => {
    const now = Math.floor(suiteNow() / 1000);
    writeRow(
      DB_FILES.cire,
      "INSERT INTO families (id, wedding_id, public_id, family_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      LEAVER_HOUSEHOLD,
      P.wedding.id,
      "E2E-LEAVER-HOUSEHOLD",
      "Household",
      now,
      now,
    );
    writeRow(
      DB_FILES.cire,
      "INSERT INTO registry_contributions (id, wedding_id, family_id, status, amount_minor, currency, created_at, updated_at) VALUES (?, ?, ?, 'disputed', 5000, 'AUD', ?, ?)",
      "rcon_e2e_leaver_disputed",
      P.wedding.id,
      LEAVER_HOUSEHOLD,
      now,
      now,
    );
  });

  // The suite's clock runs in real time, so the job's window is moved instead:
  // one write, while the flow sends nothing; it throws unless the one job
  // moved. The sweeper finds it due.
  await flow.step("move the job past its window", async () =>
    writeRow(
      DB_FILES.osn,
      "UPDATE deletion_jobs SET hard_delete_at = ? WHERE account_id = ?",
      Math.floor(suiteNow() / 1000) - 1,
      P.accountId,
    ),
  );

  const deleted = await flow.step("the sweeps erase the account", async () => {
    const mail = await mailFor(
      P.email,
      (m) => m.subject === "Your Musubi account has been deleted",
    );
    return mail.find((m) => m.subject === "Your Musubi account has been deleted");
  });
  flow.check(
    "the deleted email says it cannot be brought back",
    true,
    deleted?.text.includes("cannot be brought back") ?? false,
  );
  flow.check(
    "the deleted email names the held handle",
    true,
    deleted?.text.includes(`@${P.handle} is released on`) ?? false,
  );
  flow.check(
    "the deleted email lists the wedding cire holds while its gift settles",
    true,
    deleted?.text.includes(
      "- Cire: A deleted wedding you owned, kept until a payment or gift for it settles, then erased in Cire's daily clean-up.",
    ) ?? false,
  );
  flow.check("the account is gone", false, accountExists());
  flow.check("the wedding is deleted", true, weddingDeletedAt() !== null);
  flow.check("the wedding has no seat of theirs", 0, ownerSeats());
  flow.check(
    "the wedding names no profile of theirs as its deleter",
    "none",
    weddingDeleter() ?? "none",
  );

  // The payout wedding stays with the heir, its account's holder gone; the
  // heir is told once, by name of no one.
  const payoutSubject = `Money gifts on ${P.payoutWedding.name} need a new Stripe account`;
  const payoutMails = (await mailFor(P.heir.email, (m) => m.subject === payoutSubject)).filter(
    (m) => m.subject === payoutSubject,
  );
  flow.check("the heir is told once that money gifts need a new account", 1, payoutMails.length);
  flow.check(
    "the heir's payout email names no one",
    true,
    // By handle as OSN shows it, and by name: the wedding's id holds the
    // handle's letters.
    !payoutMails.some((m) => m.text.includes(`@${P.handle}`) || m.text.includes(P.name)),
  );
  flow.check(
    "the heir's payout email links the wedding's Money gifts",
    true,
    payoutMails[0]?.text.includes(
      `${ORIGINS.cireHost}/#/w/${P.payoutWedding.id}/registry/settings`,
    ) ?? false,
  );
  flow.check(
    "the person was sent no payout email",
    0,
    (await mailFor(P.email)).filter((m) => m.subject === payoutSubject).length,
  );
  const payout = payoutWedding();
  flow.check("the payout wedding stays live", true, payout.deletedAt === null);
  flow.check("the heir is the payout wedding's one owner", P.heir.profileId, payout.owners);
  flow.check("the payout wedding's account is held by no one", "none", payout.holder ?? "none");

  // -------------------------------------------------------------------------
  // The organisation passed to its admin, who declines it from the email.
  // -------------------------------------------------------------------------
  const heirMail = (
    await mailFor(P.heir.email, (m) => m.subject === "You now own an organisation on Musubi")
  ).find((m) => m.subject === "You now own an organisation on Musubi");
  const declineUrl = `${ORIGINS.musubi}/organisations/${P.organisation.handle}?decline=1`;
  flow.check(
    "the heir's email carries the link to decline it",
    true,
    heirMail?.text.includes(declineUrl) ?? false,
  );
  flow.check("the organisation passed to the heir", P.heir.profileId, ownerOfOrganisation());

  const heirContext = await browser.newContext();
  await callOsnApiFrom(heirContext, ACCOUNT_DELETION_ADDRESS);
  const heirPage = await flow.newPage(heirContext);
  await flow.step("heir: decline it from the email's link", async () => {
    await heirContext.addCookies([
      {
        name: "osn_session",
        value: P.heir.session.token,
        url: ORIGINS.osnApi,
        httpOnly: true,
        sameSite: "Lax",
      },
      { name: "osn_has_session", value: "1", url: ORIGINS.osnApi, sameSite: "Lax" },
    ]);
    await heirPage.goto(declineUrl);
    await expect(
      heirPage.getByRole("heading", { name: "This organisation passed to you" }),
    ).toBeVisible();
    // The list the decline lands on reads the heir's organisations. The
    // context closes once that read has answered, so every run records it.
    const listed = heirPage.waitForResponse((r) => {
      const url = new URL(r.url());
      return (
        url.origin === ORIGINS.osnApi &&
        url.pathname === "/organisations" &&
        r.request().method() === "GET"
      );
    });
    await heirPage.getByRole("button", { name: "Decline" }).click();
    await expect(heirPage).toHaveURL(`${ORIGINS.musubi}/organisations`);
    await listed;
  });
  await heirContext.close();
  flow.check(
    "the organisation passed on to the next member",
    P.member.profileId,
    ownerOfOrganisation(),
  );
  const nextMail = (
    await mailFor(P.member.email, (m) => m.subject === "You now own an organisation on Musubi")
  ).find((m) => m.subject === "You now own an organisation on Musubi");
  flow.check(
    "the next member's email says the one before declined it",
    true,
    nextMail?.text.includes("declined it") ?? false,
  );

  const handleFree = await flow.step("the handle is held", async () => {
    const url = `${ORIGINS.osnApi}/handle/${P.handle}`;
    const response = await page.context().request.get(url, { headers: { Origin: ORIGINS.musubi } });
    flow.recordRequest("GET", url, response.status());
    return ((await response.json()) as { available?: boolean }).available;
  });
  flow.check("nobody can register the handle", false, handleFree ?? true);
});

// ---------------------------------------------------------------------------
// Reads of the stack's databases, read-only, one query each.
// ---------------------------------------------------------------------------

function deletedAt(): number | null {
  return (
    queryOne<{ deleted_at: number | null }>(
      DB_FILES.osn,
      "SELECT deleted_at FROM accounts WHERE id = ?",
      P.accountId,
    )?.deleted_at ?? null
  );
}

function hardDeleteAt(): number {
  return (
    queryOne<{ hard_delete_at: number }>(
      DB_FILES.osn,
      "SELECT hard_delete_at FROM deletion_jobs WHERE account_id = ?",
      P.accountId,
    )?.hard_delete_at ?? 0
  );
}

/** "23 November 2026": the UTC day, as the account-deletion emails write it. */
function utcDay(unixSeconds: number): string {
  const at = new Date(unixSeconds * 1_000);
  const month = new Intl.DateTimeFormat("en-GB", { month: "long", timeZone: "UTC" }).format(at);
  return `${at.getUTCDate()} ${month} ${at.getUTCFullYear()}`;
}

function ownerOfOrganisation(): string {
  return (
    queryOne<{ owner_id: string }>(
      DB_FILES.osn,
      "SELECT owner_id FROM organisations WHERE id = ?",
      P.organisation.id,
    )?.owner_id ?? ""
  );
}

function accountExists(): boolean {
  return queryOne(DB_FILES.osn, "SELECT id FROM accounts WHERE id = ?", P.accountId) !== undefined;
}

function handleNow(): string | undefined {
  return queryOne<{ handle: string }>(
    DB_FILES.osn,
    "SELECT handle FROM users WHERE id = ?",
    P.profileId,
  )?.handle;
}

function storedChoices(): string | null {
  return (
    queryOne<{ choices: string | null }>(
      DB_FILES.osn,
      "SELECT choices FROM deletion_jobs WHERE account_id = ?",
      P.accountId,
    )?.choices ?? null
  );
}

function passkeys(): number {
  return (
    queryOne<{ n: number }>(
      DB_FILES.osn,
      "SELECT COUNT(*) AS n FROM passkeys WHERE account_id = ?",
      P.accountId,
    )?.n ?? 0
  );
}

function enrolmentOpen(): boolean {
  const row = queryOne<{ left_at: number | null }>(
    DB_FILES.osn,
    "SELECT left_at FROM app_enrollments WHERE id = ?",
    P.enrolmentId,
  );
  return row !== undefined && row.left_at === null;
}

function weddingDeletedAt(): number | null {
  return (
    queryOne<{ deleted_at: number | null }>(
      DB_FILES.cire,
      "SELECT deleted_at FROM weddings WHERE id = ?",
      P.wedding.id,
    )?.deleted_at ?? null
  );
}

function weddingDeleter(): string | null {
  return (
    queryOne<{ deleted_by: string | null }>(
      DB_FILES.cire,
      "SELECT deleted_by_osn_profile_id AS deleted_by FROM weddings WHERE id = ?",
      P.wedding.id,
    )?.deleted_by ?? null
  );
}

/** Authorization codes osn-api holds for the account: issued and not yet redeemed. */
function codes(): number {
  return (
    queryOne<{ n: number }>(
      DB_FILES.osn,
      "SELECT COUNT(*) AS n FROM oauth_authorization_codes WHERE account_id = ?",
      P.accountId,
    )?.n ?? 0
  );
}

function consents(): number {
  return (
    queryOne<{ n: number }>(
      DB_FILES.osn,
      "SELECT COUNT(*) AS n FROM oauth_consents WHERE account_id = ?",
      P.accountId,
    )?.n ?? 0
  );
}

function leaverOrganiserSessions(): number {
  return (
    queryOne<{ n: number }>(
      DB_FILES.cire,
      "SELECT COUNT(*) AS n FROM organiser_sessions WHERE osn_profile_id = ?",
      P.profileId,
    )?.n ?? 0
  );
}

/** The payout wedding as the erasure leaves it: its delete time, owners and account holder. */
function payoutWedding(): { deletedAt: number | null; owners: string; holder: string | null } {
  const row = queryOne<{ deletedAt: number | null; owners: string; holder: string | null }>(
    DB_FILES.cire,
    `SELECT w.deleted_at AS deletedAt,
            (SELECT group_concat(osn_profile_id) FROM wedding_hosts WHERE wedding_id = w.id AND role = 'owner') AS owners,
            (SELECT stripe_connected_by_osn_profile_id FROM registry_settings WHERE wedding_id = w.id) AS holder
       FROM weddings w WHERE w.id = ?`,
    P.payoutWedding.id,
  );
  return row ?? { deletedAt: -1, owners: "", holder: "missing" };
}

function ownerSeats(): number {
  return (
    queryOne<{ n: number }>(
      DB_FILES.cire,
      "SELECT COUNT(*) AS n FROM wedding_hosts WHERE wedding_id = ? AND osn_profile_id = ? AND role = 'owner'",
      P.wedding.id,
      P.profileId,
    )?.n ?? 0
  );
}
