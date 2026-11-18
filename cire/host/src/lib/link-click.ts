/**
 * A click the browser should handle itself: a new tab, a new window, a
 * download, or any button but the main one. An in-dashboard link is an
 * `<a href>` to the place's address, so these still open it elsewhere; only a
 * plain click is taken over and routed through the dashboard.
 */
export const opensElsewhere = (event: MouseEvent): boolean =>
  event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey;

/** A link to another view of the wedding's dashboard: its address, and the
 *  dashboard's own way there, which moves focus to the view it opens. */
export interface InAppLink {
  href: string;
  onOpen: () => void;
}

/** The click handler for an `<a href={link.href}>`: a plain click goes through
 *  the dashboard, any other is the browser's. */
export const followInApp =
  (link: InAppLink) =>
  (event: MouseEvent): void => {
    if (opensElsewhere(event)) return;
    event.preventDefault();
    link.onOpen();
  };
