import { apiUrl } from "./api";

/**
 * The absolute URL the portal loads an invite image from: the `card` variant,
 * which is also what the API serves when no variant is named. The builder's
 * thumbnail, crop editor and previews all load this one URL, so the browser
 * fetches each image once and serves the rest from its cache. It is never the
 * server-blurred `hero-bg`; the previews blur in CSS. `imageUrl` is the
 * relative, version-busted path the API hands out.
 */
export function inviteImageSrc(imageUrl: string): string {
  const sep = imageUrl.includes("?") ? "&" : "?";
  return apiUrl(`${imageUrl}${sep}variant=card`);
}
