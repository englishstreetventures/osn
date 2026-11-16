/**
 * Pulse's first-run onboarding, walked to the end: the six steps of
 * `OnboardingStepper` from `/welcome`, with two interests chosen, location and
 * notifications granted, and event reminders left on, then the row
 * `POST /me/onboarding/complete` writes.
 *
 * `pulse-event-rsvp` calls it for the guest, whose sign-in stops on `/welcome`;
 * the host skips, so both paths have a flow. The caller's context grants
 * geolocation and notifications and sets a position, so neither permission
 * waits on a prompt. Step 6 draws today's date from the page clock, so no step
 * here takes a screenshot. Leaves the page on `/`.
 */

import type { Page } from "@playwright/test";

import { DB_FILES, ORIGINS } from "../../src/config";
import { expect, onSuiteClock, queryOne, type Flow } from "./fixtures";

/** The two interests the walk picks: their chip labels and their wire values, in order. */
const INTERESTS = [
  { label: "Music", value: "music" },
  { label: "Tech", value: "tech" },
] as const;

/** `Step5Notifications`' checkbox, which a grant ticks. */
const REMINDERS = "Remind me before events I'm going to";

/** The account behind a profile handle, read from osn-api's database. */
export function accountIdFor(handle: string): string | undefined {
  return queryOne<{ account_id: string }>(
    DB_FILES.osn,
    "SELECT account_id FROM users WHERE handle = ?",
    handle,
  )?.account_id;
}

export async function walkPulseOnboarding(
  flow: Flow,
  page: Page,
  person: { readonly handle: string; readonly name: string },
): Promise<void> {
  const primary = (name: string) => page.getByRole("button", { name, exact: true });

  await flow.step("onboarding: step 1, welcome", async () => {
    await expect(page).toHaveURL(`${ORIGINS.pulseWeb}/welcome`);
    await expect(
      page.getByText(`Glad you're here, ${person.name}. Let's set up what you want to see.`),
    ).toBeVisible();
    await primary("Get started").click();
  });

  await flow.step("onboarding: step 2, what Pulse is for", async () => {
    await expect(page.getByRole("heading", { name: "Discover what's happening" })).toBeVisible();
    await primary("Continue").click();
  });

  await flow.step("onboarding: step 3, pick interests", async () => {
    await expect(page.getByRole("heading", { name: "What are you into?" })).toBeVisible();
    for (const interest of INTERESTS) {
      const chip = primary(interest.label);
      await chip.click();
      await expect(chip).toHaveAttribute("aria-pressed", "true");
    }
    await primary("Continue").click();
  });

  await flow.step("onboarding: step 4, allow location", async () => {
    await expect(page.getByRole("heading", { name: "See what's nearby" })).toBeVisible();
    await primary("Allow location").click();
    await expect(page.getByText("Location enabled — events nearby ready.")).toBeVisible();
    await primary("Continue").click();
  });

  await flow.step("onboarding: step 5, allow notifications", async () => {
    await expect(page.getByRole("heading", { name: "Stay in the loop" })).toBeVisible();
    await primary("Allow notifications").click();
    await expect(page.getByText("Notifications enabled.")).toBeVisible();
    const reminders = page.getByRole("checkbox", { name: REMINDERS });
    // The grant ticks the box; the walk takes it off and puts it back.
    await expect(reminders).toBeChecked();
    await reminders.uncheck();
    await expect(reminders).not.toBeChecked();
    await reminders.check();
    await expect(reminders).toBeChecked();
    await primary("Continue").click();
  });

  const completed = await flow.step("onboarding: step 6, start exploring", async () => {
    await expect(page.getByRole("heading", { name: `You're in, ${person.name}.` })).toBeVisible();
    const response = page.waitForResponse(
      (r) =>
        r.request().method() === "POST" && r.url() === `${ORIGINS.pulseApi}/me/onboarding/complete`,
    );
    await primary("Start exploring").click();
    const status = (await response).status();
    await expect(page).toHaveURL(`${ORIGINS.pulseWeb}/`);
    await expect(
      page.getByRole("textbox", { name: "Search events, people, venues" }),
    ).toBeVisible();
    return status;
  });
  flow.check("onboarding: POST /me/onboarding/complete status", 200, completed);

  const account = accountIdFor(person.handle);
  flow.check("onboarding: the account is in osn-api's database", true, account !== undefined);
  const row = queryOne<{
    interests: string;
    notifications_opt_in: number;
    event_reminders_opt_in: number;
    notifications_perm: string;
    location_perm: string;
    completed_at: number;
  }>(
    DB_FILES.pulse,
    `SELECT interests, notifications_opt_in, event_reminders_opt_in, notifications_perm,
            location_perm, completed_at
       FROM pulse_account_onboarding WHERE account_id = ?`,
    account ?? "",
  );
  flow.check(
    "onboarding row: interests",
    JSON.stringify(INTERESTS.map((i) => i.value)),
    row?.interests ?? "missing",
  );
  flow.check("onboarding row: notifications_opt_in", 1, row?.notifications_opt_in ?? -1);
  flow.check("onboarding row: event_reminders_opt_in", 1, row?.event_reminders_opt_in ?? -1);
  flow.check("onboarding row: notifications_perm", "granted", row?.notifications_perm ?? "missing");
  flow.check("onboarding row: location_perm", "granted", row?.location_perm ?? "missing");
  flow.check(
    "onboarding row: completed_at on the suite clock",
    true,
    onSuiteClock(row?.completed_at),
  );
}
