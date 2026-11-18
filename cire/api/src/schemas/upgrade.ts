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

/**
 * The Refund a platform `refund.failed` event carries, as far as cire reads
 * it. Stripe signs the body, so this is not a trust boundary; it holds the
 * values that reach a query and a log to a shape cire made. `purchaseId` is
 * the `upg_<uuid>` cire puts in a refund's metadata, so a refund some other
 * integration made, naming anything else, is not read as cire's.
 */
export const RefundFailedObject = Schema.Struct({
  id: Schema.String.check(Schema.isMaxLength(255), Schema.isPattern(/^re_[A-Za-z0-9_]+$/)),
  payment_intent: Schema.optional(Schema.NullOr(Schema.String.check(Schema.isMaxLength(255)))),
  metadata: Schema.Struct({
    purchaseId: Schema.String.check(
      Schema.isPattern(/^upg_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
    ),
  }),
});
