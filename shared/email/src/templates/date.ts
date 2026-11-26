/**
 * Dates as the account emails write them. The sender cannot know the reader's
 * time zone, so every date is UTC's, and a day on its own names its zone.
 */

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

/** "23 November 2026": the date in UTC. */
export const utcDate = (unixSeconds: number): string => {
  const at = new Date(unixSeconds * 1_000);
  return `${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]} ${at.getUTCFullYear()}`;
};

/**
 * "23 November 2026 (UTC)": a day on its own names its zone, since the same
 * day starts up to 26 hours apart across zones, and a line that offers
 * something "before" it holds only in the zone it names.
 */
export const utcDay = (unixSeconds: number): string => `${utcDate(unixSeconds)} (UTC)`;
