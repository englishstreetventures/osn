// Single source of truth for the marketing site's external targets and imagery.
// Centralised so the apex cutover (organiser → host.cireweddings.com, invites →
// invite.cireweddings.com) and any asset swap are one-line edits, not a hunt
// through markup. See [[wiki/apps/cire-landing]].

/**
 * Organiser portal — target of every primary "Create your invitation" CTA.
 * Build-time override via PUBLIC_ORGANISER_URL; the default is the local
 * organiser dev server so `bun run dev` works without env wiring. End-state prod
 * value is https://host.cireweddings.com (set in deploy.yml at cutover).
 */
export const ORGANISER_URL = import.meta.env.PUBLIC_ORGANISER_URL ?? "http://localhost:4322";

/**
 * "See a live invite" CTA. When PUBLIC_DEMO_INVITE_URL points at a real seeded
 * invitation we link out to it; otherwise the CTA is an in-page anchor to the
 * interactive (no-op) demo below the fold — see {@link DEMO_ANCHOR}.
 */
export const DEMO_INVITE_URL = import.meta.env.PUBLIC_DEMO_INVITE_URL ?? null;

/** Fragment id of the in-page interactive demo invite section. */
export const DEMO_ANCHOR = "#see-it-live";

export const SITE_NAME = "Cire";
export const SITE_TAGLINE = "Invitations worthy of the moment";
export const SITE_DESCRIPTION =
  "Cire is a bespoke digital wedding invitation: tactile, animated and personal as handcrafted paper, with every RSVP tracked for you. Share one link, and watch the replies roll in.";

/**
 * Hotlinked Unsplash imagery. These load in the visitor's browser straight from
 * Unsplash's CDN (the build never downloads them), which is how Unsplash intends
 * hosted images to be used. They are tasteful PLACEHOLDERS — swap `src` for the
 * couple's / brand's own art when it exists; every image also paints over a gold
 * gradient so a slow or failed load never leaves an empty hole. `credit` is
 * surfaced in the page source / a visually-muted line where required by the
 * Unsplash licence.
 */
export interface SiteImage {
  /** Unsplash photo id (the `photo-...` slug); the URL is composed in `img()`. */
  readonly id: string;
  readonly alt: string;
  readonly credit: string;
}

/** Compose a responsive Unsplash delivery URL for a photo id. */
export function unsplash(id: string, width = 1600): string {
  return `https://images.unsplash.com/${id}?auto=format&fit=crop&w=${width}&q=80`;
}

export const IMAGES = {
  // Hero backdrop — an intimate, candle-warm celebration. Portrait-friendly crop.
  hero: {
    id: "photo-1519741497674-611481863552",
    alt: "An elegant wedding table set with candles and florals at dusk",
    credit: "Photo: Thomas William / Unsplash",
  },
  // Feature: animated reveal — stationery / wax-seal flatlay.
  reveal: {
    id: "photo-1606216794074-735e91aa2c92",
    alt: "A wax-sealed envelope resting on handwritten wedding stationery",
    credit: "Photo: Annie Spratt / Unsplash",
  },
  // Feature: personalised greetings — a couple sharing a private moment.
  personal: {
    id: "photo-1519225421980-715cb0215aed",
    alt: "A couple embracing, framed by soft greenery",
    credit: "Photo: Nathan Dumlao / Unsplash",
  },
  // Feature: RSVPs + dashboard — guests celebrating together.
  rsvp: {
    id: "photo-1522673607200-164d1b6ce486",
    alt: "Wedding guests raising a toast in celebration",
    credit: "Photo: Al Elmes / Unsplash",
  },
  // Feature: details, maps, calendar — a venue / reception scene.
  details: {
    id: "photo-1464366400600-7168b8af9bc3",
    alt: "A candlelit reception venue dressed for an evening celebration",
    credit: "Photo: Photos by Lanty / Unsplash",
  },
  // Feature: moodboards / theming — florals and colour palette.
  moodboard: {
    id: "photo-1525258946800-98cfd641d0de",
    alt: "Soft blush and sage wedding florals arranged on linen",
    credit: "Photo: Sweet Ice Cream Photography / Unsplash",
  },
  // Closing / craft section — a quiet, considered detail shot.
  craft: {
    id: "photo-1511285560929-80b456fea0bc",
    alt: "A beautifully laid place setting with a handwritten name card",
    credit: "Photo: Jonathan Borba / Unsplash",
  },
} as const satisfies Record<string, SiteImage>;
