import { Schema } from "effect";

import { PURCHASABLE_TIERS } from "../services/upgrade-catalogue";

/**
 * The longest `module` a body may name. Every portal module id is far shorter;
 * the bound only stops a body from carrying an arbitrary string as far as the
 * route's allow-list.
 */
const MAX_MODULE_CHARS = 32;

/**
 * `POST /upgrade/session`. `tier` is one of the tiers sold self-serve, taken
 * from the same list the route and the catalogue sell from, so the three cannot
 * disagree. `module` is where Stripe sends the organiser back to; the route
 * still checks it against the portal's module list, and anything that is not
 * on it lands on Overview.
 */
export const StartUpgradeSessionBody = Schema.Struct({
  tier: Schema.Literals(PURCHASABLE_TIERS),
  module: Schema.optional(Schema.String.check(Schema.isMaxLength(MAX_MODULE_CHARS))),
});
export type StartUpgradeSessionBody = Schema.Schema.Type<typeof StartUpgradeSessionBody>;
