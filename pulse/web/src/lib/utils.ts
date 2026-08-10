export function formatTime(iso: string | Date): string {
  return new Date(iso).toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function pad(n: number) {
  return String(n).padStart(2, "0");
}

export function toDatetimeLocal(date: Date): string {
  // Round up to next minute so the default start time is always slightly in the future
  const rounded = new Date(Math.ceil(date.getTime() / 60000) * 60000);
  return `${rounded.getFullYear()}-${pad(rounded.getMonth() + 1)}-${pad(rounded.getDate())}T${pad(rounded.getHours())}:${pad(rounded.getMinutes())}`;
}

export interface PhotonFeature {
  geometry: {
    coordinates: [number, number]; // [longitude, latitude] — GeoJSON order
  };
  properties: {
    name?: string;
    street?: string;
    city?: string;
    state?: string;
    country?: string;
  };
}

export function composeLabel(p: PhotonFeature["properties"]): string {
  return [p.name, p.street, p.city, p.state, p.country].filter(Boolean).join(", ");
}

/** Returns true when end is set and is not strictly after start (form validation). */
export function isEndBeforeOrAtStart(start: string, end: string): boolean {
  return !!end && end <= start;
}

/**
 * Given a start datetime-local string and a duration in hours, returns
 * the corresponding end datetime-local string. Returns an empty string
 * if `start` cannot be parsed, so the caller can leave `endTime` empty
 * rather than emitting "Invalid Date".
 */
export function deriveEndFromDuration(start: string, hours: number): string {
  if (!start) return "";
  const startDate = new Date(start);
  if (isNaN(startDate.getTime())) return "";
  const end = new Date(startDate.getTime() + hours * 60 * 60 * 1000);
  return toDatetimeLocal(end);
}

/** The identity fields any signed-in surface needs to label a person. */
export interface DisplayIdentity {
  displayName: string | null;
  handle: string | null;
  email: string | null;
}

/**
 * Picks the best name we hold for someone: their chosen display name, else
 * `@handle`, else the local part of their email. Null when we hold none of
 * the three, which is a signed-out viewer.
 */
export function displayNameOf(identity: DisplayIdentity | null | undefined): string | null {
  if (!identity) return null;
  if (identity.displayName) return identity.displayName;
  if (identity.handle) return `@${identity.handle}`;
  if (identity.email) return identity.email.split("@")[0] ?? null;
  return null;
}

/** First character of a name, upper-cased — the fallback when no avatar renders. */
export function initialOf(name: string | null): string {
  return name?.trim().charAt(0).toUpperCase() || "?";
}

/**
 * The avatar URL arrives from the issuer's `picture` claim and is stored
 * verbatim at login, so it is third-party data by the time it reaches an
 * `<img src>`. Only an absolute `https:` URL is rendered — that rules out
 * `javascript:`, `data:` and protocol-relative URLs without needing the
 * sink to be careful.
 */
export function safeAvatarUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}
