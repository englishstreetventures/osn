/**
 * Cire: a household of several opens its invite, says which member is
 * answering ("Who are you?"), and replies for two members. Each reply records
 * who sent it, and the household sees "Answered by" under both. Then a second
 * tab says "Not you?" and chooses someone else: the first tab's next save is
 * refused rather than recorded under a member it never showed, and the page
 * asks "Who are you?" again before the save goes through.
 *
 * Then the member gives an address for wedding emails, ticking the consent
 * box, and removes it again: the row records the guest's own consent, and the
 * removal clears it and records the opt-out on the suppression list.
 *
 * The stack runs with `cire.account-linking` off (no GrowthBook key) and no
 * musubi bridge, so this is the guest experience with the flag off: the member
 * step and its attribution, and no musubi link box. That the flag, and not the
 * missing bridge, hides the box is pinned in cire-api's own tests.
 */

import { CIRE_HOUSEHOLD, DB_FILES, ORIGINS } from "../../src/config";
import { expect, onSuiteClock, queryOne, test } from "../support/fixtures";

/** The seeded Reception (`cire/db/seed/data/events.ts`); Bo and Cleo are invited. */
const RECEPTION_ID = "9f7a2c14-1b3d-4e5f-8a01-000000000004";

/** The `accountLink.enabled` and `member` a cire-api answer carries, as JSON. */
interface MemberStepBody {
  member?: unknown;
  accountLink?: { enabled?: unknown };
}

