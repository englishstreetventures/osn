/**
 * Cire organiser portal: an owner opens the seating chart, which shows the
 * reception's plan in use, then sets out the after party, which has no plan
 * yet. The first table there makes the event's one plan, in use, and the guest
 * seated at it sits in that plan. The venue file prints both events.
 *
 * The wedding (`CIRE_ORGANISER.seating`) holds a reception whose one plan,
 * "Plan 1", is in use — Ada and Bo Alpha at Table 1, Cy Charlie at Table 2 —
 * and an after party, inviting Ada, with no plan.
 */

import { CIRE_ORGANISER, DB_FILES, ORIGINS } from "../../src/config";
import { expect, onSuiteClock, queryOne, signInToCireHost, test } from "../support/fixtures";

const { weddingId, planName, tables, party, ada, bo, cy } = CIRE_ORGANISER.seating;
const WEDDING_API = `${ORIGINS.cireApi}/api/organiser/weddings/${weddingId}`;

/** The after party's plans in the database: each one's name, whether it is in
 *  use, when it was written, its tables, and who sits where in it. */
function partyPlans(): Array<{
  name: string;
  selected: number;
  created_at: number;
  tables: string;
  seats: string;
}> {
  const row = queryOne<{ plans: string | null }>(
    DB_FILES.cire,
    `SELECT json_group_array(json_object(
              'name', p.name, 'selected', p.selected, 'created_at', p.created_at,
              'tables', coalesce((SELECT group_concat(t.name, ',') FROM seating_tables t
                                   WHERE t.plan_id = p.id), ''),
              'seats', coalesce((SELECT group_concat(a.guest_id || '@' || t.name, ',')
                                   FROM seating_assignments a JOIN seating_tables t ON t.id = a.table_id
                                  WHERE a.plan_id = p.id), ''))) AS plans
       FROM seating_plans p WHERE p.event_id = ?`,
    party.id,
  );
  return JSON.parse(row?.plans ?? "[]");
}

test("cire-seating", async ({ page, flow }) => {
  await signInToCireHost(flow, page);

  await flow.step("open the wedding's seating chart", async () => {
    await page.goto(`${ORIGINS.cireHost}/#/w/${weddingId}/seating`);
    await expect(page.getByRole("region", { name: tables.two })).toBeVisible();
  });
  flow.check(
    `the reception's plan in use seats ${cy.name}`,
    true,
    await page.getByRole("button", { name: `Move ${cy.name}` }).isVisible(),
  );
  flow.check("the after party has no plan yet", 0, partyPlans().length);

  const added = await flow.step(`add ${party.table} at the ${party.name}`, async () => {
    const chart = page.waitForResponse(
      (r) =>
        r.request().method() === "GET" && r.url() === `${WEDDING_API}/seating/events/${party.id}`,
    );
    await page.getByLabel("Event", { exact: true }).selectOption({ label: party.name });
    await chart;
    await page.getByLabel("Table name", { exact: true }).fill(party.table);
    await page.getByLabel("Seats", { exact: true }).fill("4");
    const response = page.waitForResponse(
      (r) =>
        r.request().method() === "POST" &&
        r.url() === `${WEDDING_API}/seating/events/${party.id}/tables`,
    );
    await page.getByRole("button", { name: "Add table" }).click();
    const status = (await response).status();
    await expect(page.getByText(`${party.table} added.`)).toBeVisible();
    return status;
  });
  flow.check("table added", 200, added);
  const made = partyPlans();
  flow.check(
    "the first table made one plan, in use, holding it",
    JSON.stringify([{ name: planName, selected: 1, tables: party.table }]),
    JSON.stringify(
      made.map((plan) => ({ name: plan.name, selected: plan.selected, tables: plan.tables })),
    ),
  );
  flow.check("the plan written on the suite clock", true, onSuiteClock(made[0]?.created_at));

  const seated = await flow.step(`seat ${ada.name} at ${party.table}`, async () => {
    const response = page.waitForResponse(
      (r) =>
        r.request().method() === "PUT" &&
        r.url() === `${WEDDING_API}/seating/events/${party.id}/guests/${ada.guestId}`,
    );
    await page.getByRole("button", { name: `Seat ${ada.name}` }).click();
    await page.getByRole("menuitemradio", { name: new RegExp(`^${party.table}`) }).click();
    const status = (await response).status();
    await expect(page.getByText(`${ada.name} seated at ${party.table}.`)).toBeVisible();
    return status;
  });
  flow.check("guest seated", 200, seated);
  flow.check(
    `${ada.name} sits in the after party's plan`,
    `${ada.guestId}@${party.table}`,
    partyPlans()[0]?.seats ?? "missing",
  );

  const file = await flow.step("download the venue file", async () => {
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download seating CSV" }).click();
    const stream = await (await download).createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString("utf8");
  });
  flow.check(
    "the venue file prints each event's plan in use",
    [
      "Event,Table,Capacity,Guest,Household,RSVP",
      `Reception,${tables.one},4,${ada.name},Alpha,Attending`,
      `Reception,${tables.one},4,${bo.name},Alpha,Attending`,
      `Reception,${tables.two},4,${cy.name},Charlie,Attending`,
      `${party.name},${party.table},4,${ada.name},Alpha,No reply`,
    ].join("\n"),
    file.split("\r\n").join("\n"),
  );
});
