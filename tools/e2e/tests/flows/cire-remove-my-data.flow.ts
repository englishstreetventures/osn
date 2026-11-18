/**
 * A host removes their Cire data and keeps their Musubi account, while
 * another person's wedding comes through untouched.
 *
 * `CIRE_REMOVAL_PERSON` is seeded: an account signed in to Musubi, with three
 * weddings in cire — one they own alone, one they share with the keeper, and
 * the keeper's own. The flow writes their cire organiser sessions, so it
 * spends none of the run's sign-in windows, and reaches osn-api from
 * `CIRE_REMOVAL_ADDRESS`, so its grants and step-ups spend their own windows.
 * It enrols the account's first passkey through osn-api, as Settings would;
 * the one step-up is that passkey, in the same page, which holds the virtual
 * authenticator.
 *
 * First, Musubi's account deletion: cire's open action for the wedding the
 * person alone owns links its download page; the flow follows that link and
 * downloads the wedding (the archive is the artifact), and the page offers
 * to add another owner. The deletion is left unconfirmed.
 *
 * Then cire's "Remove my Cire data": the screen lists the wedding to be
 * deleted and the one they leave; they answer, go to Musubi in the same tab,
 * confirm with the passkey and come back; Musubi's confirm page, opened
 * again, says the request has ended. A second browser holding a second
 * session of theirs and the code, but not the cookie that binds the
 * confirmation to the first browser, is refused. They remove their data: the
 * wedding they owned alone is deleted, their seat on the shared one goes and
 * the keeper keeps it and is mailed, the keeper's own wedding is untouched,
 * and every cire session of theirs ends while the keeper's stays.
 */

import { createHash } from "node:crypto";

import {
  CIRE_REMOVAL_ADDRESS,
  CIRE_REMOVAL_PERSON as P,
  DB_FILES,
  ORIGINS,
} from "../../src/config";
import {
  addVirtualAuthenticator,
  callOsnApiFrom,
  expect,
  mailFor,
  queryOne,
  test,
  writeRow,
} from "../support/fixtures";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/** A cire organiser session as cire's sign-in leaves it: the token's SHA-256, never the token. */
function writeOrganiserSession(
  id: string,
  token: string,
  profile: { profileId: string; handle: string; name: string; email: string },
) {
  const now = Math.floor(Date.now() / 1000);
  writeRow(
    DB_FILES.cire,
    "INSERT INTO organiser_sessions (id, token, osn_profile_id, osn_sub, email, handle, display_name, avatar_url, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)",
    id,
    sha256(token),
    profile.profileId,
    `sub_${profile.profileId}`,
    profile.email,
    profile.handle,
    profile.name,
    now + 24 * 60 * 60,
    now,
  );
}

const weddingDeletedAt = (id: string) =>
  queryOne<{ deleted_at: number | null }>(
    DB_FILES.cire,
    "SELECT deleted_at FROM weddings WHERE id = ?",
    id,
  )?.deleted_at ?? null;

const seatsOf = (id: string) =>
  (
    queryOne<{ seats: string | null }>(
      DB_FILES.cire,
      "SELECT group_concat(osn_profile_id || ':' || role) AS seats FROM (SELECT osn_profile_id, role FROM wedding_hosts WHERE wedding_id = ? ORDER BY osn_profile_id)",
      id,
    )?.seats ?? ""
  )
    .split(",")
    .filter(Boolean);

const cireSessions = (profileId: string) =>
  queryOne<{ n: number }>(
    DB_FILES.cire,
    "SELECT count(*) AS n FROM organiser_sessions WHERE osn_profile_id = ?",
    profileId,
  )?.n ?? 0;

