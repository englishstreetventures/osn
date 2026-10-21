/**
 * Cire organiser portal: an owner adds a guest's email address in the guest
 * editor. The preview asks the owner to confirm the guest agreed, and holds
 * the save until they do; the stored address then carries the owner's
 * attestation. A second guest's address, which she gave herself on the
 * invite, shows as hers — text, not a field — and the save leaves it as it is.
 *
 * The wedding (`CIRE_ORGANISER.emails`) holds one household, Tanaka: Gus with
 * no address, and Hana with her own.
 */

import { CIRE_ORGANISER, DB_FILES, ORIGINS } from "../../src/config";
import { expect, onSuiteClock, queryOne, signInToCireHost, test } from "../support/fixtures";

const { weddingId, household, noAddress, guestsOwn, added } = CIRE_ORGANISER.emails;
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
});
