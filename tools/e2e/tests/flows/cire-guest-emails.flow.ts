/**
 * Cire organiser portal: an owner adds a guest's email address in the guest
 * editor. The preview asks the owner to confirm the guest agreed, and holds
 * the save until they do; the stored address then carries the owner's
 * attestation. A second guest's address, which she gave herself on the
 * invite, shows as hers — text, not a field — and the save leaves it as it is.
 *
 * Then the guest list says who added each address; a spreadsheet's address
 * waits for the same attestation, which a new preview resets; a sheet with a
 * cell that is not an address is refused; and the owner removes Hana's own
 * address in the editor, which asks for no attestation.
 *
 * The wedding (`CIRE_ORGANISER.emails`) holds one household, Tanaka: Gus with
 * no address, and Hana with her own.
 */

import { CIRE_ORGANISER, DB_FILES, ORIGINS } from "../../src/config";
import { expect, onSuiteClock, queryOne, signInToCireHost, test } from "../support/fixtures";

const { weddingId, household, noAddress, guestsOwn, added, sheetAddresses } = CIRE_ORGANISER.emails;
const CHANGES_API = `${ORIGINS.cireApi}/api/organiser/weddings/${weddingId}/changes`;

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
    weddingId,
    firstName,
  );
}

test("cire-guest-emails", async ({ page, flow }) => {
  await signInToCireHost(flow, page);

  const guests = page.getByRole("region", { name: `Guests in ${household}` });

  await flow.step("open the wedding's guest editor", async () => {
    await page.goto(`${ORIGINS.cireHost}/#/w/${weddingId}/guests/edit`);
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
    await guests.getByRole("textbox", { name: "Email" }).fill(added);
    const response = page.waitForResponse(
      (r) => r.url() === `${CHANGES_API}/preview` && r.request().method() === "POST",
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
      (r) => r.url() === `${CHANGES_API}/apply` && r.request().method() === "POST",
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
    `${added} organiser_attested organiser-email- ${CIRE_ORGANISER.profileId}`,
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
    await page.goto(`${ORIGINS.cireHost}/#/w/${weddingId}/guests`);
    const gusLine = page.getByText(added).locator("xpath=..");
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
      (r) => r.url() === `${CHANGES_API}/preview` && r.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Preview", exact: true }).click();
    return response;
  };
  const attestation = page.getByRole("checkbox", { name: /agreed to get emails/ });
  const applyImport = page.getByRole("button", { name: "Apply import" });

  await flow.step("a spreadsheet's address waits for the attestation", async () => {
    await page.goto(`${ORIGINS.cireHost}/#/w/${weddingId}/guests/edit`);
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
    await expect(page.getByText("removed by the guest", { exact: false })).toBeVisible();
  });

  const imported = await flow.step("confirm and apply the sheet", async () => {
    await attestation.check();
    const response = page.waitForResponse(
      (r) => r.url() === `${CHANGES_API}/apply` && r.request().method() === "POST",
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
    await page.goto(`${ORIGINS.cireHost}/#/w/${weddingId}/guests`);
    const gusLine = page.getByText(sheetAddresses.second).locator("xpath=..");
    await expect(gusLine).toContainText("opted out");
  });

  await flow.step("a sheet whose address cell is not one address is refused", async () => {
    await page.goto(`${ORIGINS.cireHost}/#/w/${weddingId}/guests/edit`);
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
        (r) => r.url() === `${CHANGES_API}/preview` && r.request().method() === "POST",
      );
      await page.getByRole("button", { name: "Save changes" }).click();
      const body = (await (await removalPreview).json()) as { emailAttestations?: unknown };
      await expect(confirm).toBeEnabled();
      const response = page.waitForResponse(
        (r) => r.url() === `${CHANGES_API}/apply` && r.request().method() === "POST",
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
});
