/**
 * Derives a coarse, bounded-cardinality label from a User-Agent header.
 *
 * We deliberately avoid full UA fingerprinting: the label is shown to the
 * user in Settings → Sessions ("This device", "Firefox on macOS") and has
 * to be stable enough to recognise, but narrow enough that it cannot be
 * used as an identifier. Detection is a regex sweep with a small fixed
 * vocabulary — the output is always a member of `browser × os` or
 * "Unknown device".
 *
 * No dependency on `ua-parser-js` — the single regex pass here is ~30
 * lines and keeps `@osn/api` free of an extra runtime dep.
 */

const BROWSERS: Array<[RegExp, string]> = [
  // Firefox must come before Chrome/Safari (its UA string contains neither).
  [/Firefox\/(\d+)/i, "Firefox"],
  // Edge before Chrome — Edge UA includes "Chrome".
  [/Edg(?:e|A|iOS)?\/(\d+)/i, "Edge"],
  // Chrome/Chromium — Chrome before Safari (Chrome UA includes "Safari").
  [/(?:Chrome|CriOS|Chromium)\/(\d+)/i, "Chrome"],
  // Safari last of the big three.
  [/Version\/\d+.*Safari\//i, "Safari"],
];

const OSES: Array<[RegExp, string]> = [
  [/iPhone|iPad|iPod/i, "iOS"],
  [/Android/i, "Android"],
  [/Mac OS X|Macintosh/i, "macOS"],
  [/Windows NT/i, "Windows"],
  [/Linux|X11/i, "Linux"],
];

export function deriveUaLabel(userAgent: string | undefined | null): string | null {
  if (!userAgent) return null;
  const browser = BROWSERS.find(([re]) => re.test(userAgent))?.[1];
  const os = OSES.find(([re]) => re.test(userAgent))?.[1];
  if (!browser && !os) return "Unknown device";
  if (browser && os) return `${browser} on ${os}`;
  return browser ?? os ?? "Unknown device";
}
