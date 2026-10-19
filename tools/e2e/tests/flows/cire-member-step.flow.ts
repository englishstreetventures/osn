/**
 * Cire: a household of several opens its invite, says which member is
 * answering ("Who are you?"), and replies for two members. Each reply records
 * who sent it, and the household sees "Answered by" under both.
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

test("cire-member-step", async ({ page, flow }) => {
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

  const reception = page
    .getByRole("article")
    .filter({ has: page.getByRole("heading", { name: "Reception", exact: true }) })
    .getByRole("button", { name: "Respond" });
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
  });

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
});
