/**
 * The starter checklist: the tasks cire suggests to a couple who open an empty
 * checklist, each due a fixed number of days before the wedding date.
 *
 * This file is the whole of its content, kept apart so it can be reviewed on
 * its own. The rules every entry keeps:
 *
 * - It assumes nothing about the kind of ceremony, faith, culture or who is
 *   marrying whom, and names no family role. A couple deletes what does not
 *   apply, so a short neutral list beats a long specific one.
 * - `key` is the item's identity for good. A task seeded from it carries the
 *   key, and applying the starter again skips a key the wedding already has
 *   (or deleted). Reword a `title` freely; never rename or reuse a `key`.
 * - A `title` is copied into the task when the couple applies the starter, so
 *   a later rewording changes only weddings that apply it afterwards.
 * - Each item's due date is its bucket's offset below, counted from the wedding
 *   date. Without a wedding date the task has no due date until one is set.
 */
import type { TimeframeBucket } from "./checklist-buckets";

/** Days from the wedding date to the due date of an item in each bucket.
 *  Negative is before the day; `day_of` is the day itself. */
export const STARTER_OFFSET_DAYS = {
  "12m": -365,
  "9m": -270,
  "6m": -180,
  "3m": -90,
  "1m": -30,
  "2w": -14,
  week_of: -7,
  day_of: 0,
} as const satisfies Record<TimeframeBucket, number>;

export interface StarterItem {
  /** Stable identity; lower-case words joined by hyphens. Never renamed. */
  readonly key: string;
  readonly bucket: TimeframeBucket;
  readonly title: string;
}

/** In display order: bucket by bucket, then the order within each bucket. */
export const STARTER_ITEMS = [
  { key: "agree-budget", bucket: "12m", title: "Agree on an overall budget" },
  { key: "draft-guest-list", bucket: "12m", title: "Draft a first guest list" },
  { key: "book-venues", bucket: "12m", title: "Visit and book your venues" },

  { key: "book-key-suppliers", bucket: "9m", title: "Book the suppliers you most want" },
  { key: "send-save-the-dates", bucket: "9m", title: "Send save-the-dates" },
  {
    key: "guest-travel-stay",
    bucket: "9m",
    title: "Look into travel and places to stay for guests coming from afar",
  },

  { key: "plan-outfits", bucket: "6m", title: "Plan what you will wear" },
  { key: "book-other-suppliers", bucket: "6m", title: "Book the remaining suppliers" },
  { key: "design-invitations", bucket: "6m", title: "Design your invitations" },

  { key: "set-rsvp-deadline", bucket: "3m", title: "Choose the date replies are due by" },
  { key: "send-invitations", bucket: "3m", title: "Send your invitations" },
  { key: "check-paperwork", bucket: "3m", title: "Check any legal paperwork and its deadlines" },

  { key: "chase-replies", bucket: "1m", title: "Follow up on missing replies" },
  { key: "confirm-numbers", bucket: "1m", title: "Confirm final guest numbers with suppliers" },
  {
    key: "share-dietary-needs",
    bucket: "1m",
    title: "Send guests' dietary needs to whoever is providing the food",
  },

  { key: "confirm-timings", bucket: "2w", title: "Confirm timings with every supplier" },
  {
    key: "share-plan-for-the-day",
    bucket: "2w",
    title: "Share the plan for the day with everyone helping",
  },

  { key: "settle-balances", bucket: "week_of", title: "Pay any balances due before the day" },
  { key: "pack-for-the-day", bucket: "week_of", title: "Pack what you need for the day" },

  {
    key: "hand-over-contacts",
    bucket: "day_of",
    title: "Give someone you trust the supplier contacts and the plan",
  },
] as const satisfies readonly StarterItem[];
