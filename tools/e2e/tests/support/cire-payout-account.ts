/**
 * The payout account's holder, and handing it over, in the organiser portal:
 * three sections of `cire-registry-money` that share its one sign-in as the
 * dev profile (`tests/flows.test.ts` caps organiser sign-ins).
 *
 * 1. **The holder's seat** (`holderSeatSteps`). On Money Wedding Kit holds the
 *    Stripe account and the dev profile is the other owner. The hosts panel
 *    shows a note on Kit's seat, and its role select and Remove are
 *    `aria-disabled`, described by the note; the dev profile's own row has no
 *    note. `DELETE /hosts/usr_e2e_kit` from the browser's own session answers
 *    409 `holds_payout_account` and Kit is still an owner.
 * 2. **Handing over** (`handOverSteps`). On Handover Wedding the dev profile
 *    holds the account and Kit is the other owner. The dev profile's own
 *    role select and "Leave this wedding" are `aria-disabled` with the holder's
 *    sentence, and `DELETE /hosts/me` answers 409 `holds_payout_account`. Its
 *    note's link opens Money gifts, where "Hand money gifts to another owner"
 *    opens a dialog naming
 *    Kit; "Hand over" retires the account: the panel shows none, the row has
 *    none at generation 1, and one retired row says `handed_over`. Back in the
 *    hosts panel the dev profile's step-down to editor then goes through.
 * 3. **Replacing an absent holder's account** (`replaceAbsentHolderSteps`). On
 *    Absent Holder Wedding Kit holds the account and is an editor, so money
 *    gifts are closed: the registry read names `payout_holder_absent` and
 *    `payoutHolderAbsent: true` — the stack takes money, so no
 *    `payments_unavailable` hides it — the panel says why and keeps the switch
 *    off, and `PUT /registry/settings` turning money on answers 409
 *    `payout_holder_absent`. "Use your own account" retires the account and
 *    asks which account takes the wedding's gifts; a new one goes to the Stripe
 *    stand-in, which makes an Express account and an onboarding link on
 *    Stripe's own Connect host, which the flow answers. The row then names the
 *    new account with the dev profile as its holder, and the panel shows it
 *    still being set up.
 *
 * Every section ends with a screenshot of the panel under
 * `screenshots/cire-registry-money/`.
 *
 * The Stripe routes and the retire share one per-profile limiter, ten a minute
 * in one fixed window (`defaultRegistryStripeLimiter` in cire/api/src/app.ts).
 * The flow's calls before the third section reach nine, so on a fast machine
 * its four calls — the retire, the account list, the onboarding session and
 * the panel's own status read when it comes back — would pass the limit. The
 * section first has the limiter open a window of its own (`openStripeWindow`),
 * waiting on the limiter's answers, never on a clock (`tests/flows.test.ts`).
 * It skips that when more than 62 seconds have passed since the flow's last
 * earlier Stripe call, which it reads from `performance.now()`: every window
 * those calls opened has closed by then, so nothing is waited for that is not
 * needed.
 *
 * Every id the run makes (the new account's) is compared, never recorded, so
 * `results.json` reads the same on every run.
 */

import { performance } from "node:perf_hooks";

import type { BrowserContext, Page } from "@playwright/test";

import { CIRE_ORGANISER, DB_FILES, ORIGINS } from "../../src/config";
import { shoot, standInCalls } from "./cire-fund-gift";
import { expect, queryOne, type Flow } from "./fixtures";

const SHOTS = "cire-registry-money";
const DEV = CIRE_ORGANISER.profileId;
const KIT = "usr_e2e_kit";

/** A wedding's organiser API path. */
const weddingApi = (weddingId: string, path: string) =>
  `${ORIGINS.cireApi}/api/organiser/weddings/${weddingId}${path}`;

/** A seat's role, or "absent" with no seat. */
const roleOf = (weddingId: string, profileId: string): string =>
  queryOne<{ role: string }>(
    DB_FILES.cire,
    "SELECT role FROM wedding_hosts WHERE wedding_id = ? AND osn_profile_id = ?",
    weddingId,
    profileId,
  )?.role ?? "absent";

/** A wedding's Stripe account as its settings row names it. */
const accountOf = (weddingId: string) =>
  queryOne<{
    account: string | null;
    holder: string | null;
    type: string | null;
    generation: number;
  }>(
    DB_FILES.cire,
    `SELECT stripe_account_id AS account, stripe_connected_by_osn_profile_id AS holder,
            stripe_account_type AS type, stripe_account_generation AS generation
       FROM registry_settings WHERE wedding_id = ?`,
    weddingId,
  );

