/**
 * Cire: a household of several opens its invite, says which member is
 * answering ("Who are you?"), and replies for two members. Each reply records
 * who sent it, and the household sees "Answered by" under both. Then a second
 * tab says "Not you?" and chooses someone else: the first tab's next save is
 * refused rather than recorded under a member it never showed, and the page
 * asks "Who are you?" again before the save goes through.
 *
 * Then the other member, in another tab, sees the address the hosts added for
 * them; this tab's address save, still as the first member, is refused and the
 * page asks "Who are you?" again. Answering again, the member gives an address
 * for wedding emails, ticking the consent box, corrects it, and removes it: the
 * row records the guest's own consent, and the removal clears it and records
 * a withdrawal for that seat alone, since anyone with the household code could
 * have typed it; giving the address back clears that withdrawal. Until the
 * address is one and the box is ticked, the save button stays focusable and
 * says which is missing; the removal's note is announced from a status region
 * already on the page. Last, the other member removes the address the hosts
 * added, which records that seat's opt-out for the wedding, a hash of the
 * wedding and the address, on the suppression list.
 *
 * The stack runs with `cire.account-linking` off (no GrowthBook key) and no
 * musubi bridge, so this is the guest experience with the flag off: the member
 * step and its attribution, and no musubi link box. That the flag, and not the
 * missing bridge, hides the box is pinned in cire-api's own tests.
 */

import { createHash } from "node:crypto";

