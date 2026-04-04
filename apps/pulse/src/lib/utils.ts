export function formatTime(iso: string | Date): string {
  return new Date(iso).toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function toDatetimeLocal(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
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
 * Decodes a JWT payload without verifying the signature.
 * Safe for display-only purposes — the server verifies the signature on every write.
 */
function decodeJwtPayload(accessToken: string): Record<string, unknown> | null {
  try {
    return JSON.parse(atob(accessToken.split(".")[1]!)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Extracts the `sub` (user ID) claim from an access token. */
export function getUserIdFromToken(accessToken: string | null): string | null {
  return getTokenClaims(accessToken).userId;
}

export interface TokenClaims {
  userId: string | null;
  email: string | null;
  handle: string | null;
  displayName: string | null;
}

/** Decodes all OSN claims from an access token in one pass. */
export function getTokenClaims(accessToken: string | null): TokenClaims {
  const payload = decodeJwtPayload(accessToken ?? "");
  return {
    userId: typeof payload?.sub === "string" ? payload.sub : null,
    email: typeof payload?.email === "string" ? payload.email : null,
    handle: typeof payload?.handle === "string" ? payload.handle : null,
    displayName: typeof payload?.displayName === "string" ? payload.displayName : null,
  };
}

/**
 * Derives a display name from an access token.
 * Prefers the `displayName` claim, falls back to `@handle`, then to the email local-part.
 */
export function getDisplayNameFromToken(accessToken: string | null): string | null {
  if (!accessToken) return null;
  const { displayName, handle, email } = getTokenClaims(accessToken);
  if (displayName) return displayName;
  if (handle) return `@${handle}`;
  if (email) return email.split("@")[0] ?? null;
  return null;
}

/** Extracts the `handle` claim from an access token, without the @ sigil. */
export function getHandleFromToken(accessToken: string | null): string | null {
  return getTokenClaims(accessToken).handle;
}
