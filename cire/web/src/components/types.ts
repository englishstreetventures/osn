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
  members: FamilyMember[];
  events: EventSummary[];
  rsvps: RsvpSummary[];
}