/** A wedding's retired accounts, as `account reason`, oldest first. */
const retiredOf = (weddingId: string): string =>
  queryOne<{ rows: string | null }>(
    DB_FILES.cire,
    `SELECT group_concat(stripe_account_id || ' ' || reason, '; ') AS rows FROM (
       SELECT stripe_account_id, reason FROM registry_retired_accounts
        WHERE wedding_id = ? ORDER BY retired_at, id)`,
    weddingId,
  )?.rows ?? "";

/** The hosts panel's row for a person, found by the role select it holds. */
const rowWithSelect = (page: Page, name: string) =>
  page.getByRole("listitem").filter({ has: page.getByRole("combobox", { name }) });

/**
 * A control's `aria-disabled`, and whether its `aria-describedby` names the
 * note beside it.
 */
async function lockedBy(
  control: ReturnType<Page["getByRole"]>,
  note: ReturnType<Page["getByTestId"]>,
): Promise<{ disabled: string; describedByNote: boolean }> {
  const noteId = (await note.getAttribute("id")) ?? "";
  const describedBy = (await control.getAttribute("aria-describedby")) ?? "";
  return {
    disabled: (await control.getAttribute("aria-disabled")) ?? "absent",
    describedByNote: noteId !== "" && describedBy.split(/\s+/).includes(noteId),
  };
}

/** `DELETE` a seat from the browser's own session, as a stale page would. */
async function deleteSeat(
  flow: Flow,
  page: Page,
  weddingId: string,
  who: string,
): Promise<{ status: number; error: string }> {
  const url = weddingApi(weddingId, `/hosts/${who}`);
  const response = await page.context().request.delete(url, {
    headers: { origin: ORIGINS.cireHost },
  });
  flow.recordRequest("DELETE", url, response.status());
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  return { status: response.status(), error: body.error ?? "absent" };
}

/** Section 1: Kit's seat on Money Wedding, read by the other owner. */
export async function holderSeatSteps(flow: Flow, page: Page): Promise<void> {
  const { weddingId } = CIRE_ORGANISER.money;
  const seat = await flow.step("Money Wedding: the hosts panel marks Kit's seat", async () => {
    await page.goto(`${ORIGINS.cireHost}/#/w/${weddingId}/settings/hosts`);
    const kit = rowWithSelect(page, `Role for ${KIT}`);
    const note = kit.getByTestId("payout-holder-note");
    await expect(note).toBeVisible();
    const own = rowWithSelect(page, "Your role on this wedding");
    await expect(own).toBeVisible();
    await kit.scrollIntoViewIfNeeded();
    await shoot(page, SHOTS, "holder-seat.png");
    return {
      note: (await note.textContent()) ?? "",
      select: await lockedBy(kit.getByRole("combobox", { name: `Role for ${KIT}` }), note),
      // A seat whose handle OSN cannot resolve is "Remove host" (the stack resolves none).
      remove: await lockedBy(kit.getByRole("button", { name: "Remove host" }), note),
      ownNotes: await own.getByTestId("payout-holder-note").count(),
    };
  });
  flow.check(
    "Kit's seat says Kit connected the account and how to free it",
    true,
    /connected the Stripe account money gifts are paid into/.test(seat.note) &&
      /replace it with your own account/.test(seat.note),
  );
  flow.check("Kit's role select is marked disabled", "true", seat.select.disabled);
  flow.check("Kit's role select is described by the note", true, seat.select.describedByNote);
  flow.check("Kit's Remove is marked disabled", "true", seat.remove.disabled);
  flow.check("Kit's Remove is described by the note", true, seat.remove.describedByNote);
  flow.check("the dev profile's own row carries no note", 0, seat.ownNotes);

  const removed = await flow.step("cire-api: removing Kit is refused", () =>
    deleteSeat(flow, page, weddingId, KIT),
  );
  flow.check("cire-api removal of the holder", 409, removed.status);
  flow.check("cire-api says the holder holds the account", "holds_payout_account", removed.error);
  flow.check("Kit is still an owner of Money Wedding", "owner", roleOf(weddingId, KIT));
}

