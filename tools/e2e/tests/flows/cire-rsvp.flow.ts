/**
 * Cire: a guest opens the seeded wedding's invite with their family code and
 * RSVPs, and the reply lands in cire-api's database.
 *
 * The guest session cookie comes from cire-api (`localhost:8787`) on the
 * invite site's (`localhost:4321`) cross-origin claim, and the RSVP is only
 * accepted if that cookie rides on the save.
 */

import { CIRE_GUEST, DB_FILES, ORIGINS } from "../../src/config";
import { cookieNamed, expect, onSuiteClock, queryOne, test } from "../support/fixtures";

/** The seeded ceremony Ada is invited to (`cire/db/seed/data/events.ts`). */
const CEREMONY_ID = "9f7a2c14-1b3d-4e5f-8a01-000000000001";

test("cire-rsvp", async ({ page, context, flow }) => {
  await flow.step("open the invite", async () => {
    await page.goto(`${ORIGINS.cireInvites}/${CIRE_GUEST.slug}`);
    await expect(page.getByLabel("Invitation code")).toBeVisible();
  });

  await flow.step("decline optional storage", async () => {
    // The consent prompt is an idle-hydrated island: it appears once the page
    // settles, so wait for it rather than racing it.
    const prompt = page.getByRole("dialog", { name: "Privacy choices" });
    await expect(prompt).toBeVisible({ timeout: 60_000 });
    await prompt.getByRole("button", { name: "Reject all" }).click();
    await expect(prompt).toBeHidden();
  });

  await flow.step("enter the family code", async () => {
    await page.getByLabel("Invitation code").fill(CIRE_GUEST.code);
    await expect(page.getByRole("button", { name: "Open Invitation" })).toBeEnabled();
    await page.getByRole("button", { name: "Open Invitation" }).click();
    await expect(page.getByText(CIRE_GUEST.guestName).first()).toBeVisible();
  });

  const cookie = await cookieNamed(context, ORIGINS.cireApi, "cire_session");
  flow.check("cire_session cookie set by cire-api", true, cookie !== undefined);
  flow.check("cire_session is HttpOnly", true, cookie?.httpOnly ?? false);

  await flow.step("RSVP attending", async () => {
    await page
      .getByRole("article")
      .filter({ has: page.getByRole("heading", { name: "Catholic Ceremony" }) })
      .getByRole("button", { name: "Respond" })
      .click();
    await page.getByRole("button", { name: "Attending", exact: true }).first().click();
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByRole("button", { name: "Saved" })).toBeVisible();
  });

  const row = queryOne<{ status: string; created_at: number }>(
    DB_FILES.cire,
    `SELECT r.status, r.created_at FROM rsvps r
       JOIN guests g ON g.id = r.guest_id
       JOIN families f ON f.id = g.family_id
      WHERE f.public_id = ? AND g.first_name = ? AND r.event_id = ?`,
    CIRE_GUEST.code,
    CIRE_GUEST.guestName,
    CEREMONY_ID,
  );
  flow.check("rsvps row for Ada at the ceremony", "attending", row?.status ?? "missing");
  flow.check("rsvps row written on the suite clock", true, onSuiteClock(row?.created_at));
});
