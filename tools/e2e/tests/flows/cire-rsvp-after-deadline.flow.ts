/**
 * Cire: once the RSVP deadline has passed, a guest can still see the reply
 * they sent, and an event they never answered offers no way to answer.
 *
 * Nori answers the Catholic ceremony while RSVPs are open. Then the browser's
 * clock moves past the wedding's deadline (`CIRE_RSVP_DEADLINE`, set on the
 * stack's cire-api) and the invite reloads. cire-api stays on the suite clock,
 * where RSVPs are still open, so what changes is only what the invite shows.
 * Whether the closed sheet can send anything is proven in
 * `cire/invites/tests/components/RsvpPanel.test.tsx`, not here.
 *
 * The wedding is on Ivory, which has no gift list. So once Nori is in, a second
 * tab opens the invitation on the same session: its gift band reads the list,
 * is told there is none (404), and never downloads the band or the gift-list
 * client. That tab is read only at the end, long after the 404 was handled.
 * `cire-registry-claimed` checks the opposite on a Gold wedding with a list.
 */

import {
  CIRE_GUEST,
  CIRE_LATE_GUEST,
  CIRE_RSVP_CLOSED_ISO,
  DB_FILES,
  ORIGINS,
} from "../../src/config";
import {
  expect,
  GIFT_BAND_MODULES,
  guestSitePaths,
  onSuiteClock,
  queryOne,
  test,
} from "../support/fixtures";

/** The seeded Catholic ceremony (`cire/db/seed/data/events.ts`). */
const CATHOLIC_ID = "9f7a2c14-1b3d-4e5f-8a01-000000000001";

/** The sample wedding's gift-list read, which its invitation's band makes. */
const LIST_URL = `${ORIGINS.cireApi}/api/invite/${CIRE_GUEST.slug}/registry`;

test("cire-rsvp-after-deadline", async ({ page, context, flow }) => {
  const card = (name: string) =>
    page.getByRole("article").filter({ has: page.getByRole("heading", { name }) });
  const catholic = card("Catholic Ceremony");
  const hindu = card("Hindu Ceremony");
  // Chromium names the heading "Your RSVP , Catholic Ceremony": the comma is a
  // visually hidden span, read as its own piece.
  const sheet = page.getByRole("dialog", { name: /^Your RSVP\s*,\s*Catholic Ceremony$/ });

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
    await page.getByLabel("Invitation code").fill(CIRE_LATE_GUEST.code);
    await page.getByRole("button", { name: "Open Invitation" }).click();
    await expect(page.getByText(CIRE_LATE_GUEST.guestName).first()).toBeVisible();
  });

  const tier = queryOne<{ tier: string }>(
    DB_FILES.cire,
    `SELECT tier FROM weddings WHERE slug = ?`,
    CIRE_GUEST.slug,
  );
  flow.check("the sample wedding's plan", "ivory", tier?.tier ?? "missing");

  const second = await flow.step("open the invitation in a second tab, to its foot", async () => {
    const tab = await flow.newPage(context);
    const paths = guestSitePaths(tab);
    // Armed before the page loads: the band reads as soon as it hydrates,
    // which can be before the scroll below brings it into range.
    const read = tab.waitForResponse((r) => r.url() === LIST_URL && r.request().method() === "GET");
    await tab.goto(`${ORIGINS.cireInvites}/${CIRE_GUEST.slug}`);
    // The session restores from the cookie: no code is entered here.
    await expect(tab.getByText(CIRE_LATE_GUEST.guestName).first()).toBeVisible({
      timeout: 60_000,
    });
    await tab.keyboard.press("End");
    return { tab, paths, list: (await read).status() };
  });
  flow.check("list read on an Ivory wedding", 404, second.list);

  await flow.step("answer the Catholic ceremony while RSVPs are open", async () => {
    await catholic.getByRole("button", { name: "Respond" }).click();
    await page.getByRole("button", { name: "Attending", exact: true }).first().click();
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByRole("button", { name: "Saved" })).toBeVisible();
    // The sheet closes itself, and the card marks the reply.
    await expect(catholic.getByRole("button", { name: "RSVP given" })).toBeVisible();
  });

  // The reply the read-only view shows later is the one the server stored.
  const row = queryOne<{ status: string; created_at: number }>(
    DB_FILES.cire,
    `SELECT r.status, r.created_at FROM rsvps r
       JOIN guests g ON g.id = r.guest_id
       JOIN families f ON f.id = g.family_id
      WHERE f.public_id = ? AND g.first_name = ? AND r.event_id = ?`,
    CIRE_LATE_GUEST.code,
    CIRE_LATE_GUEST.guestName,
    CATHOLIC_ID,
  );
  flow.check("rsvps row for Nori at the Catholic ceremony", "attending", row?.status ?? "missing");
  flow.check("rsvps row written on the suite clock", true, onSuiteClock(row?.created_at));

  await flow.step("move the browser past the deadline and reload", async () => {
    await page.clock.setSystemTime(Date.parse(CIRE_RSVP_CLOSED_ISO));
    await page.reload();
    await expect(catholic).toBeVisible({ timeout: 60_000 });
  });

  await flow.step(
    "the answered event keeps its reply, the other has no answer button",
    async () => {
      await expect(catholic.getByText("RSVPs closed", { exact: true })).toBeVisible();
      await expect(hindu.getByText("RSVPs closed", { exact: true })).toBeVisible();
      await expect(catholic.getByRole("button", { name: "RSVP given" })).toBeVisible();
      await expect(hindu.getByRole("button", { name: "Event Details" })).toBeVisible();
    },
  );

  const given = catholic.getByRole("button", { name: "RSVP given" });
  flow.check("answered card offers RSVP given", 1, await given.count());
  flow.check(
    "RSVP given carries no aria-disabled",
    "absent",
    (await given.getAttribute("aria-disabled")) ?? "absent",
  );
  flow.check(
    "unanswered card offers no answer button",
    0,
    await hindu.getByRole("button", { name: /^(Respond|RSVP given)$/ }).count(),
  );

  await flow.step("open the reply read-only", async () => {
    await given.click();
    await expect(sheet).toBeVisible();
    await expect(sheet.getByText(/^RSVPs closed on /)).toBeVisible();
    // The answer on file, written out where the answer buttons were.
    await expect(
      sheet.getByRole("group", { name: /Nori/ }).getByText("Attending", { exact: true }),
    ).toBeVisible();
    // The action bar's one button; the sheet's "×" is also named Close.
    await expect(sheet.getByText("Close", { exact: true })).toBeVisible();
  });

  flow.check(
    "closed sheet has no Save",
    0,
    await sheet.getByRole("button", { name: "Save" }).count(),
  );
  flow.check(
    "closed sheet has no answer buttons",
    0,
    await sheet.getByRole("button", { name: /^(Attending|Not attending)$/ }).count(),
  );

  // Read last, many steps after the second tab's list read was answered, so a
  // download that answer set off has long since been requested.
  flow.check(
    "the Ivory invitation downloaded the band",
    false,
    second.paths.includes(GIFT_BAND_MODULES.band),
  );
  flow.check(
    "the Ivory invitation downloaded the gift-list client",
    false,
    second.paths.includes(GIFT_BAND_MODULES.client),
  );
  flow.check(
    "gift band on the Ivory invitation",
    0,
    await second.tab.locator("[data-gift-teaser]").count(),
  );
  // The sheet stays open: it is the flow's final screenshot.
});