/** Section 2: the dev profile holds Handover Wedding's account, and hands it to Kit. */
export async function handOverSteps(flow: Flow, page: Page): Promise<void> {
  const { weddingId, accountId } = CIRE_ORGANISER.handover;
  const hostsUrl = `${ORIGINS.cireHost}/#/w/${weddingId}/settings/hosts`;

  const own = await flow.step(
    "Handover Wedding: the hosts panel holds the dev profile's own seat",
    async () => {
      await page.goto(hostsUrl);
      const row = rowWithSelect(page, "Your role on this wedding");
      const note = row.getByTestId("payout-holder-note");
      await expect(note).toBeVisible();
      const leave = page.getByRole("button", { name: "Leave this wedding" });
      const leaveNote = page.getByTestId("leave-payout-holder-note");
      await expect(leaveNote).toBeVisible();
      await row.scrollIntoViewIfNeeded();
      await shoot(page, SHOTS, "own-seat.png");
      return {
        note: (await note.textContent()) ?? "",
        select: await lockedBy(
          row.getByRole("combobox", { name: "Your role on this wedding" }),
          note,
        ),
        leave: await lockedBy(leave, leaveNote),
        kitNotes: await rowWithSelect(page, `Role for ${KIT}`)
          .getByTestId("payout-holder-note")
          .count(),
      };
    },
  );
  flow.check(
    "the dev profile's seat says to hand money gifts over first",
    true,
    /^You connected the Stripe account money gifts are paid into\. Hand money gifts to another owner or disconnect your account in Money gifts before you leave or step down\.$/.test(
      own.note.trim(),
    ),
  );
  flow.check("its own role select is marked disabled", "true", own.select.disabled);
  flow.check("its own role select is described by the note", true, own.select.describedByNote);
  flow.check("Leave this wedding is marked disabled", "true", own.leave.disabled);
  flow.check("Leave this wedding is described by its note", true, own.leave.describedByNote);
  flow.check("Kit's row carries no note", 0, own.kitNotes);

  const left = await flow.step("cire-api: the holder's leave is refused", () =>
    deleteSeat(flow, page, weddingId, "me"),
  );
  flow.check("cire-api leave as the holder", 409, left.status);
  flow.check("cire-api says the leaver holds the account", "holds_payout_account", left.error);
  flow.check("the dev profile is still an owner there", "owner", roleOf(weddingId, DEV));

  const retireUrl = weddingApi(weddingId, "/registry/stripe/retire");
  const handed = await flow.step(
    "Handover Wedding: hand money gifts to Kit from the Money gifts panel",
    async () => {
      // From the holder's own note, by its link to Money gifts.
      await page.goto(hostsUrl);
      await rowWithSelect(page, "Your role on this wedding")
        .getByTestId("payout-holder-note")
        .getByRole("link", { name: "Money gifts" })
        .click();
      await expect(page).toHaveURL(new RegExp(`#/w/${weddingId}/registry/settings$`));
      await page.getByRole("button", { name: "Hand money gifts to another owner" }).click();
      const dialog = page.getByRole("dialog", { name: "Hand money gifts to another owner?" });
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText(KIT);
      const words = (await dialog.textContent()) ?? "";
      const answered = page.waitForResponse(
        (r) => r.url() === retireUrl && r.request().method() === "POST",
      );
      await dialog.getByRole("button", { name: "Hand over" }).click();
      const response = await answered;
      const status = page.getByTestId("stripe-status");
      await expect(status).toContainText("To let guests give money, connect a Stripe account");
      await expect(page.getByRole("button", { name: "Connect an account" })).toBeFocused();
      await status.scrollIntoViewIfNeeded();
      await shoot(page, SHOTS, "handed-over.png");
      return {
        status: response.status(),
        body: response.request().postData() ?? "",
        words,
      };
    },
  );
  flow.check("cire-api retires the account", 200, handed.status);
  flow.check(
    "the portal names Kit as the one money gifts go to",
    JSON.stringify({ handTo: KIT }),
    handed.body,
  );
  flow.check(
    "the dialog says gifts already given stay with the holder's account",
    true,
    /Gifts already given, and any refund or dispute on them, stay with your Stripe account/.test(
      handed.words,
    ),
  );
  const row = accountOf(weddingId);
  flow.check("Handover Wedding names no account", "absent", row?.account ?? "absent");
  flow.check("and no holder", "absent", row?.holder ?? "absent");
  flow.check("its account generation moved on once", 1, row?.generation ?? -1);
  flow.check("one retired account, handed over", `${accountId} handed_over`, retiredOf(weddingId));

  const steppedDown = await flow.step(
    "Handover Wedding: the dev profile's step-down to editor now goes through",
    async () => {
      await page.goto(hostsUrl);
      const select = page.getByRole("combobox", { name: "Your role on this wedding" });
      await expect(select).toBeVisible();
      await expect(page.getByTestId("payout-holder-note")).toHaveCount(0);
      const roleUrl = weddingApi(weddingId, `/hosts/${DEV}/role`);
      await select.selectOption("editor");
      const confirm = page.getByRole("dialog", { name: "Confirm this role change" });
      await expect(confirm).toBeVisible();
      const answered = page.waitForResponse(
        (r) => r.url() === roleUrl && r.request().method() === "PUT",
      );
      await confirm.getByRole("button", { name: "Yes, step down" }).click();
      return (await answered).status();
    },
  );
  flow.check("cire-api takes the step-down", 200, steppedDown);
  flow.check("the dev profile is an editor of Handover Wedding", "editor", roleOf(weddingId, DEV));
}

