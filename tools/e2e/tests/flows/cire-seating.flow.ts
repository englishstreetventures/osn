/**
 * Cire organiser portal, one sign-in for three weddings: guest email
 * addresses, then the seating chart and its plans, then the file a wedding
 * below Gold takes its plans back in.
 *
 * Guest emails (`CIRE_ORGANISER.emails`: one household, Tanaka — Gus with no
 * address, and Hana with her own). An owner adds Gus's address in the guest
 * editor. The preview asks the owner to confirm the guest agreed, and holds
 * the save until they do; the stored address then carries the owner's
 * attestation. Hana's address, which she gave herself on the invite, shows as
 * hers — text, not a field — and the save leaves it as it is. Then the guest
 * list says who added each address; a spreadsheet's address waits for the same
 * attestation, which a new preview resets; a sheet with a cell that is not an
 * address is refused; and the owner removes Hana's own address in the editor,
 * which asks for no attestation.
 *
 * Seating (`CIRE_ORGANISER.seating`: a reception whose one plan, "Plan 1", is
 * in use — Ada and Bo Alpha at Table 1, Cy Charlie at Table 2 — and an after
 * party, inviting Ada, with no plan). The owner opens the seating chart, which
 * shows the reception's plan in use, then sets out the after party. The first
 * table there makes the event's one plan, in use, and the guest seated at it
 * sits in that plan.
 *
 * At the reception the owner copies the plan in use, changes the copy, names
 * it, and finds that the plan it came from is as it was. A guest's reply then
 * changes to "declined": both plans list her for review, and neither moves her
 * seat. The owner puts the copy in use, downloads the venue file, which prints
 * the copy and the after party's plan, and deletes the plan no longer in use;
 * the copy stays in use. Last, on a wedding below Gold that kept two plans
 * (`CIRE_ORGANISER.seatingLocked`), the owner downloads the file Settings
 * offers, which holds every plan.
 *
 * The guest-email steps share this flow's sign-in because `flows.test.ts` caps
 * organiser sign-ins at six. They run first; the flow's screenshot is the
 * wedding below Gold's Settings page, where it ends.
 */

import type { Page } from "@playwright/test";

import { CIRE_ORGANISER, DB_FILES, ORIGINS } from "../../src/config";
import {
  expect,
  onSuiteClock,
  queryOne,
  signInToCireHost,
  test,
  type Flow,
} from "../support/fixtures";

const { weddingId, eventId, planId, planName, tables, party, ada, bo, cy } = CIRE_ORGANISER.seating;
const WEDDING_API = `${ORIGINS.cireApi}/api/organiser/weddings/${weddingId}`;

const {
  weddingId: emailsWeddingId,
  household,
  noAddress,
  guestsOwn,
  added: addedAddress,
  sheetAddresses,
} = CIRE_ORGANISER.emails;
const EMAILS_CHANGES_API = `${ORIGINS.cireApi}/api/organiser/weddings/${emailsWeddingId}/changes`;

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

/** A guest's address and its consent record, by first name. */
function addressOf(firstName: string) {
  return queryOne<{
    email: string | null;
    source: string | null;
    version: string | null;
    attestedBy: string | null;
    consentAt: number | undefined;
  }>(
    DB_FILES.cire,
    `SELECT g.email, g.email_source AS source, g.email_consent_version AS version,
            g.email_attested_by_osn_profile_id AS attestedBy, g.email_consent_at AS consentAt
       FROM guests g JOIN families f ON f.id = g.family_id
      WHERE f.wedding_id = ? AND g.first_name = ?`,
    emailsWeddingId,
    firstName,
  );
}

