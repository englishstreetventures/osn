export interface DressSwatch {
  name: string;
  color: string;
}

/**
 * Normalised crop rectangle in source fractions (0..1). Mirrors `ImageCrop` in
 * cire/api. `natW`/`natH` are the source image's natural pixel dimensions
 * (optional — present on crops saved by the current editor, absent on legacy
 * crops); they give the display box the crop's true pixel aspect so the guest
 * render fills it with no distortion.
 */
export interface ImageCrop {
  x: number;
  y: number;
  w: number;
  h: number;
  natW?: number;
  natH?: number;
}

export interface EventSummary {
  id: string;
  name: string;
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
  /**
   * Normalised crop rectangle `{x,y,w,h}` (0..1 source fractions, migration 0021)
   * the organiser chose for this event's image, or null for the default centre
   * `object-cover`. Applied in CSS by the event card. Optional so a mid-deploy
   * payload (older API) or a test fixture without it falls back to no crop.
   */
  imageCrop?: ImageCrop | null;
}

export interface FamilyMember {
  guestId: string;
  firstName: string;
  lastName: string;
  /** Optional informal name for the single-guest greeting; null ⇒ use firstName. */
  nickname: string | null;
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
