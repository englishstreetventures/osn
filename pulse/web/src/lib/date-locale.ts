/**
 * The locale the server writes dates in, and the browser's first render
 * repeats.
 *
 * The server takes it from the request's `Accept-Language`, once per request,
 * and writes it into the document as `<html data-date-locale>`. The browser
 * reads it from there while hydrating, so its first render of every date is the
 * server's, byte for byte; once mounted, dates switch to the reader's own zone
 * and locale (`components/LocalTime.tsx`).
 */

import { getRequestEvent, isServer } from "solid-js/web";

/** When the header names nothing the runtime can format dates in. */
const FALLBACK = "en";

/** How many tags of the header are read; the rest is ignored. */
const MAX_TAGS = 8;

/** A tag the runtime can format dates in, canonicalised, or null. */
function supported(tag: string): string | null {
  try {
    return Intl.DateTimeFormat.supportedLocalesOf([tag])[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * The first tag of an `Accept-Language` header, by q, that the runtime can
 * format dates in, or `en`. The header is the client's, so every tag is
 * checked rather than trusted, and only the first few are read.
 */
export function negotiateDateLocale(header: string | null): string {
  if (!header) return FALLBACK;
  const ranked: { tag: string; q: number; at: number }[] = [];
  for (const [at, entry] of header.split(",").slice(0, MAX_TAGS).entries()) {
    const [rawTag, ...params] = entry.split(";");
    const tag = rawTag?.trim() ?? "";
    if (!tag || tag === "*") continue;
    let q = 1;
    for (const param of params) {
      const [key, value] = param.split("=").map((part) => part.trim());
      if (key === "q")
        q = value !== undefined && /^[01](\.\d{0,3})?$/.test(value) ? Number(value) : 0;
    }
    if (q > 0) ranked.push({ tag, q, at });
  }
  ranked.sort((a, b) => b.q - a.q || a.at - b.at);
  for (const { tag } of ranked) {
    const locale = supported(tag);
    if (locale) return locale;
  }
  return FALLBACK;
}

/**
 * The locale dates are written in before the browser takes over: the
 * request's on the server, the one the server wrote into the document in the
 * browser.
 */
export function dateLocale(): string {
  if (isServer) {
    const event = getRequestEvent();
    if (!event) return FALLBACK;
    // Worked out once per request, then kept on the request.
    event.locals.pulseDateLocale ??= negotiateDateLocale(
      event.request.headers.get("accept-language"),
    );
    return event.locals.pulseDateLocale;
  }
  return document.documentElement.dataset.dateLocale || FALLBACK;
}