/** The guest-email steps, on the page `signInToCireHost` signed in. */
async function guestEmailSteps(flow: Flow, page: Page): Promise<void> {
  const guests = page.getByRole("region", { name: `Guests in ${household}` });

  await flow.step("open the wedding's guest editor", async () => {
    await page.goto(`${ORIGINS.cireHost}/#/w/${emailsWeddingId}/guests/edit`);
    await expect(guests).toBeVisible({ timeout: 60_000 });
  });

  await flow.step(`see ${guestsOwn.firstName}'s own address as hers`, async () => {
    await expect(guests.getByText(guestsOwn.address)).toBeVisible();
    await expect(guests.getByText("added by the guest")).toBeVisible();
  });
  // Hana's address is text with Remove; only Gus's row has a field to type in.
  flow.check(
    "one address field: the guest without one",
    1,
    await guests.getByRole("textbox", { name: "Email" }).count(),
  );

  const preview = await flow.step(`add ${noAddress}'s address and save`, async () => {
    await guests.getByRole("textbox", { name: "Email" }).fill(addedAddress);
    const response = page.waitForResponse(
      (r) => r.url() === `${EMAILS_CHANGES_API}/preview` && r.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Save changes" }).click();
    return (await (await response).json()) as { emailAttestations?: unknown };
  });
  flow.check(
    "the preview counts one address to attest",
    1,
    typeof preview.emailAttestations === "number" ? preview.emailAttestations : -1,
  );

  const dialog = page.getByRole("dialog", { name: "Review changes before applying" });
  const confirm = dialog.getByRole("button", { name: "Confirm & save" });
  await flow.step("the save waits for the attestation", async () => {
    await expect(dialog.getByRole("checkbox", { name: /agreed to get emails/ })).toBeVisible();
    await expect(confirm).toBeDisabled();
  });

  const applied = await flow.step("confirm the guest agreed, and save", async () => {
    await dialog.getByRole("checkbox", { name: /agreed to get emails/ }).check();
    await expect(confirm).toBeEnabled();
    const response = page.waitForResponse(
      (r) => r.url() === `${EMAILS_CHANGES_API}/apply` && r.request().method() === "POST",
    );
    await confirm.click();
    const status = (await response).status();
    await expect(dialog).toBeHidden();
    return status;
  });
  flow.check("the change applies", 200, applied);

  const gus = addressOf(noAddress);
  flow.check(
    `${noAddress}'s address, on the owner's attestation`,
    `${addedAddress} organiser_attested organiser-email- ${CIRE_ORGANISER.profileId}`,
    `${gus?.email ?? "none"} ${gus?.source ?? "none"} ${gus?.version?.replace(/\d{4}-\d{2}-\d{2}$/, "") ?? "none"} ${gus?.attestedBy ?? "none"}`,
  );
  flow.check("attested on the suite clock", true, onSuiteClock(gus?.consentAt));
  const hana = addressOf(guestsOwn.firstName);
  flow.check(
    `${guestsOwn.firstName}'s own address left as it was`,
    `${guestsOwn.address} guest`,
    `${hana?.email ?? "none"} ${hana?.source ?? "none"}`,
  );

  await flow.step("the guest list says who added each address", async () => {
    await page.goto(`${ORIGINS.cireHost}/#/w/${emailsWeddingId}/guests`);
    const gusLine = page.getByText(addedAddress).locator("xpath=..");
    const hanaLine = page.getByText(guestsOwn.address).locator("xpath=..");
    await expect(gusLine).toContainText("added by a host");
    await expect(hanaLine).toContainText("added by the guest");
    await expect(page.getByText("opted out", { exact: false })).toHaveCount(0);
  });

  // The spreadsheet door holds Apply until the organiser ticks the
  // attestation, and a new preview starts unticked.
  const sheet = (gusAddress: string) =>
    Buffer.from(
      [
        "Family ID,Family Name,Guest First Name,Guest Last Name,Guest Email",
        `1,${household},${noAddress},${household},${gusAddress}`,
        `1,${household},${guestsOwn.firstName},${household},`,
      ].join("\n"),
    );
  const upload = async (gusAddress: string) => {
    await page.getByLabel("guests.csv").setInputFiles({
      name: "guests.csv",
      mimeType: "text/csv",
      buffer: sheet(gusAddress),
    });
    const response = page.waitForResponse(
      (r) => r.url() === `${EMAILS_CHANGES_API}/preview` && r.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Preview", exact: true }).click();
    return response;
  };
  const attestation = page.getByRole("checkbox", { name: /agreed to get emails/ });
  const applyImport = page.getByRole("button", { name: "Apply import" });

  await flow.step("a spreadsheet's address waits for the attestation", async () => {
    await page.goto(`${ORIGINS.cireHost}/#/w/${emailsWeddingId}/guests/edit`);
    await page.getByRole("radio", { name: /Spreadsheet import/ }).click();
    await upload(sheetAddresses.first);
    await expect(attestation).toBeVisible();
    await expect(applyImport).toBeDisabled();
    await attestation.check();
    await expect(applyImport).toBeEnabled();
  });

  await flow.step("a new preview starts unticked", async () => {
    await upload(sheetAddresses.second);
    await expect(attestation).not.toBeChecked();
    await expect(applyImport).toBeDisabled();
    // Gus withdrew this address on his invite, so the preview says so.
    await expect(
      page.getByText("removed or replaced by the guest", { exact: false }),
    ).toBeVisible();
  });

  const imported = await flow.step("confirm and apply the sheet", async () => {
    await attestation.check();
    const response = page.waitForResponse(
      (r) => r.url() === `${EMAILS_CHANGES_API}/apply` && r.request().method() === "POST",
    );
    // The panel reloads the page once the apply lands.
    const reloaded = page.waitForEvent("load");
    await applyImport.click();
    const status = (await response).status();
    await reloaded;
    return status;
  });
  flow.check("the sheet applies", 200, imported);
  const fromSheet = addressOf(noAddress);
  flow.check(
    `${noAddress}'s address from the sheet, on the owner's attestation`,
    `${sheetAddresses.second} organiser_attested ${CIRE_ORGANISER.profileId}`,
    `${fromSheet?.email ?? "none"} ${fromSheet?.source ?? "none"} ${fromSheet?.attestedBy ?? "none"}`,
  );

  await flow.step(`the guest list marks the address ${noAddress} withdrew`, async () => {
    await page.goto(`${ORIGINS.cireHost}/#/w/${emailsWeddingId}/guests`);
    const gusLine = page.getByText(sheetAddresses.second).locator("xpath=..");
    await expect(gusLine).toContainText("opted out");
  });

  await flow.step("a sheet whose address cell is not one address is refused", async () => {
    await page.goto(`${ORIGINS.cireHost}/#/w/${emailsWeddingId}/guests/edit`);
    await page.getByRole("radio", { name: /Spreadsheet import/ }).click();
    const response = await upload("not an address");
    expect(response.status()).toBe(422);
    await expect(
      page.getByText("Guest Email must be one email address", { exact: false }),
    ).toBeVisible();
  });

  // The organiser may remove an address a guest gave themselves, and undo
  // that until the save; removing needs no attestation.
  const removed = await flow.step(
    `remove ${guestsOwn.firstName}'s own address in the editor`,
    async () => {
      await page.getByRole("radio", { name: /Web editor/ }).click();
      const removeEmail = page.getByRole("button", {
        name: `Remove ${guestsOwn.firstName}’s email address`,
      });
      await removeEmail.click();
      await expect(page.getByText("Removed on save")).toBeVisible();
      await page
        .getByRole("button", { name: `Keep ${guestsOwn.firstName}’s email address` })
        .click();
      await expect(page.getByText(guestsOwn.address)).toBeVisible();
      await removeEmail.click();
      const removalPreview = page.waitForResponse(
        (r) => r.url() === `${EMAILS_CHANGES_API}/preview` && r.request().method() === "POST",
      );
      await page.getByRole("button", { name: "Save changes" }).click();
      const body = (await (await removalPreview).json()) as { emailAttestations?: unknown };
      await expect(confirm).toBeEnabled();
      const response = page.waitForResponse(
        (r) => r.url() === `${EMAILS_CHANGES_API}/apply` && r.request().method() === "POST",
      );
      await confirm.click();
      return `${String(body.emailAttestations)} ${(await response).status()}`;
    },
  );
  flow.check("the removal asks for no attestation, and applies", "0 200", removed);
  const hanaAfter = addressOf(guestsOwn.firstName);
  flow.check(
    `${guestsOwn.firstName}'s address and its record are gone`,
    "none none none",
    `${hanaAfter?.email ?? "none"} ${hanaAfter?.source ?? "none"} ${hanaAfter?.version ?? "none"}`,
  );
  // Let the save finish closing before the seating steps navigate away.
  await expect(dialog).toBeHidden();
}

const COPY = "Garden";

/** Each plan of the reception in the database, by name: whether it is in use,
 *  and who sits at which table, as `guest@table`, sorted. */
function plansInDb(): Record<string, { selected: number; seats: string }> {
  const row = queryOne<{ plans: string | null }>(
    DB_FILES.cire,
    `SELECT json_group_object(name, json_object('selected', selected, 'seats', seats)) AS plans
       FROM (
         SELECT p.name, p.selected,
                coalesce((SELECT group_concat(seat, ',') FROM (
                  SELECT a.guest_id || '@' || t.name AS seat
                    FROM seating_assignments a JOIN seating_tables t ON t.id = a.table_id
                   WHERE a.plan_id = p.id ORDER BY seat)), '') AS seats
           FROM seating_plans p WHERE p.event_id = ?
       )`,
    eventId,
  );
  return JSON.parse(row?.plans ?? "{}") as Record<string, { selected: number; seats: string }>;
}

const seats = (...pairs: Array<[string, string]>) =>
  pairs
    .map(([guestId, table]) => `${guestId}@${table}`)
    .toSorted()
    .join(",");

const ORIGINAL = seats(
  [ada.guestId, tables.one],
  [bo.guestId, tables.one],
  [cy.guestId, tables.two],
);
const CHANGED = seats(
  [ada.guestId, tables.one],
  [bo.guestId, tables.one],
  [cy.guestId, tables.one],
);

/** The "Needs review" lines the plan on screen shows, in order. */
async function reviewLines(page: Page): Promise<string> {
  const notice = page.locator("section", { has: page.getByText(/^Needs review/) });
  if ((await notice.count()) === 0) return "";
  return (await notice.locator("li").allTextContents()).join(" | ");
}

/** Opens `name` from the plan picker and waits for its chart. */
async function openPlan(page: Page, name: string, selectedLabel = name): Promise<void> {
  const chart = page.waitForResponse(
    (r) =>
      r.request().method() === "GET" &&
      r.url().startsWith(`${WEDDING_API}/seating/events/${eventId}?plan=`),
  );
  await page.getByLabel("Plan", { exact: true }).selectOption({ label: selectedLabel });
  await chart;
}

/** Downloads the venue file from the Seating module, with its lines joined by
 *  `\n`. */
async function venueFile(page: Page): Promise<string> {
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download seating CSV" }).click();
  const stream = await (await download).createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8").split("\r\n").join("\n");
}

test("cire-seating", async ({ page, flow }) => {
  await signInToCireHost(flow, page);

  await guestEmailSteps(flow, page);

  page.on("dialog", (dialog) => void dialog.accept());

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
      (r) => r.request().method() === "PUT" && r.url().endsWith(`/guests/${ada.guestId}`),
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

  const before = await flow.step("download the venue file", () => venueFile(page));
  flow.check(
    "the venue file prints each event's plan in use",
    [
      "Event,Table,Capacity,Guest,Household,RSVP",
      `Reception,${tables.one},4,${ada.name},Alpha,Attending`,
      `Reception,${tables.one},4,${bo.name},Alpha,Attending`,
      `Reception,${tables.two},4,${cy.name},Charlie,Attending`,
      `${party.name},${party.table},4,${ada.name},Alpha,No reply`,
    ].join("\n"),
    before,
  );

  await flow.step("open the reception's chart again", async () => {
    const chart = page.waitForResponse(
      (r) =>
        r.request().method() === "GET" &&
        r.url().startsWith(`${WEDDING_API}/seating/events/${eventId}`),
    );
    await page.getByLabel("Event", { exact: true }).selectOption({ label: "Reception" });
    await chart;
    await expect(page.getByRole("region", { name: tables.two })).toBeVisible();
    await expect(page.getByLabel("Plan", { exact: true })).toHaveValue(planId);
  });
  flow.check(
    "the plan in use is named as such",
    true,
    await page.getByText("This plan is in use: the venue file prints it.").isVisible(),
  );

  const copied = await flow.step("duplicate the plan", async () => {
    const response = page.waitForResponse(
      (r) =>
        r.request().method() === "POST" &&
        r.url() === `${WEDDING_API}/seating/events/${eventId}/plans`,
    );
    await page.getByRole("button", { name: "Duplicate" }).click();
    const status = (await response).status();
    await expect(
      page.getByText(`${planName} copy made from ${planName}.`, { exact: false }),
    ).toBeVisible();
    return status;
  });
  flow.check("plan duplicated", 200, copied);
  flow.check(
    "the copy holds the same seats under new tables",
    ORIGINAL,
    plansInDb()[`${planName} copy`]?.seats ?? "missing",
  );
  const copyRow = queryOne<{ created_at: number; tables: number }>(
    DB_FILES.cire,
    `SELECT p.created_at, (SELECT count(*) FROM seating_tables t WHERE t.plan_id = p.id) AS tables
       FROM seating_plans p WHERE p.event_id = ? AND p.name = ?`,
    eventId,
    `${planName} copy`,
  );
  flow.check("the copy has both tables", 2, copyRow?.tables ?? -1);
  flow.check("the copy written on the suite clock", true, onSuiteClock(copyRow?.created_at));

  const moved = await flow.step(`move ${cy.name} to ${tables.one} in the copy`, async () => {
    const response = page.waitForResponse(
      (r) => r.request().method() === "PUT" && r.url().endsWith(`/guests/${cy.guestId}`),
    );
    await page.getByRole("button", { name: `Move ${cy.name}` }).click();
    await page.getByRole("menuitemradio", { name: new RegExp(`^${tables.one}`) }).click();
    const status = (await response).status();
    await expect(page.getByText(`${cy.name} moved to ${tables.one}.`)).toBeVisible();
    return status;
  });
  flow.check("seat moved in the copy", 200, moved);
  flow.check(
    "the copy's seats changed",
    CHANGED,
    plansInDb()[`${planName} copy`]?.seats ?? "missing",
  );
  flow.check(
    "the original plan's seats unchanged",
    ORIGINAL,
    plansInDb()[planName]?.seats ?? "missing",
  );

  const extra = await flow.step(`add ${tables.three} in the copy`, async () => {
    await page.getByLabel("Table name", { exact: true }).fill(tables.three);
    await page.getByLabel("Seats", { exact: true }).fill("4");
    const response = page.waitForResponse(
      (r) =>
        r.request().method() === "POST" &&
        r.url().startsWith(`${WEDDING_API}/seating/plans/`) &&
        r.url().endsWith("/tables"),
    );
    await page.getByRole("button", { name: "Add table" }).click();
    const status = (await response).status();
    await expect(page.getByText(`${tables.three} added.`)).toBeVisible();
    return status;
  });
  flow.check("table added in the copy", 200, extra);
  flow.check(
    "the copy stays on screen",
    `${planName} copy`,
    (await page.getByLabel("Plan", { exact: true }).locator("option:checked").textContent()) ??
      "none",
  );
  flow.check(
    "the copy holds the new table, and the original does not",
    "3,2",
    [`${planName} copy`, planName]
      .map(
        (name) =>
          queryOne<{ n: number }>(
            DB_FILES.cire,
            `SELECT count(*) AS n FROM seating_tables t JOIN seating_plans p ON p.id = t.plan_id
              WHERE p.event_id = ? AND p.name = ?`,
            eventId,
            name,
          )?.n ?? -1,
      )
      .join(","),
  );

  const renamed = await flow.step(`rename the copy ${COPY}`, async () => {
    await page.getByRole("button", { name: "Rename" }).click();
    await page.getByLabel("Plan name").fill(COPY);
    const response = page.waitForResponse(
      (r) =>
        r.request().method() === "PATCH" && r.url().startsWith(`${WEDDING_API}/seating/plans/`),
    );
    await page.getByRole("button", { name: "Save" }).click();
    const status = (await response).status();
    await expect(page.getByText(`${planName} copy renamed ${COPY}.`)).toBeVisible();
    return status;
  });
  flow.check("copy renamed", 200, renamed);
  flow.check("the original plan still in use", 1, plansInDb()[planName]?.selected ?? -1);
  flow.check("the renamed copy not in use", 0, plansInDb()[COPY]?.selected ?? -1);

  const declined = await flow.step(`record ${bo.name}'s reply as declined`, async () =>
    page.evaluate(async (url) => {
      const response = await fetch(url, {
        method: "PUT",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "declined" }),
      });
      return response.status;
    }, `${WEDDING_API}/guests/${bo.guestId}/rsvps/${eventId}`),
  );
  flow.check("reply recorded", 200, declined);

  const review = `Seated, but declined (1): ${bo.name}`;
  await flow.step(`see ${bo.name} listed for review in ${COPY}`, async () => {
    await openPlan(page, planName, `${planName} (in use)`);
    await openPlan(page, COPY);
    await expect(page.getByText(review)).toBeVisible();
  });
  flow.check(`${COPY} lists the decline for review`, review, await reviewLines(page));
  await flow.step(`see ${bo.name} listed for review in ${planName}`, async () => {
    await openPlan(page, planName, `${planName} (in use)`);
    await expect(page.getByText(review)).toBeVisible();
  });
  flow.check(`${planName} lists the decline for review`, review, await reviewLines(page));
  flow.check(
    "no seat moved in the original plan",
    ORIGINAL,
    plansInDb()[planName]?.seats ?? "missing",
  );
  flow.check("no seat moved in the copy", CHANGED, plansInDb()[COPY]?.seats ?? "missing");

  const used = await flow.step(`put ${COPY} in use`, async () => {
    await openPlan(page, COPY);
    const response = page.waitForResponse(
      (r) =>
        r.request().method() === "PUT" &&
        r.url() === `${WEDDING_API}/seating/events/${eventId}/selected-plan`,
    );
    await page.getByRole("button", { name: "Use this plan" }).click();
    const status = (await response).status();
    await expect(page.getByText(`${COPY} is now in use. The venue file prints it.`)).toBeVisible();
    return status;
  });
  flow.check("plan put in use", 200, used);
  flow.check(`${COPY} in use`, 1, plansInDb()[COPY]?.selected ?? -1);
  flow.check(`${planName} no longer in use`, 0, plansInDb()[planName]?.selected ?? -1);

  const after = await flow.step("download the venue file again", () => venueFile(page));
  flow.check(
    "the venue file prints each event's plan in use, the copy at the reception",
    [
      "Event,Table,Capacity,Guest,Household,RSVP",
      `Reception,${tables.one},4,${ada.name},Alpha,Attending`,
      `Reception,${tables.one},4,${bo.name},Alpha,Declined`,
      `Reception,${tables.one},4,${cy.name},Charlie,Attending`,
      `${party.name},${party.table},4,${ada.name},Alpha,No reply`,
    ].join("\n"),
    after,
  );

  const deleted = await flow.step(`delete ${planName}, no longer in use`, async () => {
    await openPlan(page, planName);
    const response = page.waitForResponse(
      (r) =>
        r.request().method() === "DELETE" && r.url().startsWith(`${WEDDING_API}/seating/plans/`),
    );
    await page.getByRole("button", { name: "Delete plan" }).click();
    const status = (await response).status();
    await expect(page.getByText(`${planName} deleted.`)).toBeVisible();
    await expect(page.getByLabel("Plan", { exact: true }).locator("option")).toHaveText([
      `${COPY} (in use)`,
    ]);
    return status;
  });
  flow.check("unused plan deleted", 200, deleted);
  flow.check("only the plan in use remains", COPY, Object.keys(plansInDb()).join(","));
  flow.check(`${COPY} still in use`, 1, plansInDb()[COPY]?.selected ?? -1);
  flow.check(`${COPY}'s seats as they were`, CHANGED, plansInDb()[COPY]?.seats ?? "missing");

  const locked = CIRE_ORGANISER.seatingLocked;
  const taken = await flow.step("take every plan back from a wedding below Gold", async () => {
    await page.goto(`${ORIGINS.cireHost}/#/w/${locked.weddingId}/settings/wedding`);
    // Two plans: one seat in the plan in use, two in the other.
    await expect(page.getByText("Your 3 seats are still here.")).toBeVisible();
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download as CSV" }).click();
    const saved = await download;
    const stream = await saved.createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    return {
      name: saved.suggestedFilename(),
      text: Buffer.concat(chunks).toString("utf8").split("\r\n").join("\n"),
    };
  });
  flow.check("the file is named for every plan", locked.fileName, taken.name);
  flow.check(
    "the file holds every plan, the plan in use first",
    locked.lines.join("\n"),
    taken.text,
  );
});