test("cire-remove-my-data", async ({ page, context, browser, flow }) => {
  // A passkey enrolment, a download, a step-up and the removal.
  test.slow();
  await callOsnApiFrom(context, CIRE_REMOVAL_ADDRESS);
  const authenticator = await addVirtualAuthenticator(page);

  await flow.step(
    "hold the seeded Musubi session and the cire sessions, as sign-ins leave them",
    async () => {
      writeOrganiserSession("oss_e2e_remover", P.cireSessions[0], P);
      writeOrganiserSession("oss_e2e_remover_second", P.cireSessions[1], P);
      writeOrganiserSession("oss_e2e_keeper", P.keeper.cireSession, P.keeper);
      await context.addCookies([
        {
          name: "osn_session",
          value: P.session.token,
          url: ORIGINS.osnApi,
          httpOnly: true,
          sameSite: "Lax",
        },
        { name: "osn_has_session", value: "1", url: ORIGINS.osnApi, sameSite: "Lax" },
        {
          name: "cire_org_session",
          value: P.cireSessions[0],
          url: ORIGINS.cireApi,
          httpOnly: true,
          sameSite: "Lax",
        },
      ]);
    },
  );

  const token = await flow.step("open Musubi signed in", async () => {
    const granted = page.waitForResponse(
      (r) => r.url() === `${ORIGINS.osnApi}/token` && r.request().method() === "POST",
    );
    await page.goto(`${ORIGINS.musubi}/settings#account`);
    const body = (await (await granted).json()) as { access_token: string };
    await expect(page.getByRole("link", { name: "Delete account…" })).toBeVisible();
    return body.access_token;
  });

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

  // -------------------------------------------------------------------------
  // Musubi's account deletion: cire's open action leads to the download.
  // -------------------------------------------------------------------------
  const downloadPage = `${ORIGINS.cireHost}/#/w/${P.alone.id}/settings/export`;
  const openInCire = await flow.step(
    "find cire's open action in the account deletion",
    async () => {
      await page.getByRole("link", { name: "Delete account…" }).click();
      await page.getByRole("button", { name: "Continue" }).click();
      await expect(page.getByRole("heading", { name: "What needs an answer" })).toBeVisible();
      await expect(page.getByText(`You are the only owner of "${P.alone.name}"`)).toBeVisible();
      const link = page.getByRole("link", { name: "Open in Cire" });
      await expect(link).toHaveCount(1);
      return link.getAttribute("href");
    },
  );
  flow.check(
    "cire's action links the wedding's download page",
    downloadPage,
    openInCire ?? "no link",
  );

  const archive = await flow.step("follow it and download the wedding", async () => {
    // The link opens a new tab; the same page holds the authenticator, so it goes there.
    await page.goto(openInCire ?? downloadPage);
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download wedding" }).click();
    const file = await download;
    await expect(page.getByRole("status", { name: "Wedding downloaded" })).toBeVisible();
    return file.suggestedFilename();
  });
  flow.check("the archive is the wedding's", "cire-wedding-remover-alone-wedding.zip", archive);
  flow.check(
    "the download page offers to add another owner",
    true,
    await page.getByRole("link", { name: "add another owner" }).isVisible(),
  );

  // -------------------------------------------------------------------------
  // Remove my Cire data.
  // -------------------------------------------------------------------------
  const answer = page.getByRole("checkbox", { name: `Delete this wedding: ${P.alone.name}` });
  await flow.step("open Remove my Cire data from the account menu", async () => {
    await page.goto(`${ORIGINS.cireHost}/`);
    await page.getByRole("button", { name: "Account menu" }).click();
    await page.getByRole("menuitem", { name: "Remove my Cire data" }).click();
    await expect(
      page.getByRole("heading", { level: 2, name: "Remove your Cire data" }),
    ).toBeVisible();
    await expect(answer).toBeVisible();
  });
  flow.check(
    "the wedding they own alone is listed to be deleted",
    true,
    await page.getByText(P.alone.name).first().isVisible(),
  );
  flow.check(
    "the wedding they share is listed to leave",
    true,
    await page.getByText(P.shared.name).first().isVisible(),
  );
  flow.check(
    "the keeper's own wedding is not listed",
    0,
    await page.getByText(P.keeper.theirs.name).count(),
  );

  const { code, confirmPage } = await flow.step(
    "answer, and confirm it's them on Musubi",
    async () => {
      await answer.check();
      await page.getByRole("button", { name: "Confirm on Musubi" }).click();
      await page.waitForURL(`${ORIGINS.musubi}/confirm/**`);
      const confirmUrl = page.url();
      await expect(page.getByRole("heading", { name: "Remove your Cire data" })).toBeVisible();
      await page.getByRole("button", { name: "Confirm it's you" }).click();
      await page.getByRole("button", { name: "Use passkey" }).click();
      await page.waitForURL(`${ORIGINS.cireHost}/**`);
      await expect(page.getByText("Confirmed on Musubi.", { exact: false })).toBeVisible();
      return {
        code: await page.evaluate(() => window.sessionStorage.getItem("cire.removal.code")),
        confirmPage: confirmUrl,
      };
    },
  );
  flow.check("the code came back to the portal", true, typeof code === "string" && code.length > 0);
  flow.check("the code is gone from the address", false, page.url().includes("code="));
  flow.check("the answer was kept across the trip", true, await answer.isChecked());

  const reopened = await flow.step("open Musubi's confirm page again", async () => {
    const again = await page.context().newPage();
    try {
      await again.goto(confirmPage);
      const ended = again.getByRole("heading", { name: "This request has ended" });
      await expect(ended).toBeVisible();
      return {
        ended: await ended.isVisible(),
        confirmButtons: await again.getByRole("button", { name: "Confirm it's you" }).count(),
      };
    } finally {
      await again.close();
    }
  });
  flow.check("a confirmed request has ended", true, reopened.ended);
  flow.check("it cannot be confirmed twice", 0, reopened.confirmButtons);

  const elsewhere = await flow.step(
    "a second browser with the code and their second session, but not the cookie, is refused",
    async () => {
      const second = await browser.newContext();
      try {
        await second.addCookies([
          {
            name: "cire_org_session",
            value: P.cireSessions[1],
            url: ORIGINS.cireApi,
            httpOnly: true,
            sameSite: "Lax",
          },
        ]);
        const res = await second.request.delete(`${ORIGINS.cireApi}/api/organiser/account`, {
          headers: { origin: ORIGINS.cireHost },
          data: { code, deleteEverything: true },
        });
        const body = (await res.json()) as { error?: string };
        return { status: res.status(), error: body.error ?? "none" };
      } finally {
        await second.close();
      }
    },
  );
  flow.check("the second browser is refused", 403, elsewhere.status);
  flow.check("for want of this browser's confirmation", "confirmation_required", elsewhere.error);
  flow.check("nothing was removed by it", true, weddingDeletedAt(P.alone.id) === null);

  await flow.step("remove their Cire data", async () => {
    await page.getByRole("button", { name: "Remove my Cire data" }).click();
    await expect(page.getByRole("heading", { name: "Your Cire data is removed" })).toBeVisible();
  });

  flow.check(
    "the wedding they owned alone is deleted",
    true,
    weddingDeletedAt(P.alone.id) !== null,
  );
  flow.check("its seat is gone", "", seatsOf(P.alone.id).join(","));
  flow.check("the shared wedding stays", true, weddingDeletedAt(P.shared.id) === null);
  flow.check(
    "the keeper alone owns the shared wedding",
    `${P.keeper.profileId}:owner`,
    seatsOf(P.shared.id).join(","),
  );
  flow.check(
    "the keeper's own wedding is untouched",
    true,
    weddingDeletedAt(P.keeper.theirs.id) === null,
  );
  flow.check(
    "the keeper's own wedding keeps its seat",
    `${P.keeper.profileId}:owner`,
    seatsOf(P.keeper.theirs.id).join(","),
  );
  flow.check("every cire session of theirs is gone", 0, cireSessions(P.profileId));
  flow.check("the keeper's cire session stays", 1, cireSessions(P.keeper.profileId));

  const told = await mailFor(
    P.keeper.email,
    (m) => m.subject === `An owner change on ${P.shared.name}`,
  );
  flow.check(
    "the keeper is told the remover left",
    true,
    told.some((m) => m.text.includes(`left ${P.shared.name}`)),
  );
});
