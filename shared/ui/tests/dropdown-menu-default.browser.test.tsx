/**
 * The shared menu's default look, as musubi's account menu and pulse's two
 * menus draw it, held exactly: the class strings, what they paint, and where
 * the panel lands.
 *
 * The file imports only what the menu exported before it gained the accent
 * variant and the checkbox, radio and link items, so it runs on the code
 * before that change as well as after it. That is the point of keeping it
 * apart: a literal copied wrong would otherwise never be seen passing against
 * the code it claims to describe. One thing differs from that code, and only
 * in a contrast theme: a focused row and a focused pill trigger draw an
 * outline there, because the theme drops the fill and the ring that mark
 * focus everywhere else.
 */

import { cleanup, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";
import { commands, userEvent } from "vitest/browser";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../src/ui/dropdown-menu";

import "./test-support/tailwind.css";

const emulateMedia = (options: { forcedColors: "active" | "none" }) =>
  (
    commands as unknown as {
      emulateMedia: (o: { forcedColors: "active" | "none" }) => Promise<void>;
    }
  ).emulateMedia(options);

afterEach(async () => {
  await emulateMedia({ forcedColors: "none" });
  cleanup();
});

/** Long enough for the opening animation to settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 250));

function AccountMenu() {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger>Open menu</DropdownMenuTrigger>
      <DropdownMenuContent class="w-52">
        <DropdownMenuGroup>
          <DropdownMenuLabel tone="identity">@ada</DropdownMenuLabel>
          <DropdownMenuLabel>Profiles</DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem>Switch profile</DropdownMenuItem>
        <DropdownMenuItem disabled>Archived</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

async function openByKeyboard() {
  screen.getByRole("button", { name: "Open menu" }).focus();
  await userEvent.keyboard("{Enter}");
  await settle();
}

describe("the default menu", () => {
  it("renders exactly the classes it rendered before the accent variant", async () => {
    render(() => <AccountMenu />);
    await openByKeyboard();
    expect(screen.getByRole("menu").getAttribute("class")).toBe(
      "base:bg-ui-surface-raised base:text-ui-ink base:border-ui-hairline base:z-50 base:min-w-32 base:rounded-ui-md base:border base:p-1 base:shadow-md base:outline-none " +
        "base:data-[expanded]:animate-in base:data-[closed]:animate-out base:data-[closed]:fade-out-0 base:data-[expanded]:fade-in-0 base:data-[closed]:zoom-out-95 base:data-[expanded]:zoom-in-95 w-52",
    );
    expect(screen.getByRole("menuitem", { name: "Switch profile" }).getAttribute("class")).toBe(
      "base:relative base:flex base:cursor-pointer base:select-none base:items-center base:rounded-ui-sm base:px-2 base:py-1.5 base:text-ui-base base:outline-none " +
        "base:focus:bg-ui-surface-sunk base:focus:text-ui-ink base:focus:outline-hidden " +
        "base:data-[disabled]:pointer-events-none base:data-[disabled]:opacity-50",
    );
    expect(screen.getByText("@ada").getAttribute("class")).toBe(
      "base:px-2 base:py-1.5 base:text-ui-base base:text-ui-ink-secondary base:font-normal",
    );
    expect(screen.getByText("Profiles").getAttribute("class")).toBe(
      "base:px-2 base:py-1.5 base:text-ui-base base:text-ui-ink base:font-semibold",
    );
    expect(screen.getByRole("separator").getAttribute("class")).toBe(
      "base:bg-ui-hairline base:-mx-1 base:my-1 base:h-px",
    );
  });

  it("paints what those classes paint", async () => {
    render(() => <AccountMenu />);
    await openByKeyboard();
    const panel = getComputedStyle(screen.getByRole("menu"));
    expect(panel.paddingTop).toBe("4px");
    expect(panel.borderTopWidth).toBe("1px");
    expect(panel.borderTopLeftRadius).not.toBe("0px");
    expect(panel.boxShadow).not.toBe("none");
    expect(panel.backgroundColor).toBe("rgb(255, 255, 255)");

    const row = screen.getByRole("menuitem", { name: "Switch profile" });
    expect(document.activeElement).toBe(row);
    const rowStyle = getComputedStyle(row);
    expect([rowStyle.paddingTop, rowStyle.paddingLeft]).toEqual(["6px", "8px"]);
    // Focused, the row sinks: `--ui-surface-sunk` in the test palette.
    expect(rowStyle.backgroundColor).toBe("rgb(236, 236, 241)");
    expect(rowStyle.outlineStyle).toBe("none");
    expect(getComputedStyle(screen.getByRole("menuitem", { name: "Archived" })).pointerEvents).toBe(
      "none",
    );

    expect(getComputedStyle(screen.getByText("@ada")).fontWeight).toBe("400");
    expect(getComputedStyle(screen.getByText("Profiles")).fontWeight).toBe("600");
    const rule = getComputedStyle(screen.getByRole("separator"));
    expect([rule.height, rule.marginLeft]).toEqual(["1px", "-4px"]);
  });

  it("portals to the document's body, and claims no top layer, with no modal open", async () => {
    render(() => <AccountMenu />);
    await openByKeyboard();
    const panel = screen.getByRole("menu");
    // The portal's own wrapper, a child of `<body>`, apart from the tree the
    // trigger renders in.
    let mount: HTMLElement = panel;
    while (mount.parentElement && mount.parentElement !== document.body)
      mount = mount.parentElement;
    expect(mount.parentElement).toBe(document.body);
    // The trigger is hidden from the accessibility tree while the menu is open.
    expect(mount.contains(screen.getByRole("button", { name: "Open menu", hidden: true }))).toBe(
      false,
    );
    expect(panel.closest("dialog")).toBeNull();
    expect(panel.hasAttribute("data-kb-top-layer")).toBe(false);
  });
});

describe("the default menu in a contrast theme", () => {
  it("outlines the focused row, and only that row, where the theme drops its fill", async () => {
    await emulateMedia({ forcedColors: "active" });
    render(() => <AccountMenu />);
    await openByKeyboard();
    const focused = screen.getByRole("menuitem", { name: "Switch profile" });
    expect(document.activeElement).toBe(focused);
    const ring = getComputedStyle(focused);
    expect([ring.outlineStyle, ring.outlineWidth]).toEqual(["solid", "2px"]);
    // A static hidden outline would ring every row at rest in a contrast
    // theme, which marks nothing.
    expect(getComputedStyle(screen.getByRole("menuitem", { name: "Archived" })).outlineStyle).toBe(
      "none",
    );
  });

  it("outlines a pill trigger reached from the keyboard, where the theme drops its ring", async () => {
    render(() => (
      <div>
        <button type="button">Before</button>
        <DropdownMenu>
          <DropdownMenuTrigger treatment="pill">Account</DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem>Profile</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    ));
    const trigger = screen.getByRole("button", { name: "Account" });
    screen.getByRole("button", { name: "Before" }).focus();
    await userEvent.keyboard("{Tab}");
    expect(document.activeElement).toBe(trigger);
    // Outside a contrast theme the ring alone marks it, as before.
    expect(getComputedStyle(trigger).outlineStyle).toBe("none");
    expect(getComputedStyle(trigger).boxShadow).not.toBe("none");
    await emulateMedia({ forcedColors: "active" });
    const ring = getComputedStyle(trigger);
    expect([ring.outlineStyle, ring.outlineWidth]).toEqual(["solid", "2px"]);
  });
});
