/**
 * The one button an email draws, for a message that asks the reader to open
 * one link (`wiki/shared/email.md` §How a message looks): ink fill, white
 * words at the text's own weight, 6px corners. Every template that draws a
 * button draws it through this, so no message's button looks unlike another's.
 *
 * The link's text under it, for a client that drops the button's styles, is
 * the template's own line.
 */

const esc = (s: string): string =>
  s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

export const emailButton = (url: string, label: string): string =>
  `<p><a href="${esc(url)}" style="display:inline-block;padding:12px 24px;background:#0a0a0a;color:#fff;text-decoration:none;border-radius:6px">${esc(label)}</a></p>`;
