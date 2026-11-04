import { describe, expect, it } from "vitest";

import { Chip } from "../../src/ui/chip";
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "../../src/ui/dropdown-menu";
import { PopoverContent } from "../../src/ui/popover";

/**
 * The menu's and the popover's parts spread their rest props onto Kobalte's
 * elements, and `Chip` onto its `<span>`, so each is typed with `SafeProps`: `innerHTML`, `innerText` and
 * `textContent` are not props of theirs, and a household or guest name passed
 * as markup is a compile error at the call site.
 *
 * The refusal is the type checker's. Each line below carries
 * `@ts-expect-error`, so `bun run typecheck` fails the moment any of these
 * parts accepts one of the three again. The function is never called.
 */
describe("the menu's, the popover's and the chip's parts", () => {
  it("refuse the props that write markup", () => {
    const refused = () => (
      <>
        {/* @ts-expect-error — markup is not a menu panel's prop. */}
        <DropdownMenuContent innerHTML="<img src=x onerror=alert(1)>" />
        {/* @ts-expect-error — markup is not a menu item's prop. */}
        <DropdownMenuItem innerHTML="<img src=x onerror=alert(1)>" />
        {/* @ts-expect-error — nor is text written over its children. */}
        <DropdownMenuItem textContent="Deactivate" />
        {/* @ts-expect-error — markup is not a menu label's prop. */}
        <DropdownMenuLabel innerText="Signed in as" />
        {/* @ts-expect-error — markup is not a separator's prop. */}
        <DropdownMenuSeparator innerHTML="<hr>" />
        {/* @ts-expect-error — markup is not a popover panel's prop. */}
        <PopoverContent innerHTML="<img src=x onerror=alert(1)>" />
        {/* @ts-expect-error — markup is not a chip's prop: its words are children. */}
        <Chip innerHTML="<img src=x onerror=alert(1)>">live</Chip>
        {/* @ts-expect-error — nor is a title: a badge explains itself in a Tooltip. */}
        <Chip title="Owners can change anything">Owner</Chip>
      </>
    );
    expect(typeof refused).toBe("function");
  });
});
