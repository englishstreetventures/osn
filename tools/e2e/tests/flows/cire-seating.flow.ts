/**
 * Cire organiser portal, one sign-in for two weddings: guest email addresses,
 * then the seating chart.
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
 * Change history (the same wedding). A sheet with no address column adds a
 * household, Ito, so it asks for no attestation; the owner opens Change
 * history, reverts that sheet, and is asked to confirm in words that name the
 * guest list alone. Cire-api restores the guest list from the sheet's
 * before-image: the household and its guest are gone, the change reads
 * Reverted, and the address the earlier sheet gave Gus stays.
 *
 * Seating (`CIRE_ORGANISER.seating`: a reception whose one plan, "Plan 1", is
 * in use — Ada and Bo Alpha at Table 1, Cy Charlie at Table 2 — and an after
 * party, inviting Ada, with no plan). The owner opens the seating chart, which
 * shows the reception's plan in use, then sets out the after party. The first
 * table there makes the event's one plan, in use, and the guest seated at it
 * sits in that plan. The venue file prints both events.
 *
 * RSVPs (the same wedding). The owner downloads the RSVP sheet from the RSVPs
 * page, before any seating step: the file carries each guest's reply to both
 * events, and seating writes nothing it reads.
 *
 * The guest-email, change-history and RSVP steps share this flow's sign-in
 * because `flows.test.ts` caps organiser sign-ins at seven. They run first, so
 * the flow's screenshot is the seating chart.
 */

import { resolve } from "node:path";

import type { Locator, Page } from "@playwright/test";

import { CIRE_ORGANISER, DB_FILES, ORIGINS, SCREENSHOT_DIR } from "../../src/config";
import {
  expect,
  onSuiteClock,
  queryOne,
  signInToCireHost,
  test,
  type Flow,
} from "../support/fixtures";

const { weddingId, slug, planName, tables, party, ada, bo, cy } = CIRE_ORGANISER.seating;
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

  // The module's view bar holds under the top bar as the list scrolls. This
  // wedding's list is short, so the window is made short enough to scroll it;
  // the result is recorded as a sentence, not pixels, so a rerun matches.
  const viewport = page.viewportSize();
  const stuck = await flow.step("the view bar holds under the top bar on Households", async () => {
    await page.setViewportSize({ width: 1280, height: 280 });
    const bar = page.getByRole("region", { name: "Guests controls" });
    await expect(bar).toBeVisible();
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    const gap = await page.evaluate(() => {
      const top = document.querySelector("header")!.getBoundingClientRect().bottom;
      const held = document.querySelector("[data-view-bar]")!.getBoundingClientRect().top;
      const scrolled = window.scrollY > 0;
      return scrolled ? Math.abs(held - top) : Number.POSITIVE_INFINITY;
    });
    await page.screenshot({
      path: resolve(SCREENSHOT_DIR, "cire-seating--view-bar-stuck.png"),
      animations: "disabled",
    });
    if (viewport) await page.setViewportSize(viewport);
    return gap <= 1
      ? "the view bar's top meets the top bar's foot"
      : "the page did not scroll, or the bar moved off";
  });
  flow.check("the view bar sticks", "the view bar's top meets the top bar's foot", stuck);

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
  // Let the save finish closing before the next steps navigate away.
  await expect(dialog).toBeHidden();

  await revertSteps(flow, page, { apply: applyImport, attestation });
}

/** The wedding's guest households, by name, sorted and comma-joined. */
function householdsInDb(): string {
  const row = queryOne<{ names: string | null }>(
    DB_FILES.cire,
    `SELECT group_concat(family_name) AS names FROM (
       SELECT family_name FROM families WHERE wedding_id = ? AND kind = 'guest' ORDER BY family_name)`,
    emailsWeddingId,
  );
  return row?.names ?? "";
}

/**
 * Change history, on the guest-email wedding: a sheet with no address column
 * adds a household, so it asks for no attestation and changes no address; the
 * owner reverts it from Change history and the household is gone again, while
 * the address the earlier sheet gave Gus stays.
 */
