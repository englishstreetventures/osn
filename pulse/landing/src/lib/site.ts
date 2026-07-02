// Single source of truth for the marketing site's external targets, copy and the
// colourful category palette. Centralised so a domain cutover or a content tweak
// is a one-line edit, not a hunt through markup.

/**
 * Pulse app — target of every primary "Find events" / "Get the app" CTA.
 * Build-time override via PUBLIC_APP_URL; the default is the local Pulse app dev
 * server so `bun run dev` works without env wiring. Prod value (the deployed
 * Pulse app origin) is set in deploy CI.
 */
export const APP_URL = import.meta.env.PUBLIC_APP_URL ?? "http://localhost:3001";

/** Fragment id of the in-page "How it works" section (secondary hero CTA). */
export const HOW_ANCHOR = "#how-it-works";

export const SITE_NAME = "Pulse";
export const SITE_TAGLINE = "Find your scene";
export const SITE_DESCRIPTION =
  "Pulse shows you what's happening near you tonight — discover events by location, " +
  "category, friends and interests, RSVP in a tap, and sync it all to your calendar. " +
  "The social ease of Facebook Events, the fun of Partiful and Luma, the tooling of Eventbrite.";

/**
 * A category — label, a serif/emoji glyph and the `--cat-*` colour token that
 * tints its chip. Drives the colourful category showcase. Each category is a
 * real Pulse discovery category; the glyph + colour are purely decorative.
 */
export interface Category {
  readonly label: string;
  /** A single display glyph (emoji or serif char). */
  readonly glyph: string;
  /** A `--cat-*` token name (without the leading `--`). */
  readonly color: `cat-${1 | 2 | 3 | 4 | 5 | 6}`;
}

export const CATEGORIES = [
  { label: "Music", glyph: "♪", color: "cat-1" },
  { label: "Nightlife", glyph: "✦", color: "cat-3" },
  { label: "Food & Drink", glyph: "✺", color: "cat-5" },
  { label: "Arts", glyph: "❋", color: "cat-4" },
  { label: "Sport", glyph: "◎", color: "cat-6" },
  { label: "Community", glyph: "✿", color: "cat-2" },
] as const satisfies readonly Category[];
