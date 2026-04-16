import type { PublicProfile } from "@osn/client";

export function profileInitials(profile: PublicProfile | null): string {
  if (!profile) return "?";
  const name = profile.displayName || profile.handle;
  return name.slice(0, 2).toUpperCase();
}

/**
 * Only allow http(s) avatar URLs. Defense-in-depth against a
 * hypothetical server-side regression that lets users set avatarUrl to
 * a data: or other URL scheme (S-L3).
 */
export function safeAvatarUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  return url.startsWith("https://") || url.startsWith("http://") ? url : null;
}

function decodeJwtPayload(accessToken: string): Record<string, unknown> | null {
  try {
    return JSON.parse(atob(accessToken.split(".")[1]!)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export interface TokenClaims {
  profileId: string | null;
  email: string | null;
  handle: string | null;
  displayName: string | null;
}

export function getTokenClaims(accessToken: string | null): TokenClaims {
  const payload = decodeJwtPayload(accessToken ?? "");
  return {
    profileId: typeof payload?.sub === "string" ? payload.sub : null,
    email: typeof payload?.email === "string" ? payload.email : null,
    handle: typeof payload?.handle === "string" ? payload.handle : null,
    displayName: typeof payload?.displayName === "string" ? payload.displayName : null,
  };
}
