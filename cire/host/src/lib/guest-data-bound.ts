// The words of the guest-data bound warning. Frontend code: no Effect.
import type { GuestDataBound } from "../components/CreateWeddingForm";

/** What `GuestDataBoundNotice` draws: the tone, a first line, the rest, and the
 *  button's words. */
export interface GuestDataBoundWords {
  tone: "warn" | "danger";
  headline: string;
  detail: string;
  action: string;
}

/** How the editor names an event with no name. */
const UNTITLED = "Untitled event";

/** "Ceremony, Reception and Party". Joined by hand: runtimes' list data
 *  disagree on the comma before "and" in `en-AU`. */
const listOf = (names: string[]) =>
  names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;

/**
 * "this event: Ceremony", "these events: Ceremony, Reception, Party and 2
 * more", or "one of its events" when the list came without names.
 */
function whichEvents(bound: GuestDataBound): string {
  const names = bound.events.map((name) => (name.trim() === "" ? UNTITLED : name));
  if (names.length === 0) return "one of its events";
  const more = Math.max(bound.eventCount - names.length, 0);
  if (more === 0 && names.length === 1) return `this event: ${names[0]}`;
  return `these events: ${listOf(more > 0 ? [...names, `${more} more`] : names)}`;
}

/** What one reason adds to the words. */
interface ReasonWords {
  /** What the guest list holds that goes. */
  what: string;
  /** Why the three years apply, before the wedding is that old. */
  near: string;
  /** Why they apply, once it is. */
  passed: string;
  /** What ends it. */
  until: string;
  /** What is lost again until then. */
  added: string;
  action: string;
}

function reasonWords(bound: GuestDataBound): ReasonWords | null {
  switch (bound.reason) {
    case "unreadable-date": {
      const which = whichEvents(bound);
      return {
        what: "every household and guest, with their email addresses, replies, seats and gift messages",
        near: `Cire can't read the date and time of ${which}, and a wedding like this`,
        passed: `This wedding is more than three years old, and Cire can't read the date and time of ${which}.`,
        until: "every event has a date and time",
        added: "any household, guest or reply added to it",
        action: "Edit events",
      };
    }
    case "no-events":
      return {
        what: "every household and guest, with their email addresses and gift messages",
        near: "This wedding has no events, and a wedding without one",
        passed: "This wedding is more than three years old and has no events.",
        until: "it has an event with a date and time",
        added: "any household or guest added to it",
        action: "Add an event",
      };
    default:
      return null;
  }
}

/**
 * The warning's words, or null for a state, a reason or a day this portal
 * does not know, so a newer API's answer draws nothing rather than nonsense.
 *
 * The day is the bound instant's date in the reader's own zone: the sweep
 * never runs before that instant, so "from" that date holds wherever the
 * reader is. The fix is never promised as a reprieve: once every event reads,
 * the wedding keeps its guest list until a year after its last event, and
 * that year may already be over.
 */
export function guestDataBoundWords(bound: GuestDataBound): GuestDataBoundWords | null {
  const from = new Date(bound.from);
  const reason = reasonWords(bound);
  if (Number.isNaN(from.getTime()) || reason === null) return null;
  switch (bound.state) {
    case "near": {
      const day = new Intl.DateTimeFormat("en-AU", {
        day: "numeric",
        month: "long",
        year: "numeric",
      }).format(from);
      return {
        tone: "warn",
        headline: `From ${day}, Cire will delete this wedding's guest list.`,
        detail:
          `That is ${reason.what}. ${reason.near} keeps its guest list for three years from ` +
          `the day it was created. Once ${reason.until}, Cire keeps the guest list until a ` +
          `year after the wedding's last event instead, which may be sooner.`,
        action: reason.action,
      };
    }
    case "passed":
      return {
        tone: "danger",
        headline: "Cire is deleting this wedding's guest list.",
        detail:
          `${reason.passed} Until ${reason.until}, Cire keeps deleting the guest list, and ` +
          `${reason.added}. After that, Cire keeps the guest list until a year after the ` +
          `wedding's last event.`,
        action: reason.action,
      };
    default:
      return null;
  }
}