async function revertSteps(
  flow: Flow,
  page: Page,
  controls: { apply: Locator; attestation: Locator },
): Promise<void> {
  const { household: addedHousehold, firstName: addedGuest } = CIRE_ORGANISER.emails.reverted;
  const importMode = page.getByRole("radio", { name: /Spreadsheet import/ });
  const history = page
    .locator("details")
    .filter({ has: page.locator("summary", { hasText: "Change history" }) });
  // The change the sheet makes, as the history summarises it.
  const addedRow = history.getByRole("listitem").filter({ hasText: "+1 guests, +1 families" });

  const added = await flow.step(
    `a sheet with no address column adds the ${addedHousehold} household`,
    async () => {
      await page.goto(`${ORIGINS.cireHost}/#/w/${emailsWeddingId}/guests/edit`);
      await importMode.click();
      await page.getByLabel("guests.csv").setInputFiles({
        name: "guests.csv",
        mimeType: "text/csv",
        buffer: Buffer.from(
          [
            "Family ID,Family Name,Guest First Name,Guest Last Name",
            `1,${household},${noAddress},${household}`,
            `1,${household},${guestsOwn.firstName},${household}`,
            `2,${addedHousehold},${addedGuest},${addedHousehold}`,
          ].join("\n"),
        ),
      });
      const previewed = page.waitForResponse(
        (r) => r.url() === `${EMAILS_CHANGES_API}/preview` && r.request().method() === "POST",
      );
      await page.getByRole("button", { name: "Preview", exact: true }).click();
      const preview = (await previewed).status();
      await expect(controls.apply).toBeEnabled();
      const asksAttestation = await controls.attestation.count();
      const applied = page.waitForResponse(
        (r) => r.url() === `${EMAILS_CHANGES_API}/apply` && r.request().method() === "POST",
      );
      const reloaded = page.waitForEvent("load");
      await controls.apply.click();
      const status = (await applied).status();
      await reloaded;
      return { preview, asksAttestation, status };
    },
  );
  flow.check("the sheet previews", 200, added.preview);
  flow.check("a sheet that changes no address asks for no attestation", 0, added.asksAttestation);
  flow.check("the sheet applies", 200, added.status);
  flow.check(
    `the ${addedHousehold} household is added`,
    `${addedHousehold},${household}`,
    householdsInDb(),
  );

  const asked = await flow.step("revert the sheet from Change history", async () => {
    await importMode.click();
    const listed = page.waitForResponse(
      (r) => r.url() === `${EMAILS_CHANGES_API}/list` && r.request().method() === "GET",
    );
    await history.locator(":scope > summary").click();
    await listed;
    await expect(addedRow).toContainText("Applied");
    let confirm = "";
    page.once("dialog", (prompt) => {
      confirm = prompt.message();
      void prompt.accept();
    });
    const reverted = page.waitForResponse(
      (r) => r.url() === `${EMAILS_CHANGES_API}/revert` && r.request().method() === "POST",
    );
    // The history reloads the page once the revert lands.
    const reloaded = page.waitForEvent("load");
    await addedRow.getByRole("button", { name: "Revert" }).click();
    const status = (await reverted).status();
    await reloaded;
    return { confirm, status };
  });
  flow.check(
    "the confirm names the guest list alone",
    true,
    asked.confirm.startsWith(
      "Revert this change? Households, guests and their invitations are restored",
    ),
  );
  flow.check("cire-api reverts the sheet", 200, asked.status);
  flow.check(`the ${addedHousehold} household is gone`, household, householdsInDb());
  const guestsLeft = queryOne<{ names: string | null }>(
    DB_FILES.cire,
    `SELECT group_concat(first_name) AS names FROM (
       SELECT g.first_name FROM guests g JOIN families f ON f.id = g.family_id
        WHERE f.wedding_id = ? ORDER BY g.first_name)`,
    emailsWeddingId,
  );
  flow.check(
    `${addedGuest}'s row is gone`,
    `${noAddress},${guestsOwn.firstName}`,
    guestsLeft?.names ?? "",
  );
  const reverts = queryOne<{ n: number }>(
    DB_FILES.cire,
    "SELECT count(*) AS n FROM imports WHERE wedding_id = ? AND status = 'reverted'",
    emailsWeddingId,
  );
  flow.check("one change is marked reverted", 1, reverts?.n ?? -1);
  const gusKept = addressOf(noAddress);
  flow.check(
    `${noAddress}'s address from the earlier sheet stays`,
    `${sheetAddresses.second} organiser_attested`,
    `${gusKept?.email ?? "none"} ${gusKept?.source ?? "none"}`,
  );

  await flow.step("the history marks the sheet reverted", async () => {
    await importMode.click();
    await history.locator(":scope > summary").click();
    await expect(addedRow).toContainText("Reverted");
    await expect(addedRow.getByRole("button", { name: "Revert" })).toHaveCount(0);
  });
}

test("cire-seating", async ({ page, flow }) => {
  await signInToCireHost(flow, page);

  await guestEmailSteps(flow, page);

  const rsvps = await flow.step("download the RSVP sheet from the RSVPs page", async () => {
    await page.goto(`${ORIGINS.cireHost}/#/w/${weddingId}/guests/rsvps`);
    // The Guests tab has a button of the same name; the event strip is the
    // RSVPs page's alone.
    await expect(page.getByRole("tablist", { name: "Events" })).toBeVisible();
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download RSVPs (CSV)" }).click();
    const file = await download;
    const stream = await file.createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    return { name: file.suggestedFilename(), body: Buffer.concat(chunks).toString("utf8") };
  });
  flow.check("the RSVP sheet is named for the wedding", `cire-rsvps-${slug}.csv`, rsvps.name);
  flow.check(
    "the RSVP sheet holds every guest's reply to each event",
    // Only Ada is invited to the after party, so only her row has a reply
    // there; Bo's and Cy's cells for it are empty, not "No response".
    [
      `Family Code,Family Name,Guest First Name,Guest Last Name,Reception,Reception Dietary,${party.name},${party.name} Dietary,Recorded By,Plus-one Of`,
      "TESTSEAT-ALP-0001,Alpha,Ada,Alpha,Attending,,No response,,Guest,",
      "TESTSEAT-ALP-0001,Alpha,Bo,Alpha,Attending,,,,Guest,",
      "TESTSEAT-CHA-0002,Charlie,Cy,Charlie,Attending,,,,Guest,",
    ].join("\n"),
    rsvps.body.split("\r\n").join("\n"),
  );

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