test("cire-member-step", async ({ page, context, flow }) => {
  await flow.step("open the invite", async () => {
    await page.goto(`${ORIGINS.cireInvites}/${CIRE_HOUSEHOLD.slug}`);
    await expect(page.getByLabel("Invitation code")).toBeVisible();
  });

  await flow.step("decline optional storage", async () => {
    // The consent prompt is an idle-hydrated island: wait for it rather than race it.
    const prompt = page.getByRole("dialog", { name: "Privacy choices" });
    await expect(prompt).toBeVisible({ timeout: 60_000 });
    await prompt.getByRole("button", { name: "Reject all" }).click();
    await expect(prompt).toBeHidden();
  });

  const claimed = await flow.step("enter the family code", async () => {
    await page.getByLabel("Invitation code").fill(CIRE_HOUSEHOLD.code);
    await expect(page.getByRole("button", { name: "Open Invitation" })).toBeEnabled();
    // Exactly the claim: `/api/claim/member` and `/api/claim/session` share the prefix.
    const response = page.waitForResponse(
      (r) => r.url() === `${ORIGINS.cireApi}/api/claim` && r.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Open Invitation" }).click();
    return (await (await response).json()) as MemberStepBody;
  });
  flow.check("claim names no member yet", true, claimed.member === null);
  flow.check("claim offers no musubi link", false, claimed.accountLink?.enabled === true);

  const whoAreYou = page.getByRole("group", { name: "Who are you?" });
  await flow.step("see who can answer", async () => {
    await expect(whoAreYou).toBeVisible();
    for (const name of CIRE_HOUSEHOLD.members) {
      await expect(whoAreYou.getByRole("button", { name, exact: true })).toBeVisible();
    }
  });

  const chosen = await flow.step(`answer as ${CIRE_HOUSEHOLD.member}`, async () => {
    const response = page.waitForResponse(
      (r) => r.url() === `${ORIGINS.cireApi}/api/claim/member` && r.request().method() === "POST",
    );
    await whoAreYou.getByRole("button", { name: CIRE_HOUSEHOLD.member, exact: true }).click();
    const body = (await (await response).json()) as MemberStepBody;
    await expect(page.getByText(`Answering as ${CIRE_HOUSEHOLD.member}`)).toBeVisible();
    return body;
  });
  flow.check("member choice offers no musubi link", false, chosen.accountLink?.enabled === true);

  // "Respond" until every invited member has answered, "RSVP given" after;
  // either opens the sheet while RSVPs are open.
  const reception = page
    .getByRole("article")
    .filter({ has: page.getByRole("heading", { name: "Reception", exact: true }) })
    .getByRole("button", { name: /^(Respond|RSVP given)$/ });
  const sheet = page.getByRole("dialog");

  await flow.step("RSVP attending for both invited members", async () => {
    await reception.click();
    const attending = sheet.getByRole("button", { name: "Attending", exact: true });
    await expect(attending).toHaveCount(2);
    await attending.nth(0).click();
    await attending.nth(1).click();
    await sheet.getByRole("button", { name: "Save" }).click();
    await expect(sheet.getByRole("button", { name: "Saved" })).toBeVisible();
    // The sheet closes itself once the reply is in.
    await expect(sheet).toBeHidden();
  });

  flow.check(
    "no musubi link box on the page",
    0,
    await page.getByText("Link your musubi account").count(),
  );

  await flow.step("see who answered", async () => {
    await reception.click();
    // Under Bo's reply and Cleo's own: Cleo sent both.
    await expect(sheet.getByText(`Answered by ${CIRE_HOUSEHOLD.member}`)).toHaveCount(2);
    await sheet.getByRole("button", { name: "Cancel" }).click();
    await expect(sheet).toBeHidden();
  });

  await flow.step(`another tab says it is ${CIRE_HOUSEHOLD.otherMember}`, async () => {
    const other = await flow.newPage(context);
    await other.goto(`${ORIGINS.cireInvites}/${CIRE_HOUSEHOLD.slug}`);
    await expect(other.getByText(`Answering as ${CIRE_HOUSEHOLD.member}`)).toBeVisible({
      timeout: 60_000,
    });
    await other.getByRole("button", { name: "Not you?" }).click();
    const group = other.getByRole("group", { name: "Who are you?" });
    await expect(group).toBeVisible();
    await group.getByRole("button", { name: CIRE_HOUSEHOLD.otherMember, exact: true }).click();
    await expect(other.getByText(`Answering as ${CIRE_HOUSEHOLD.otherMember}`)).toBeVisible();
    await other.close();
  });

  const refused = await flow.step("this tab's next save is refused", async () => {
    // Still showing the member it read before the other tab chose.
    await expect(page.getByText(`Answering as ${CIRE_HOUSEHOLD.member}`)).toBeVisible();
    await reception.click();
    await sheet.getByRole("button", { name: "Not attending", exact: true }).first().click();
    const response = page.waitForResponse(
      (r) => r.url() === `${ORIGINS.cireApi}/api/rsvp` && r.request().method() === "POST",
    );
    await sheet.getByRole("button", { name: "Save" }).click();
    const res = await response;
    const body = (await res.json()) as { error?: unknown };
    await expect(
      sheet.getByText("Choose who you are under the welcome above, then reply.").first(),
    ).toBeVisible();
    return `${res.status()} ${String(body.error)}`;
  });
  flow.check("a save under a member the session no longer holds", "409 member_changed", refused);

  await flow.step(`answer as ${CIRE_HOUSEHOLD.member} again and save`, async () => {
    await sheet.getByRole("button", { name: "Cancel" }).click();
    await expect(sheet).toBeHidden();
    await whoAreYou.getByRole("button", { name: CIRE_HOUSEHOLD.member, exact: true }).click();
    await expect(page.getByText(`Answering as ${CIRE_HOUSEHOLD.member}`)).toBeVisible();
    await reception.click();
    await sheet.getByRole("button", { name: "Not attending", exact: true }).first().click();
    await sheet.getByRole("button", { name: "Save" }).click();
    await expect(sheet.getByRole("button", { name: "Saved" })).toBeVisible();
    await expect(sheet).toBeHidden();
  });

  const changed = queryOne<{ status: string; sender: string | null }>(
    DB_FILES.cire,
    `SELECT r.status, s.first_name AS sender
       FROM rsvps r
       JOIN guests g ON g.id = r.guest_id
       JOIN families f ON f.id = g.family_id
       LEFT JOIN guests s ON s.id = r.submitted_by_guest_id
      WHERE f.public_id = ? AND g.first_name = ? AND r.event_id = ?`,
    CIRE_HOUSEHOLD.code,
    CIRE_HOUSEHOLD.otherMember,
    RECEPTION_ID,
  );
  flow.check(
    `${CIRE_HOUSEHOLD.otherMember}'s changed reply, sent by ${CIRE_HOUSEHOLD.member}`,
    `declined by ${CIRE_HOUSEHOLD.member}`,
    `${changed?.status ?? "missing"} by ${changed?.sender ?? "nobody"}`,
  );

  // Names, never ids: the local seed mints fresh guest ids on every boot.
  const replies = queryOne<{
    replies: number;
    byMember: number;
    viaLink: number;
    createdAt: number;
  }>(
    DB_FILES.cire,
    `SELECT COUNT(*) AS replies,
            SUM(CASE WHEN s.first_name = ? THEN 1 ELSE 0 END) AS byMember,
            SUM(r.submitted_via_link) AS viaLink,
            MIN(r.created_at) AS createdAt
       FROM rsvps r
       JOIN guests g ON g.id = r.guest_id
       JOIN families f ON f.id = g.family_id
       LEFT JOIN guests s ON s.id = r.submitted_by_guest_id
      WHERE f.public_id = ? AND r.event_id = ?`,
    CIRE_HOUSEHOLD.member,
    CIRE_HOUSEHOLD.code,
    RECEPTION_ID,
  );
  flow.check("reception replies written for the household", 2, replies?.replies ?? 0);
  flow.check(
    `reception replies recorded as sent by ${CIRE_HOUSEHOLD.member}`,
    2,
    replies?.byMember ?? 0,
  );
  flow.check("no reply marked as sent through a musubi link", 0, replies?.viaLink ?? -1);
  flow.check(
    "reception replies written on the suite clock",
    true,
    onSuiteClock(replies?.createdAt),
  );

  const emailBox = page.getByRole("region", { name: "Wedding emails" });
  const emailCall = (method: "PUT" | "DELETE") =>
    page.waitForResponse(
      (r) =>
        r.url() === `${ORIGINS.cireApi}/api/claim/member/email` && r.request().method() === method,
    );

  const saved = await flow.step(`${CIRE_HOUSEHOLD.member} adds an email address`, async () => {
    await emailBox.getByLabel(`Your email, ${CIRE_HOUSEHOLD.member}`).fill(CIRE_HOUSEHOLD.email);
    await emailBox.getByRole("checkbox", { name: /emails about this wedding/ }).check();
    const response = emailCall("PUT");
    await emailBox.getByRole("button", { name: "Add email" }).click();
    const status = (await response).status();
    await expect(emailBox.getByText(CIRE_HOUSEHOLD.email)).toBeVisible();
    await expect(emailBox.getByText("You added this.", { exact: false })).toBeVisible();
    return status;
  });
  flow.check("the address is saved", 200, saved);

  const stored = queryOne<{
    email: string | null;
    source: string | null;
    version: string | null;
    consentAt: number | undefined;
  }>(
    DB_FILES.cire,
    `SELECT g.email, g.email_source AS source, g.email_consent_version AS version,
            g.email_consent_at AS consentAt
       FROM guests g JOIN families f ON f.id = g.family_id
      WHERE f.public_id = ? AND g.first_name = ?`,
    CIRE_HOUSEHOLD.code,
    CIRE_HOUSEHOLD.member,
  );
  flow.check(
    `${CIRE_HOUSEHOLD.member}'s address, given by the guest under the guest's consent`,
    `${CIRE_HOUSEHOLD.email} guest guest-email-`,
    `${stored?.email ?? "none"} ${stored?.source ?? "none"} ${stored?.version?.replace(/\d{4}-\d{2}-\d{2}$/, "") ?? "none"}`,
  );
  flow.check("consent recorded on the suite clock", true, onSuiteClock(stored?.consentAt));

  const removed = await flow.step(`${CIRE_HOUSEHOLD.member} removes the address`, async () => {
    const response = emailCall("DELETE");
    await emailBox.getByRole("button", { name: "Remove email" }).click();
    const status = (await response).status();
    await expect(emailBox.getByText("Removed.", { exact: false })).toBeVisible();
    return status;
  });
  flow.check("the address is removed", 200, removed);

  const after = queryOne<{ email: string | null; source: string | null; version: string | null }>(
    DB_FILES.cire,
    `SELECT g.email, g.email_source AS source, g.email_consent_version AS version
       FROM guests g JOIN families f ON f.id = g.family_id
      WHERE f.public_id = ? AND g.first_name = ?`,
    CIRE_HOUSEHOLD.code,
    CIRE_HOUSEHOLD.member,
  );
  flow.check(
    "nothing of the address or its consent is left on the guest",
    "none none none",
    `${after?.email ?? "none"} ${after?.source ?? "none"} ${after?.version ?? "none"}`,
  );
  const optOuts = queryOne<{ n: number; reason: string | null }>(
    DB_FILES.cire,
    `SELECT COUNT(*) AS n, MIN(s.reason) AS reason
       FROM email_suppressions s
       JOIN guests g ON g.id = s.guest_id
       JOIN families f ON f.id = g.family_id
      WHERE f.public_id = ? AND g.first_name = ?`,
    CIRE_HOUSEHOLD.code,
    CIRE_HOUSEHOLD.member,
  );
  flow.check(
    "one opt-out recorded for the seat",
    "1 guest_removed",
    `${optOuts?.n ?? 0} ${optOuts?.reason ?? "none"}`,
  );
});
