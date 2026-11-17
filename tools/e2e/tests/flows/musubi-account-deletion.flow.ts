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
 * my data" works. Signed out and back in with the passkey, the same screen; "Keep my account" brings the
 * app back, with the handle, the passkey and the Pulse enrolment as they were
 * and the wedding untouched. Deleted again with "Delete everything", its job
 * is moved past its window — the suite's clock runs in real time — and the
 * stack's sweeper (every 2 s here) reaches Pulse and cire and erases the
 * account. The account is gone, the handle is held, the wedding is deleted,
 * and the account-deleted email reached the address it had. The person's
 * organisation passed to its admin, who opens the email's link signed in
 * through its own seeded session and declines it: it passes to the next
 * member, who is mailed in turn. Before any of it, "Send me a link" mails
 * the download page's address.
 *
 * The wedding's own download (`<cire host>/#/w/<id>/settings/export`) is not a
 * step here: that page is not on this branch's base. cire's preview link is
 * https only, so on this http stack the action carries no "Open in Cire" link.
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
  expect,
  mailFor,
  queryOne,
  suiteNow,
  test,
  writeRow,
} from "../support/fixtures";

test.use({ turnstile: true });

const WINDOW_HEADING = "Your account is set to be deleted";

test("musubi-account-deletion", async ({ page, context, browser, flow }) => {
  // Two step-ups, a sign-out and back, a keep, a second deletion and a sweep.
  test.slow();
  await callOsnApiFrom(context, ACCOUNT_DELETION_ADDRESS);
  const authenticator = await addVirtualAuthenticator(page);

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
    "no Cire link on an http stack",
    0,
    await page.getByRole("link", { name: "Open in Cire" }).count(),
  );

  await flow.step("answer the wedding: delete it with the account", async () => {
    // The box is visually hidden under its words, which are its label.
    await page.locator("label").filter({ has: weddingAnswer }).click();
    await expect(weddingAnswer).toBeChecked();
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByRole("textbox", { name: "Your handle" }).fill(P.handle);
  });

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
  // Signed out and back in: the window screen again. Keep the account.
  // -------------------------------------------------------------------------
  await flow.step("sign out from the window screen", async () => {
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(
      page.locator("aside, header").getByRole("button", { name: "Sign in" }),
    ).toBeVisible();
  });

  // The sign-in dialog offers the browser's passkeys as it opens (a
  // discoverable credential, `mediation: "conditional"`), and the virtual
  // authenticator answers at once: the sign-in a person makes by picking
  // their passkey from the browser's list.
  // Counted across the sign-in alone: a shell request still out when the
  // deletion was asked for may have been refused earlier.
  const profileListsBefore = flow.count("GET osn-api /profiles/list");
  await flow.step("sign in again with the passkey the browser offers", async () => {
    await page.locator("aside, header").getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("heading", { level: 1, name: WINDOW_HEADING })).toBeVisible();
  });
  flow.check(
    "signed in during the window, the pending session lists no profiles",
    0,
    flow.count("GET osn-api /profiles/list") - profileListsBefore,
  );

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
  // The second deletion, of everything, and the end of the window.
  // -------------------------------------------------------------------------
  await flow.step("delete again, choosing to delete everything", async () => {
    await page.goto(`${ORIGINS.musubi}/settings/delete-account`);
    await page.getByRole("button", { name: "Continue" }).click();
    const everything = page.getByRole("checkbox", { name: "Delete everything" });
    await page.locator("label").filter({ has: everything }).click();
    await expect(everything).toBeChecked();
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByRole("textbox", { name: "Your handle" }).fill(P.handle);
    await page.getByRole("button", { name: "Delete my account" }).click();
    await page.getByRole("button", { name: "Use passkey" }).click();
    await expect(page.getByRole("heading", { level: 1, name: WINDOW_HEADING })).toBeVisible();
  });
  flow.check("delete everything stores no answers", true, storedChoices() === null);
  const second = (
    await mailFor(P.email, (m) => m.text.includes("so Cire deletes this as soon as it can"))
  ).find((m) => m.text.includes("so Cire deletes this as soon as it can"));
  flow.check(
    "the second scheduled email says cire deletes the wedding as soon as it can",
    "Your Musubi account is scheduled for deletion",
    second?.subject ?? "",
  );

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
    deleted?.text.includes(`@${P.handle} is held until`) ?? false,
  );
  flow.check("the account is gone", false, accountExists());
  flow.check("the wedding is deleted", true, weddingDeletedAt() !== null);
  flow.check("the wedding has no seat of theirs", 0, ownerSeats());

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
    await heirPage.getByRole("button", { name: "Decline" }).click();
    await expect(heirPage).toHaveURL(`${ORIGINS.musubi}/organisations`);
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
