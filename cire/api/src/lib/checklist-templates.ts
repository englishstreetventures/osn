/**
 * The checklist templates a couple can seed tasks from, by id. A seeded task
 * stores the template id and the item key (`tasks.template_id`,
 * `tasks.template_item`), so both are identities: an id or key, once shipped,
 * is never renamed or reused.
 */
import type { TimeframeBucket } from "./checklist-buckets";
import { STARTER_ITEMS, STARTER_OFFSET_DAYS } from "./checklist-starter";

export interface ChecklistTemplateItem {
  readonly key: string;
  readonly title: string;
  readonly timeframeBucket: TimeframeBucket;
  /** Days from the wedding date to the item's due date (negative = before).
   *  Null for an item with no date of its own. */
  readonly offsetDays: number | null;
}

export const CHECKLIST_TEMPLATES = {
  starter: STARTER_ITEMS.map((item): ChecklistTemplateItem => ({
    key: item.key,
    title: item.title,
    timeframeBucket: item.bucket,
    offsetDays: STARTER_OFFSET_DAYS[item.bucket],
  })),
} as const satisfies Record<string, readonly ChecklistTemplateItem[]>;

export type ChecklistTemplateId = keyof typeof CHECKLIST_TEMPLATES;

export const CHECKLIST_TEMPLATE_IDS = Object.keys(CHECKLIST_TEMPLATES) as ChecklistTemplateId[];

export function isChecklistTemplateId(value: string): value is ChecklistTemplateId {
  return Object.hasOwn(CHECKLIST_TEMPLATES, value);
}

/**
 * `date` (`YYYY-MM-DD`) moved by `days`, as `YYYY-MM-DD` — the same answer
 * SQLite's `date(date, '<days> days')` gives, which is what stores a seeded
 * task's due date. Worked in UTC so no local offset or daylight-saving change
 * moves the day, and through `setUTCFullYear` because `Date.UTC` reads a year
 * below 100 as 19xx.
 */
export function addDays(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  const at = new Date(0);
  at.setUTCFullYear(year, month - 1, day + days);
  return at.toISOString().slice(0, 10);
}
