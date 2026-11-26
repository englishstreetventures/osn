/** Who an avatar stands for: a person's profile, or an organisation's name and handle. */
export interface AvatarSubject {
  displayName?: string | null;
  handle: string;
}

/**
 * Splits text into what a reader counts as characters, so a joined emoji or a
 * letter with a combining mark stays whole. Firefox before 125 has no
 * `Intl.Segmenter`; there it splits by code point.
 */
const graphemes: (text: string) => string[] =
  typeof Intl.Segmenter === "function"
    ? (() => {
        const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
        return (text) => Array.from(segmenter.segment(text), (part) => part.segment);
      })()
    : (text) => Array.from(text);

/**
 * The two characters every avatar shows behind its picture, people and
 * organisations alike: the first two of the name a reader sees (the display
 * name, or the handle when there is none), upper-cased.
 */
export function profileInitials(subject: AvatarSubject | null): string {
  if (!subject) return "?";
  const name = subject.displayName?.trim() || subject.handle;
  return graphemes(name).slice(0, 2).join("").toUpperCase();
}

/**
 * Only allow http(s) avatar URLs. Defense-in-depth against a
 * hypothetical server-side regression that lets users set avatarUrl to
 * a data: or other URL scheme.
 */
export function safeAvatarUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  return url.startsWith("https://") || url.startsWith("http://") ? url : null;
}

/**
 * The claims this app reads out of an access token. Each stays `unknown`
 * because the token is decoded here without verifying its signature — the
 * `typeof` checks in `getTokenClaims` are what turn a claim into a value.
 */
interface AccessTokenPayload {
  sub?: unknown;
  email?: unknown;
  handle?: unknown;
  displayName?: unknown;
}

function decodeJwtPayload(accessToken: string): AccessTokenPayload | null {
  try {
    const payload: AccessTokenPayload = JSON.parse(atob(accessToken.split(".")[1]!));
    return payload;
  } catch {
    return null;
  }
}

interface TokenClaims {
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