/**
 * Has the Stripe routes' limiter open a window of its own for section 3, by
 * its own answers rather than a clock (see the header): it spends what is left
 * of the window the flow's earlier calls opened, through the one Stripe route
 * that asks Stripe nothing (`…/stripe/accounts`), until the limiter refuses;
 * then asks again until a call passes, which is the first of a new window. A
 * refused call counts against nothing, so the new window holds that one call
 * and the section's four. These calls go outside the browser and are not
 * recorded, so `results.json` does not depend on how many were left. More than
 * 62 seconds after `lastStripeCall` (a `performance.now()` reading), every
 * window the earlier calls opened has closed, so it asks nothing; the step is
 * recorded either way, so the run's steps read the same on every machine.
 */
async function openStripeWindow(
  flow: Flow,
  context: BrowserContext,
  lastStripeCall: number,
): Promise<void> {
  const url = weddingApi(CIRE_ORGANISER.absent.weddingId, "/registry/stripe/accounts");
  const status = async () =>
    (await context.request.get(url, { headers: { origin: ORIGINS.cireHost } })).status();
  await flow.step("let the Stripe routes' limiter open a window for this section", async () => {
    if (performance.now() - lastStripeCall > 62_000) return;
    let refused = false;
    // One call at a time: each must be counted before the next is asked.
    // oxlint-disable-next-line no-await-in-loop
    for (let calls = 0; calls < 25 && !refused; calls += 1) refused = (await status()) === 429;
    expect(refused, "the limiter refuses once its window is spent").toBe(true);
    await expect.poll(status, { intervals: [2_000], timeout: 80_000 }).toBe(200);
  });
}

