import { api } from "./api";

/**
 * Mirrors `INTEREST_CATEGORIES` in `pulse/api/src/services/onboarding.ts`.
 * Must stay in sync with that list — the wire schema enforces it.
 */
export const INTEREST_CATEGORIES = [
  "music",
  "food",
  "sports",
  "arts",
  "tech",
  "community",
  "education",
  "social",
  "nightlife",
  "outdoor",
  "family",
] as const;

export type InterestCategory = (typeof INTEREST_CATEGORIES)[number];

export type PermOutcome = "granted" | "denied" | "prompt" | "unsupported";

export interface OnboardingStatus {
  completedAt: string | null;
  interests: readonly string[];
  notificationsOptIn: boolean;
  eventRemindersOptIn: boolean;
  notificationsPerm: PermOutcome;
  locationPerm: PermOutcome;
}

export interface CompleteOnboardingPayload {
  interests: InterestCategory[];
  notificationsOptIn: boolean;
  eventRemindersOptIn: boolean;
  notificationsPerm: PermOutcome;
  locationPerm: PermOutcome;
}

// ---------------------------------------------------------------------------
// API wrappers
// ---------------------------------------------------------------------------

const authHeaders = (token: string | null): Record<string, string> =>
  token ? { Authorization: `Bearer ${token}` } : {};

export async function fetchOnboardingStatus(
  token: string | null,
): Promise<OnboardingStatus | null> {
  if (!token) return null;
  const { data, error } = await api.me.onboarding.get({
    headers: authHeaders(token),
  });
  if (error || !data || !("completedAt" in data)) return null;
  return data as OnboardingStatus;
}

export async function completeOnboarding(
  token: string,
  payload: CompleteOnboardingPayload,
): Promise<OnboardingStatus> {
  const { data, error } = await api.me.onboarding.complete.post(payload, {
    headers: authHeaders(token),
  });
  if (error) {
    const message =
      typeof error === "object" && error && "value" in error
        ? JSON.stringify(error.value)
        : "Failed to complete onboarding";
    throw new Error(message);
  }
  if (!data || !("completedAt" in data)) {
    throw new Error("Unexpected onboarding response");
  }
  return data as OnboardingStatus;
}

// ---------------------------------------------------------------------------
// Platform permission helpers
//
// Standard browser APIs work in: web browsers, Tauri desktop webviews
// (macOS/Windows/Linux), and Tauri 2.x mobile webviews (iOS WKWebView,
// Android WebView). For a more native iOS prompt experience we'd later
// adopt @tauri-apps/plugin-geolocation + plugin-notification — wired
// through the same `requestX` functions so callers stay unchanged.
// ---------------------------------------------------------------------------

/**
 * Asks the platform for geolocation permission AND a one-shot fix.
 * The fix itself is discarded — discovery re-acquires location at
 * query time (no home address is persisted, per privacy direction).
 *
 * Returns the resolved permission state. `unsupported` indicates the
 * runtime has no geolocation API at all (rare; only old WebViews).
 */
export async function requestLocationPermission(): Promise<PermOutcome> {
  if (typeof navigator === "undefined" || !("geolocation" in navigator)) {
    return "unsupported";
  }
  return new Promise<PermOutcome>((resolve) => {
    navigator.geolocation.getCurrentPosition(
      () => resolve("granted"),
      (err) => {
        // PERMISSION_DENIED = 1; everything else (POSITION_UNAVAILABLE,
        // TIMEOUT) means the user *could* grant later — don't flag as
        // denied, leave the door open by reporting prompt.
        resolve(err.code === err.PERMISSION_DENIED ? "denied" : "prompt");
      },
      { timeout: 8000, maximumAge: 60_000, enableHighAccuracy: false },
    );
  });
}

/**
 * Asks the platform for notification permission. Web spec returns one of
 * `default | granted | denied`; we map `default` → `prompt` so it's the
 * same union as location.
 */
export async function requestNotificationPermission(): Promise<PermOutcome> {
  if (typeof window === "undefined" || typeof Notification === "undefined") {
    return "unsupported";
  }
  // Already-granted / already-denied states should be respected — calling
  // requestPermission again on those is a no-op in modern browsers, but
  // skipping it avoids the user seeing nothing happen.
  if (Notification.permission === "granted") return "granted";
  if (Notification.permission === "denied") return "denied";
  try {
    const result = await Notification.requestPermission();
    if (result === "granted") return "granted";
    if (result === "denied") return "denied";
    return "prompt";
  } catch {
    return "unsupported";
  }
}

// ---------------------------------------------------------------------------
// Local "skip-this-session" hint — does NOT persist across sessions, so a
// user who skips will still be re-prompted next time they open Pulse. The
// authoritative state is server-side via POST /me/onboarding/complete.
// ---------------------------------------------------------------------------

// Session-level "the user has dealt with onboarding this tab" flag.
// Set when the user either skips or completes — the gate uses it to stop
// the createResource cache from looping the redirect. Server state stays
// authoritative across sessions.
const RESOLVED_KEY = "pulse:onboarding-resolved";

export function markOnboardingResolvedThisSession(): void {
  try {
    sessionStorage.setItem(RESOLVED_KEY, "1");
  } catch {
    /* sessionStorage unavailable (e.g. private mode) — onboarding will
     * just re-prompt on next mount; that's acceptable. */
  }
}

export function isOnboardingResolvedThisSession(): boolean {
  try {
    return sessionStorage.getItem(RESOLVED_KEY) === "1";
  } catch {
    return false;
  }
}
