/**
 * Cire: once the RSVP deadline has passed, a household that answered only in
 * part can still see what it sent — "RSVP given" on plain gold, with no fill
 * and no tick, because those mean every member answered.
 *
 * Bo answers the Hindu ceremony for himself while RSVPs are open; Cleo and Dot
 * do not. Then the browser's clock moves past the deadline and the invite
 * reloads, as in `cire-rsvp-after-deadline`. Sampleton is the seed's one
 * household where "someone replied" and "everyone replied" disagree, which is
 * what tells the any-reply rule from the all-replies one.
 */

import {
  CIRE_GUEST,
  CIRE_PART_GUEST,
  CIRE_RSVP_CLOSED_ISO,
  DB_FILES,
  ORIGINS,
} from "../../src/config";
import { expect, queryOne, test } from "../support/fixtures";

/** The seeded Hindu ceremony (`cire/db/seed/data/events.ts`). */
const HINDU_ID = "9f7a2c14-1b3d-4e5f-8a01-000000000003";

/** The Sampleton household's rows for the Hindu ceremony, by first name. */
function hinduReplies(): Record<string, string> {
  const rows: Array<{ first_name: string; status: string }> = [];
  for (const name of [CIRE_PART_GUEST.answering, ...CIRE_PART_GUEST.silent]) {
    const row = queryOne<{ first_name: string; status: string }>(
      DB_FILES.cire,
      `SELECT g.first_name, r.status FROM rsvps r
         JOIN guests g ON g.id = r.guest_id
         JOIN families f ON f.id = g.family_id
        WHERE f.public_id = ? AND g.first_name = ? AND r.event_id = ?`,
      CIRE_PART_GUEST.code,
      name,
      HINDU_ID,
    );
    if (row) rows.push(row);
  }
  return Object.fromEntries(rows.map((r) => [r.first_name, r.status]));
}

test("cire-rsvp-partial-after-deadline", async ({ page, flow }) => {
  const hindu = page
    .getByRole("article")
    .filter({ has: page.getByRole("heading", { name: "Hindu Ceremony" }) });
  // Chromium reads the hidden comma in each panel heading as its own piece.
  const sheet = page.getByRole("dialog", { name: /Hindu Ceremony$/ });
  const member = (name: string) => sheet.getByRole("group", { name: new RegExp(`^${name} `) });

  await flow.step("open the invite", async () => {
    await page.goto(`${ORIGINS.cireInvites}/${CIRE_GUEST.slug}`);
    await expect(page.getByLabel("Invitation code")).toBeVisible();
  });

  await flow.step("decline optional storage", async () => {
    const prompt = page.getByRole("dialog", { name: "Privacy choices" });
    await expect(prompt).toBeVisible({ timeout: 60_000 });
    await prompt.getByRole("button", { name: "Reject all" }).click();
    await expect(prompt).toBeHidden();
  });

  await flow.step("enter the family code", async () => {
    await page.getByLabel("Invitation code").fill(CIRE_PART_GUEST.code);
    await page.getByRole("button", { name: "Open Invitation" }).click();
    await expect(hindu).toBeVisible();
  });

  await flow.step("answer the Hindu ceremony for Bo alone", async () => {
    await hindu.getByRole("button", { name: "Respond" }).click();
    await member(CIRE_PART_GUEST.answering)
      .getByRole("button", { name: "Attending", exact: true })
      .click();
    await sheet.getByRole("button", { name: "Save" }).click();
    await expect(sheet.getByRole("button", { name: "Saved" })).toBeVisible();
    // A part reply before the deadline still asks for the rest.
    await expect(hindu.getByRole("button", { name: "Respond" })).toBeVisible();
  });

  const stored = hinduReplies();
  flow.check("rsvps row for Bo at the Hindu ceremony", "attending", stored["Bo"] ?? "missing");
  flow.check("no rsvps row for Cleo or Dot", 1, Object.keys(stored).length);

  await flow.step("move the browser past the deadline and reload", async () => {
    await page.clock.setSystemTime(Date.parse(CIRE_RSVP_CLOSED_ISO));
    await page.reload();
    await expect(hindu.getByText("RSVPs closed", { exact: true })).toBeVisible({
      timeout: 60_000,
    });
  });

  const given = hindu.getByRole("button", { name: "RSVP given" });
  await flow.step("the part-answered event reads RSVP given, unmarked", async () => {
    await expect(given).toBeVisible();
  });
  flow.check(
    "part reply shows no confirmation fill",
    "absent",
    (await given.getAttribute("data-rsvp-confirmed")) ?? "absent",
  );
  flow.check("part reply shows no tick", 0, await given.locator("svg").count());

  await flow.step("Event Details offers the reply", async () => {
    await hindu.getByRole("button", { name: "Event Details" }).click();
    await expect(sheet.getByRole("button", { name: "View your RSVP" })).toBeVisible();
  });
  flow.check(
    "details offer View your RSVP",
    1,
    await sheet.getByRole("button", { name: "View your RSVP" }).count(),
  );

  await flow.step("open the reply read-only", async () => {
    await sheet.getByRole("button", { name: "View your RSVP" }).click();
    await expect(
      member(CIRE_PART_GUEST.answering).getByText("Attending", { exact: true }),
    ).toBeVisible();
    for (const name of CIRE_PART_GUEST.silent) {
      await expect(member(name).getByText("No reply", { exact: true })).toBeVisible();
    }
  });
  flow.check(
    "read-only sheet has no Save",
    0,
    await sheet.getByRole("button", { name: "Save" }).count(),
  );
  // The sheet stays open: it is the flow's final screenshot.
});