import type { Request, Route } from "@playwright/test";

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
    await expect(page.getByRole("button", { name: "Open invitation" })).toBeEnabled();
    // Exactly the claim: `/api/claim/member` and `/api/claim/session` share the prefix.
    const response = page.waitForResponse(
      (r) => r.url() === `${ORIGINS.cireApi}/api/claim` && r.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Open invitation" }).click();
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

  await flow.step(
    `another tab says it is ${CIRE_HOUSEHOLD.otherMember}, and sees the address the hosts added`,
    async () => {
      const other = await flow.newPage(context);
      await other.goto(`${ORIGINS.cireInvites}/${CIRE_HOUSEHOLD.slug}`);
      await expect(other.getByText(`Answering as ${CIRE_HOUSEHOLD.member}`)).toBeVisible({
        timeout: 60_000,
      });
      await other.getByRole("button", { name: "Not you?" }).click();
      const group = other.getByRole("group", { name: "Who are you?" });
      await group.getByRole("button", { name: CIRE_HOUSEHOLD.otherMember, exact: true }).click();
      await expect(other.getByText(`Answering as ${CIRE_HOUSEHOLD.otherMember}`)).toBeVisible();
      const box = other.getByRole("region", { name: "Wedding emails" });
      await expect(box.getByText(CIRE_HOUSEHOLD.otherMemberEmail)).toBeVisible();
      await expect(box.getByText("Your hosts added this.", { exact: false })).toBeVisible();
      await other.close();
    },
  );

  const staleSave = await flow.step(
    `this tab's address save, still as ${CIRE_HOUSEHOLD.member}, is refused`,
    async () => {
      const field = emailBox.getByLabel(`Your email, ${CIRE_HOUSEHOLD.member}`);
      const addEmail = emailBox.getByRole("button", { name: "Add email" });
      let puts = 0;
      const countPut = (r: Request) => {
        if (r.url() === `${ORIGINS.cireApi}/api/claim/member/email` && r.method() === "PUT") {
          puts += 1;
        }
      };
      page.on("request", countPut);
      try {
        await expect(
          emailBox.getByText("Optional. Add your email", { exact: false }),
        ).toBeVisible();
        // The button names what blocks it: the address, the consent box, or both.
        await expect(addEmail).toHaveAccessibleDescription(
          "To save, enter your email address and tick the box above.",
        );
        // While the guest is still typing, only the button names the problem.
        // Once focus leaves the field, the field names it too.
        const invalidSentence = emailBox.getByText("look like one email address", {
          exact: false,
        });
        await field.fill("cleo@");
        await expect(field).toBeFocused();
        await expect(addEmail).toHaveAccessibleDescription(
          "To save, check your email address and tick the box above.",
        );
        await expect(invalidSentence).toHaveCount(0);
        await expect(field).not.toHaveAttribute("aria-invalid", "true");
        await field.blur();
        await expect(field).toHaveAttribute("aria-invalid", "true");
        await expect(invalidSentence).toBeVisible();
        await expect(field).toHaveAccessibleDescription(/look like one email address/);
        await field.fill(CIRE_HOUSEHOLD.email);
        await expect(field).not.toHaveAttribute("aria-invalid", "true");
        await expect(invalidSentence).toHaveCount(0);
        // Nothing is stored until the guest ticks the consent box. The button
        // stays in the tab order, says why, and a press does nothing.
        await expect(addEmail).toHaveAttribute("aria-disabled", "true");
        await expect(addEmail).not.toHaveAttribute("disabled");
        await expect(addEmail).toHaveAccessibleDescription("To save, tick the box above.");
        await addEmail.click({ force: true });
        await field.press("Enter");
        await emailBox.getByRole("checkbox", { name: /emails about this wedding/ }).check();
        await field.fill("");
        await expect(addEmail).toHaveAccessibleDescription("To save, enter your email address.");
        await field.fill("cleo@");
        await expect(addEmail).toHaveAccessibleDescription("To save, check your email address.");
        await field.fill(CIRE_HOUSEHOLD.email);
        await expect(addEmail).not.toHaveAttribute("aria-disabled", "true");
        const response = emailCall("PUT");
        await addEmail.click();
        const res = await response;
        const body = (await res.json()) as { error?: unknown };
        await expect(whoAreYou).toBeVisible();
        return { refused: `${res.status()} ${String(body.error)}`, puts };
      } finally {
        page.off("request", countPut);
      }
    },
  );
  flow.check(
    "an address save under a member the session no longer holds",
    "409 member_changed",
    staleSave.refused,
  );
  flow.check("a press on the blocked button sends nothing; the save sends one", 1, staleSave.puts);

  await flow.step(`answer as ${CIRE_HOUSEHOLD.member} once more`, async () => {
    await whoAreYou.getByRole("button", { name: CIRE_HOUSEHOLD.member, exact: true }).click();
    await expect(page.getByText(`Answering as ${CIRE_HOUSEHOLD.member}`)).toBeVisible();
  });

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

  // A refused or failed request must show a message and leave the stored
  // address alone. Each step routes one request, then unroutes.
  const storedAddress = () =>
    queryOne<{ email: string | null }>(
      DB_FILES.cire,
      `SELECT g.email FROM guests g JOIN families f ON f.id = g.family_id
        WHERE f.public_id = ? AND g.first_name = ?`,
      CIRE_HOUSEHOLD.code,
      CIRE_HOUSEHOLD.member,
    )?.email ?? "none";
  const emailUrl = `${ORIGINS.cireApi}/api/claim/member/email`;

  const outdated = await flow.step(
    `${CIRE_HOUSEHOLD.member}'s save from a page with older wording is refused`,
    async () => {
      const handler = async (route: Route) => {
        if (route.request().method() !== "PUT") return route.fallback();
        const body = route.request().postDataJSON() as Record<string, unknown>;
        return route.continue({
          postData: JSON.stringify({ ...body, consentVersion: "guest-email-2020-01-01" }),
        });
      };
      await page.route(emailUrl, handler);
      try {
        await emailBox.getByRole("button", { name: "Change email" }).click();
        await emailBox
          .getByLabel(`Your email, ${CIRE_HOUSEHOLD.member}`)
          .fill(CIRE_HOUSEHOLD.correctedEmail);
        await emailBox.getByRole("checkbox", { name: /emails about this wedding/ }).check();
        const response = emailCall("PUT");
        await emailBox.getByRole("button", { name: "Use this email" }).click();
        const status = (await response).status();
        await expect(
          emailBox.getByText("This page is out of date", { exact: false }),
        ).toBeVisible();
        await emailBox.getByRole("button", { name: "Keep it as it is" }).click();
        return status;
      } finally {
        await page.unroute(emailUrl, handler);
      }
    },
  );
  flow.check("the older wording is refused as out of date", 422, outdated);
  flow.check(
    "the refused save leaves the address as it was",
    CIRE_HOUSEHOLD.email,
    storedAddress(),
  );

  await flow.step(`${CIRE_HOUSEHOLD.member}'s removal fails and says so`, async () => {
    const handler = async (route: Route) => {
      if (route.request().method() !== "DELETE") return route.fallback();
      return route.fulfill({ status: 500, contentType: "application/json", body: "{}" });
    };
    await page.route(emailUrl, handler);
    try {
      await emailBox.getByRole("button", { name: "Remove email" }).click();
      // An alert, so a screen reader hears the refusal the moment it appears.
      await expect(
        emailBox.getByRole("alert").filter({ hasText: "Couldn’t remove your email" }),
      ).toBeVisible();
      await expect(emailBox.getByText(CIRE_HOUSEHOLD.email)).toBeVisible();
    } finally {
      await page.unroute(emailUrl, handler);
    }
  });
  flow.check(
    "the failed removal leaves the address as it was",
    CIRE_HOUSEHOLD.email,
    storedAddress(),
  );

  // "Change email" opens the field on the stored address, and "Keep it as it
  // is" closes it again; each view takes focus from the button it replaced.
  const yourEmail = emailBox.getByLabel(`Your email, ${CIRE_HOUSEHOLD.member}`);
  const boxHeading = emailBox.getByRole("heading", { name: "Wedding emails" });
  await flow.step(`${CIRE_HOUSEHOLD.member} opens the address and keeps it`, async () => {
    await emailBox.getByRole("button", { name: "Change email" }).click();
    await expect(yourEmail).toBeFocused();
    await expect(yourEmail).toHaveValue(CIRE_HOUSEHOLD.email);
    await emailBox.getByRole("button", { name: "Keep it as it is" }).click();
    await expect(boxHeading).toBeFocused();
    await expect(emailBox.getByText(CIRE_HOUSEHOLD.email)).toBeVisible();
  });

  const corrected = await flow.step(`${CIRE_HOUSEHOLD.member} corrects the address`, async () => {
    await emailBox.getByRole("button", { name: "Change email" }).click();
    await yourEmail.fill(CIRE_HOUSEHOLD.correctedEmail);
    const useIt = emailBox.getByRole("button", { name: "Use this email" });
    // A correction is a new address, so it asks for consent again.
    await expect(useIt).toBeDisabled();
    await emailBox.getByRole("checkbox", { name: /emails about this wedding/ }).check();
    const response = emailCall("PUT");
    await useIt.click();
    const status = (await response).status();
    await expect(emailBox.getByText(CIRE_HOUSEHOLD.correctedEmail)).toBeVisible();
    await expect(boxHeading).toBeFocused();
    return status;
  });
  flow.check("the corrected address is saved", 200, corrected);
  const correctedRow = queryOne<{ email: string | null; source: string | null }>(
    DB_FILES.cire,
    `SELECT g.email, g.email_source AS source
       FROM guests g JOIN families f ON f.id = g.family_id
      WHERE f.public_id = ? AND g.first_name = ?`,
    CIRE_HOUSEHOLD.code,
    CIRE_HOUSEHOLD.member,
  );
  flow.check(
    "the correction replaces the address, still the guest's own",
    `${CIRE_HOUSEHOLD.correctedEmail} guest`,
    `${correctedRow?.email ?? "none"} ${correctedRow?.source ?? "none"}`,
  );

  const removed = await flow.step(`${CIRE_HOUSEHOLD.member} removes the address`, async () => {
    // The status region is on the page, empty, before the removal, so a
    // screen reader announces the note when it arrives.
    const note = emailBox.getByRole("status");
    await expect(note).toBeAttached();
    await expect(note).toBeEmpty();
    const response = emailCall("DELETE");
    await emailBox.getByRole("button", { name: "Remove email" }).click();
    const status = (await response).status();
    // The guest typed this address, so no opt-out backs a promise about it.
    await expect(note).toHaveText("Removed. We’ve deleted that address from your invitation.");
    await expect(emailBox.getByText("Removed.", { exact: false })).toBeVisible();
    // The note stands where the form's opening line was.
    await expect(emailBox.getByText("Optional. Add your email", { exact: false })).toBeHidden();
    await expect(boxHeading).toBeFocused();
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
  /** The suppression rows `firstName`'s seat made, in the household's wedding. */
  const optOutsOf = (firstName: string) =>
    queryOne<{
      n: number;
      reason: string | null;
      hash: string | null;
      weddingId: string;
    }>(
      DB_FILES.cire,
      `SELECT COUNT(*) AS n, MIN(s.reason) AS reason, MIN(s.email_hash) AS hash,
              MIN(f.wedding_id) AS weddingId
         FROM email_suppressions s
         JOIN guests g ON g.id = s.guest_id
         JOIN families f ON f.id = g.family_id
        WHERE f.public_id = ? AND g.first_name = ?`,
      CIRE_HOUSEHOLD.code,
      firstName,
    );
  const ownOptOut = optOutsOf(CIRE_HOUSEHOLD.member);
  flow.check(
    "a withdrawal for this seat only, for an address the guest typed",
    "1 guest_removed_own",
    `${ownOptOut?.n ?? 0} ${ownOptOut?.reason ?? "none"}`,
  );

  // Giving the address back clears the note, and the seat's own withdrawal.
  const givenBack = await flow.step(`${CIRE_HOUSEHOLD.member} gives the address back`, async () => {
    await emailBox
      .getByLabel(`Your email, ${CIRE_HOUSEHOLD.member}`)
      .fill(CIRE_HOUSEHOLD.correctedEmail);
    await emailBox.getByRole("checkbox", { name: /emails about this wedding/ }).check();
    const response = emailCall("PUT");
    await emailBox.getByRole("button", { name: "Add email" }).click();
    const status = (await response).status();
    await expect(emailBox.getByText(CIRE_HOUSEHOLD.correctedEmail)).toBeVisible();
    await expect(emailBox.getByRole("status")).toBeEmpty();
    return status;
  });
  flow.check("the address given back is saved", 200, givenBack);
  flow.check(
    "giving an address back clears the seat's own withdrawal of it",
    0,
    optOutsOf(CIRE_HOUSEHOLD.member)?.n ?? -1,
  );

  // The hosts attested to this address, so the guest's removal is their
  // opt-out for the wedding, and the note says so.
  const hostsRemoved = await flow.step(
    `another tab says it is ${CIRE_HOUSEHOLD.otherMember}, and removes the address the hosts added`,
    async () => {
      const other = await flow.newPage(context);
      await other.goto(`${ORIGINS.cireInvites}/${CIRE_HOUSEHOLD.slug}`);
      await expect(other.getByText(`Answering as ${CIRE_HOUSEHOLD.member}`)).toBeVisible({
        timeout: 60_000,
      });
      await other.getByRole("button", { name: "Not you?" }).click();
      const group = other.getByRole("group", { name: "Who are you?" });
      await group.getByRole("button", { name: CIRE_HOUSEHOLD.otherMember, exact: true }).click();
      await expect(other.getByText(`Answering as ${CIRE_HOUSEHOLD.otherMember}`)).toBeVisible();
      const box = other.getByRole("region", { name: "Wedding emails" });
      await expect(box.getByText(CIRE_HOUSEHOLD.otherMemberEmail)).toBeVisible();
      await expect(box.getByText("Your hosts added this.", { exact: false })).toBeVisible();
      const response = other.waitForResponse(
        (r) =>
          r.url() === `${ORIGINS.cireApi}/api/claim/member/email` &&
          r.request().method() === "DELETE",
      );
      await box.getByRole("button", { name: "Remove email" }).click();
      const status = (await response).status();
      await expect(box.getByRole("status")).toHaveText(
        "Removed. Your hosts won’t email that address about the wedding unless you add it again.",
      );
      await other.close();
      return status;
    },
  );
  flow.check("the hosts' address is removed", 200, hostsRemoved);
  const hostsOptOut = optOutsOf(CIRE_HOUSEHOLD.otherMember);
  flow.check(
    "one opt-out recorded for the seat whose hosts' address was removed",
    "1 guest_removed",
    `${hostsOptOut?.n ?? 0} ${hostsOptOut?.reason ?? "none"}`,
  );
  // Stored opt-outs outlive deploys, so the stored hash is checked against an
  // independent computation of SHA-256(wedding id ":" address).
  flow.check(
    "the opt-out holds the hash of the wedding and the address, not the address",
    createHash("sha256")
      .update(`${hostsOptOut?.weddingId ?? ""}:${CIRE_HOUSEHOLD.otherMemberEmail}`)
      .digest("hex"),
    hostsOptOut?.hash ?? "none",
  );
});
