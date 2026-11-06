import { clsx } from "@shared/ui/lib/utils";
import type { JSX } from "solid-js";

/**
 * Musubi's empty state: a dashed block of muted text at the card corner
 * (DESIGN.md §Radii). `page` stands in for a page's whole content, `section`
 * for one list inside a page. An `<output>`, the element whose role is
 * `status`: a polite live region, so a state that replaces a loading skeleton
 * is read out.
 *
 * Not `@shared/ui`'s `EmptyState`, whose light title, 16px type and small
 * corner fall outside this surface's scale, nor its `Notice`, a tinted box.
 */
export function EmptyNote(props: { children: JSX.Element; size?: "page" | "section" }) {
  return (
    <output
      class={clsx(
        "text-muted-foreground border-border rounded-card text-body block border border-dashed text-center",
        props.size === "section" ? "py-12" : "py-16",
      )}
    >
      {props.children}
    </output>
  );
}
