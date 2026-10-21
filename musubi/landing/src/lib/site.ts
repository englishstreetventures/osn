// Single source of truth for the marketing site's external targets and copy.
// Centralised so a domain cutover or any link swap is a one-line edit, not a
// hunt through markup.

/**
 * Musubi identity / social app — target of every primary "Get started" CTA.
 * Build-time override via PUBLIC_APP_URL; the default is the local social dev
 * server so `bun run dev` works without env wiring. Prod is set per-deploy.
 */
export const APP_URL = import.meta.env.PUBLIC_APP_URL ?? "http://localhost:1422";

export const SITE_NAME = "Musubi";
export const SITE_TAGLINE = "Your social graph, your control";
export const SITE_DESCRIPTION =
  "Musubi is a modular, open social platform built on OSN. Own your identity and your connections, set the rules once, and switch on only the apps you want — events, secure messaging and more — without handing your social graph to any of them.";

/** In-page section anchors, kept here so nav + CTAs stay in sync. */
export const ANCHORS = {
  apps: "#apps",
  how: "#how-it-works",
  features: "#features",
  principles: "#principles",
  faq: "#faq",
} as const;