/** Section 3: replace the account of Absent Holder Wedding, whose holder is an editor now. */
export async function replaceAbsentHolderSteps(
  flow: Flow,
  context: BrowserContext,
  lastStripeCall: number,
): Promise<void> {
  const { weddingId, accountId } = CIRE_ORGANISER.absent;
  const registryUrl = weddingApi(weddingId, "/registry");
  const settingsUrl = weddingApi(weddingId, "/registry/settings");
  const stripeUrl = (leaf: string) => weddingApi(weddingId, `/registry/stripe/${leaf}`);
  const panelUrl = `${ORIGINS.cireHost}/#/w/${weddingId}/registry/settings`;
  const page = await flow.newPage(context);

  await openStripeWindow(flow, context, lastStripeCall);

  const read = await flow.step(
    "Absent Holder Wedding: the Money gifts panel says why guests can't give",
    async () => {
      const loaded = page.waitForResponse(
        (r) => r.url() === registryUrl && r.request().method() === "GET",
      );
      await page.goto(panelUrl);
      const body = (await (await loaded).json()) as {
        settings?: { payoutHolderAbsent?: unknown; moneyGiftsBlockedBy?: unknown };
      };
      const status = page.getByTestId("stripe-status");
      await expect(status).toContainText("held by a current owner");
      const money = page.getByRole("checkbox", { name: "Let guests give money" });
      return {
        absent: String(body.settings?.payoutHolderAbsent ?? "missing"),
        blockedBy: String(body.settings?.moneyGiftsBlockedBy ?? "missing"),
        words: (await status.textContent()) ?? "",
        switchDisabled: await money.isDisabled(),
        useOwn: await page.getByRole("button", { name: "Use your own account" }).count(),
      };
    },
  );
  flow.check("the registry read says the holder is absent", "true", read.absent);
  flow.check(
    "the registry read names why guests can't give money",
    "payout_holder_absent",
    read.blockedBy,
  );
  flow.check(
    "the panel says the account isn't held by a current owner",
    true,
    /Guests can.t give money right now\. This Stripe account isn.t held by a current owner of this wedding/.test(
      read.words,
    ),
  );
  flow.check("the money switch can't be turned on", true, read.switchDisabled);
  flow.check("the panel offers to use the owner's own account", 1, read.useOwn);

  const turnedOn = await flow.step("cire-api: money gifts can't be turned on", async () => {
    const response = await context.request.put(settingsUrl, {
      headers: { origin: ORIGINS.cireHost },
      data: { cashGiftsEnabled: true, expected: { cashGiftsEnabled: false } },
    });
    flow.recordRequest("PUT", settingsUrl, response.status());
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    return { status: response.status(), error: body.error ?? "absent" };
  });
  flow.check("cire-api settings save turning money on", 409, turnedOn.status);
  flow.check("cire-api says the holder is absent", "payout_holder_absent", turnedOn.error);

  const before = await standInCalls();
  const replaced = await flow.step(
    "Absent Holder Wedding: use the owner's own account, a new one at Stripe",
    async () => {
      let sentTo = "";
      // Stripe's own onboarding page, which the stack cannot reach.
      await page.route("https://connect.stripe.com/**", async (route) => {
        sentTo = route.request().url();
        await route.fulfill({
          status: 200,
          contentType: "text/html",
          body: "<!doctype html><title>Stripe</title><p>Stripe's onboarding page</p>",
        });
      });
      const retired = page.waitForResponse(
        (r) => r.url() === stripeUrl("retire") && r.request().method() === "POST",
      );
      const listed = page.waitForResponse(
        (r) => r.url() === stripeUrl("accounts") && r.request().method() === "GET",
      );
      await page.getByRole("button", { name: "Use your own account" }).click();
      const retire = await retired;
      const accounts = await listed;
      const choice = page.getByTestId("stripe-account-choice");
      await expect(choice).toBeVisible();
      await choice.getByRole("radio", { name: /^A new account for this wedding/ }).check();
      const started = page.waitForResponse(
        (r) => r.url() === stripeUrl("session") && r.request().method() === "POST",
      );
      await page.getByRole("button", { name: "Continue to Stripe" }).click();
      const session = await started;
      await page.waitForURL(/^https:\/\/connect\.stripe\.com\//);
      await page.unroute("https://connect.stripe.com/**");
      return {
        retire: retire.status(),
        retireBody: retire.request().postData() ?? "",
        accounts: accounts.status(),
        session: session.status(),
        sentTo: new URL(sentTo).origin,
      };
    },
  );
  const after = await standInCalls();
  flow.check("cire-api retires the absent holder's account", 200, replaced.retire);
  flow.check(
    "the portal names no one to hand to",
    JSON.stringify({ handTo: null }),
    replaced.retireBody,
  );
  flow.check("cire-api lists the owner's accounts", 200, replaced.accounts);
  flow.check("cire-api starts onboarding", 200, replaced.session);
  flow.check(
    "the browser goes to Stripe's Connect host",
    "https://connect.stripe.com",
    replaced.sentTo,
  );
  flow.check("the stand-in made one account", before.accountCreate + 1, after.accountCreate);
  flow.check("and one onboarding link", before.accountLink + 1, after.accountLink);
  flow.check(
    "one retired account, its holder absent",
    `${accountId} holder_absent`,
    retiredOf(weddingId),
  );
  const row = accountOf(weddingId);
  flow.check(
    "the row names a new Express account from the stand-in",
    true,
    (row?.account ?? "").startsWith("acct_e2eExpress"),
  );
  flow.check("its holder is the dev profile", DEV, row?.holder ?? "absent");
  flow.check("its account generation moved on once", 1, row?.generation ?? -1);

  const back = await flow.step(
    "Absent Holder Wedding: the panel shows the new account",
    async () => {
      await page.goto(panelUrl);
      const status = page.getByTestId("stripe-status");
      await expect(status).toContainText("still wants something");
      await expect(page.getByRole("button", { name: "Continue on Stripe" })).toBeVisible();
      await status.scrollIntoViewIfNeeded();
      await shoot(page, SHOTS, "replaced.png");
      return (await status.textContent()) ?? "";
    },
  );
  flow.check(
    "the panel says Stripe still wants something from the owner",
    true,
    /Stripe has your account but still wants something before it can take payments/.test(back),
  );
}
