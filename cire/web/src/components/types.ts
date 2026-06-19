export interface DressSwatch {
  name: string;
  color: string;
}

export interface EventSummary {
  id: string;
  name: string;
  /** Deprecated: prefer startAt / endAt. Kept for transition. */
  date: string;
  /** Deprecated: prefer address. Kept for transition. */
  location: string;
  description: string;
  startAt: string;
  endAt: string;
  timezone: string;
  address: string | null;
  dressCodeDescription: string | null;
  dressCodePalette: DressSwatch[] | null;
  pinterestUrl: string | null;
  mapsUrl: string | null;
  sortOrder: number;
  /**
   * First-party path to this event's optional image (migration 0019), or null
   * when none. Carries a `?v=` cache-buster; the guest site prepends its API
   * origin before use. Null ⇒ the card renders text-only at every breakpoint.
   */
  imageUrl: string | null;
}

export interface FamilyMember {
  guestId: string;
  firstName: string;
  lastName: string;
  eventIds: string[];
}

export interface RsvpSummary {
  guestId: string;
  eventId: string;
  status: "attending" | "declined" | "maybe";
  dietary: string;
}

export interface ClaimResult {
  publicId: string;
  familyName: string;
  /** True for the organiser host preview session — disables RSVP in the UI. */
  preview?: boolean;
  members: FamilyMember[];
  events: EventSummary[];
  rsvps: RsvpSummary[];
}
