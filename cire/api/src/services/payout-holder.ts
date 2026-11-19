/**
 * Who holds a wedding's payout account in good standing: the one rule.
 *
 * A wedding's cash gifts are paid into one Stripe account, which carries the
 * identity and bank of the person who connected it
 * (`registry_settings.stripe_connected_by_osn_profile_id`, the account's
 * HOLDER). The holder is in good standing while they hold an `owner` seat on
 * that wedding. The account's holder is ABSENT when there is an account and its
 * holder holds no owner seat there, or no holder is recorded.
 *
 * Every reader asks through these two builders, so the settings the portal
 * reads, the hosts list and every later reader agree. Whether the holder is
 * seated is never stored: each is one `EXISTS` answered by
 * `wedding_hosts_wedding_profile_uniq`, or by `registry_settings`' primary key.
 *
 * A second kind of holder (an organisation attached to the wedding) joins this
 * rule here, not as a second rule elsewhere.
 */

import { registrySettings, weddingHosts } from "@cire/db";
import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import { outerColumn } from "../db";

/** A settings row as a statement around the predicate names it. */
interface SettingsColumns {
  readonly weddingId: SQL;
  readonly accountId: SQL;
  readonly holder: SQL;
}

/** `registry_settings`' own columns, qualified, for a statement over that table. */
export const SETTINGS_ROW: SettingsColumns = {
  weddingId: outerColumn(registrySettings.weddingId),
  accountId: outerColumn(registrySettings.stripeAccountId),
  holder: outerColumn(registrySettings.stripeConnectedByOsnProfileId),
};

/**
 * 1 when the row names an account whose holder holds no owner seat on its
 * wedding, or names no holder; 0 otherwise, a row with no account included.
 * The columns are passed qualified (see `outerColumn`): `wedding_hosts` has a
 * `wedding_id` of its own, which a bare name would bind to.
 */
export const payoutHolderAbsentSql = (row: SettingsColumns = SETTINGS_ROW): SQL<number> =>
  sql<number>`(${row.accountId} IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM ${weddingHosts} payout_seat
    WHERE payout_seat.wedding_id = ${row.weddingId}
      AND payout_seat.osn_profile_id = ${row.holder}
      AND payout_seat.role = 'owner'))`;

/**
 * 1 when `osnProfileId` is the holder of the account `weddingId` names now.
 * Says nothing of their seat: a caller that needs the holder in good standing
 * also asks that the seat is an owner's.
 */
export const holdsPayoutAccountSql = (weddingId: SQL, osnProfileId: SQL): SQL<number> =>
  sql<number>`EXISTS (
    SELECT 1 FROM ${registrySettings} payout_row
    WHERE payout_row.wedding_id = ${weddingId}
      AND payout_row.stripe_account_id IS NOT NULL
      AND payout_row.stripe_connected_by_osn_profile_id = ${osnProfileId})`;
