import { clsx } from "@shared/ui/lib/utils";
import { children, type JSX } from "solid-js";

/**
 * Musubi's empty state: a dashed block of muted text at the card corner
 * (DESIGN.md §Empty states and failed loads). `page` stands in for a page's
 * whole content, `section` for one list inside a page.
 *
 * The words sit in an `<output>`, the element whose role is `status`: a polite
 * live region, so a state that replaces a loading skeleton is read out. An
 * `action` sits under the words as the output's sibling, outside the live
 * region, so what is read out is the message and not a button's name too.
 *
 * `action` is resolved once, through `children()`: a JSX prop is a getter, and
 * each read of it would build the element again.
 *
 * Not `@shared/ui`'s `EmptyState`, whose light title, 16px type and small
 * corner fall outside this surface's scale, nor its `Notice`, a tinted box.
 */
export function EmptyNote(props: {
  children: JSX.Element;
  size?: "page" | "section";
  action?: JSX.Element;
}) {
  const action = children(() => props.action);
  return (
    <div
      class={clsx(
        "border-border rounded-card flex flex-col items-center gap-4 border border-dashed px-4",
        props.size === "section" ? "py-12" : "py-16",
      )}
    >
      <output class="text-muted-foreground text-body block w-full text-center">
        {props.children}
      </output>
      {action()}
    </div>
  );
}
