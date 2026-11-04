import { CONTROL_HEIGHT, controlClass } from "@shared/ui/ui/control";
import type { SafeProps } from "@shared/ui/ui/props";
import { Select, type SelectProps } from "@shared/ui/ui/select";
import Search from "lucide-solid/icons/search";
import { splitProps } from "solid-js";

/**
 * A filter in a bar — a search box or a select that narrows a list — in the
 * portals' one pill language (DESIGN.md §4): the 28px `sm` field, which the
 * 14px corner rounds into a pill.
 *
 * At rest it takes the glass track's look beside it, the hairline on the
 * portals' pill ground, so a bar of strips, chips and filters reads as one row
 * rather than the filter reading as the heaviest thing on it. What says "a
 * field" at 3:1 (WCAG 1.4.11) is its glyph in the secondary ink: a magnifier
 * leading a search box, the chevron a select draws at its end. Under the
 * pointer and with focus the edge turns to the strong 3:1 border, on the hover
 * clock; the focus ring is the shared field's own and lands at once.
 *
 * `size` is not a prop: a filter is `sm`, and `tests/styles/form-field.test.ts`
 * holds these two as the only `sm` fields under `src/`.
 */
const EDGE =
  "border-border bg-[color:var(--pill-ground)] hover:border-border-strong focus-visible:border-border-strong " +
  "transition-ui-colors duration-(--dur-fast) ease-(--ease-out)";

/** The same look on a select, which `Select` wraps in a box of its own. */
const SELECT_EDGE =
  "[&>select]:border-border [&>select]:bg-[color:var(--pill-ground)] [&>select:hover]:border-border-strong [&>select:focus-visible]:border-border-strong " +
  "[&>select]:transition-ui-colors [&>select]:duration-(--dur-fast) [&>select]:ease-(--ease-out)";

/**
 * A search box with its magnifier. The shared control's own `sm` box, drawn on
 * a native input here rather than through `Input`, because the magnifier needs
 * room the shared field's padding does not leave and `Input` owns its padding.
 * `type` stays the caller's: a box that searches is `search`.
 */
export function FilterSearch(props: Omit<SafeProps<"input">, "size" | "class">) {
  return (
    <span class="relative flex w-full min-w-0 items-center">
      <Search
        data-filter-glyph
        aria-hidden="true"
        strokeWidth={1.75}
        class="text-text-muted pointer-events-none absolute start-2.5 size-3.5"
      />
      <input
        {...props}
        class={`flex ${CONTROL_HEIGHT.sm} ${controlClass("sm", `ps-7.5 ${EDGE}`)}`}
      />
    </span>
  );
}

/** A select that narrows a list; its chevron is its mark. */
export function FilterSelect(props: Omit<SelectProps, "size">) {
  const [own, rest] = splitProps(props, ["class"]);
  return <Select {...rest} size="sm" class={`${SELECT_EDGE}${own.class ? ` ${own.class}` : ""}`} />;
}
