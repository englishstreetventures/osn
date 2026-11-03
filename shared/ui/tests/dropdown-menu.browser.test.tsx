/**
 * The menu's items, as a reader works them: from the keyboard, with a pointer,
 * inside a modal dialog, and as painted on cire's two ramps.
 *
 * Kobalte's menu moves focus, toggles and selects in event handlers, and a
 * modal dialog paints in the top layer; neither exists below this tier, so
 * every behaviour here runs in Chromium. The default variant, which musubi's
 * account menu and pulse's two menus draw, is held in its own file
 * (`dropdown-menu-default.browser.test.tsx`), which runs on the code before
 * this one's exports existed.
 */

import { cleanup, render, screen } from "@solidjs/testing-library";
import { createSignal, type JSX } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";
import { commands, userEvent } from "vitest/browser";

import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuHandle,
  type DropdownMenuHandleValue,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "../src/ui/dropdown-menu";
import { MENU_TOUCH } from "../src/ui/menu-touch-classes";
import { Modal } from "../src/ui/modal";

import "./test-support/tailwind.css";

type MotionPreference = { reducedMotion: "reduce" | "no-preference" };
const emulateMedia = (options: MotionPreference) =>
  (commands as unknown as { emulateMedia: (o: MotionPreference) => Promise<void> }).emulateMedia(
    options,
  );

afterEach(async () => {
  await emulateMedia({ reducedMotion: "no-preference" });
  for (const d of document.querySelectorAll("dialog[open]")) (d as HTMLDialogElement).close();
  for (const p of document.querySelectorAll("[data-kb-top-layer]")) p.remove();
  cleanup();
  if (location.hash) history.replaceState(null, "", location.pathname + location.search);
});

/** Long enough for an opening animation and Kobalte's 1ms close to settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 250));

/**
 * cire's ramps, as `cire/host/src/styles/global.css` resolves them through its
 * `--ui-*` block: dark from `:root` (`:41-80`), light from
 * `:root[data-theme="light"]` (`:116-139`), the copy
 * `tools/lab/src/stories/cire-ui/cire-mapping.ts` keeps. The vendor portal's
 * ramp is the same literals for every token read here
 * (`cire/vendor/src/styles/global.css:50-89`, `:125-148`). Set on the panel
 * itself: it portals out of any wrapper.
 */
const CIRE = {
  dark: {
    "--ui-ground": "oklch(16.8% 0.026 148)",
    "--ui-surface-raised": "oklch(24.4% 0.032 149)",
    "--ui-hairline": "oklch(85% 0.06 145 / 0.11)",
    "--ui-hairline-strong": "oklch(85% 0.06 145 / 0.44)",
    "--ui-ink": "oklch(94.6% 0.011 90)",
    "--ui-ink-secondary": "oklch(94.6% 0.011 90 / 0.58)",
    "--ui-accent": "oklch(75% 0.085 82)",
    "--ui-accent-ink": "oklch(84% 0.072 84)",
    "--ui-on-accent": "oklch(16.8% 0.026 148)",
    "--ui-focus": "oklch(75% 0.085 82)",
  },
  light: {
    "--ui-ground": "oklch(88.6% 0.011 92)",
    "--ui-surface-raised": "oklch(95.2% 0.007 92)",
    "--ui-hairline": "oklch(44% 0.022 340 / 0.18)",
    "--ui-hairline-strong": "oklch(44% 0.022 340 / 0.74)",
    "--ui-ink": "oklch(27% 0.018 340)",
    "--ui-ink-secondary": "oklch(44% 0.022 340)",
    "--ui-accent": "oklch(64% 0.095 78)",
    "--ui-accent-ink": "oklch(46% 0.082 74)",
    "--ui-on-accent": "oklch(24% 0.018 340)",
    "--ui-focus": "oklch(38% 0.072 141)",
  },
} as const satisfies Record<"dark" | "light", JSX.CSSProperties>;

/** The sRGB pixel a stack of colours paints, the first at the bottom. */
function paint(layers: readonly string[]): [number, number, number] {
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext("2d")!;
  for (const layer of layers) {
    ctx.fillStyle = layer;
    ctx.fillRect(0, 0, 1, 1);
  }
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  return [r!, g!, b!];
}

function luminance([r, g, b]: [number, number, number]): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(a: [number, number, number], b: [number, number, number]): number {
  const [la, lb] = [luminance(a), luminance(b)];
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Open the menu by its trigger, with a real pointer. */
async function open(name = "Open menu") {
  await userEvent.click(screen.getByRole("button", { name }));
  await settle();
}

/** Open the menu from the keyboard: focus lands on its first item. */
async function openByKeyboard(name = "Open menu") {
  screen.getByRole("button", { name }).focus();
  await userEvent.keyboard("{Enter}");
  await settle();
}

describe("a checkbox item", () => {
  function Toggle(props: { indicator?: "check" | "switch" }) {
    const [on, setOn] = createSignal(false);
    return (
      <DropdownMenu>
        <DropdownMenuTrigger>Open menu</DropdownMenuTrigger>
        <DropdownMenuContent variant="accent">
          <DropdownMenuCheckboxItem checked={on()} onChange={setOn} indicator={props.indicator}>
            Haptics
          </DropdownMenuCheckboxItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  it("toggles on Enter and on Space, and the menu stays open", async () => {
    render(() => <Toggle />);
    await openByKeyboard();
    const item = screen.getByRole("menuitemcheckbox", { name: "Haptics" });
    expect(item.getAttribute("aria-checked")).toBe("false");
    await userEvent.keyboard("{Enter}");
    await settle();
    expect(item.isConnected).toBe(true);
    expect(item.getAttribute("aria-checked")).toBe("true");
    await userEvent.keyboard(" ");
    await settle();
    expect(
      screen.getByRole("menuitemcheckbox", { name: "Haptics" }).getAttribute("aria-checked"),
    ).toBe("false");
  });

  it("draws its switch for the eye alone, and carries the state on the item", async () => {
    render(() => <Toggle indicator="switch" />);
    await openByKeyboard();
    const item = screen.getByRole("menuitemcheckbox", { name: "Haptics" });
    const glyph = item.querySelector("[data-menu-switch]");
    expect(glyph).not.toBeNull();
    expect(glyph!.getAttribute("aria-hidden")).toBe("true");
    expect(glyph!.hasAttribute("data-checked")).toBe(false);
    await userEvent.keyboard("{Enter}");
    await settle();
    expect(item.getAttribute("aria-checked")).toBe("true");
    expect(glyph!.hasAttribute("data-checked")).toBe(true);
  });
});

describe("a row's own settings", () => {
  it("closes a checkbox row told to, and keeps a disabled radio row from choosing", async () => {
    const [on, setOn] = createSignal(false);
    const [theme, setTheme] = createSignal("system");
    render(() => (
      <DropdownMenu>
        <DropdownMenuTrigger>Open menu</DropdownMenuTrigger>
        <DropdownMenuContent variant="accent">
          <DropdownMenuRadioGroup value={theme()} onChange={setTheme}>
            <DropdownMenuRadioItem value="system">System</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="light" disabled>
              Light
            </DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
          <DropdownMenuCheckboxItem checked={on()} onChange={setOn} closeOnSelect>
            Haptics
          </DropdownMenuCheckboxItem>
        </DropdownMenuContent>
      </DropdownMenu>
    ));
    await open();
    screen.getByRole("menuitemradio", { name: "Light" }).click();
    await settle();
    expect(theme()).toBe("system");
    await userEvent.click(screen.getByRole("menuitemcheckbox", { name: "Haptics" }));
    await settle();
    expect(on()).toBe(true);
    expect(screen.queryByRole("menu")).toBeNull();
  });
});

describe("a radio item", () => {
  it("moves the selection, and marks the chosen row", async () => {
    const [theme, setTheme] = createSignal("system");
    render(() => (
      <DropdownMenu>
        <DropdownMenuTrigger>Open menu</DropdownMenuTrigger>
        <DropdownMenuContent variant="accent">
          <DropdownMenuGroup>
            <DropdownMenuLabel tone="eyebrow">Appearance</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={theme()} onChange={setTheme}>
              <DropdownMenuRadioItem value="system" closeOnSelect={false}>
                System
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="light" closeOnSelect={false}>
                Light
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    ));
    await openByKeyboard();
    const system = screen.getByRole("menuitemradio", { name: "System" });
    expect(system.getAttribute("aria-checked")).toBe("true");
    expect(system.querySelector("[data-menu-check]")).not.toBeNull();
    await userEvent.keyboard("{ArrowDown}{Enter}");
    await settle();
    expect(theme()).toBe("light");
    const light = screen.getByRole("menuitemradio", { name: "Light" });
    expect(light.getAttribute("aria-checked")).toBe("true");
    expect(light.querySelector("[data-menu-check]")).not.toBeNull();
    expect(system.querySelector("[data-menu-check]")).toBeNull();
  });
});

describe("a link item", () => {
  it("is an anchor, and keeps its href, target, rel and download", async () => {
    render(() => (
      <DropdownMenu>
        <DropdownMenuTrigger>Open menu</DropdownMenuTrigger>
        <DropdownMenuContent variant="accent">
          <DropdownMenuItem
            as="a"
            href="https://example.test/account"
            target="_blank"
            rel="noopener"
          >
            Account
          </DropdownMenuItem>
          <DropdownMenuItem as="a" href="/invite.ics" download="invite.ics">
            Calendar file
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    ));
    await open();
    const account = screen.getByRole("menuitem", { name: "Account" });
    expect(account.tagName).toBe("A");
    expect(account.getAttribute("href")).toBe("https://example.test/account");
    expect(account.getAttribute("target")).toBe("_blank");
    expect(account.getAttribute("rel")).toBe("noopener");
    const file = screen.getByRole("menuitem", { name: "Calendar file" });
    expect(file.tagName).toBe("A");
    expect(file.getAttribute("download")).toBe("invite.ics");
  });

  it("opens a new tab with no opener and no referrer when the caller names no rel", async () => {
    render(() => (
      <DropdownMenu>
        <DropdownMenuTrigger>Open menu</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem as="a" href="https://example.test/" target="_blank">
            Elsewhere
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    ));
    await open();
    const link = screen.getByRole("menuitem", { name: "Elsewhere" });
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("navigates when chosen from the keyboard", async () => {
    render(() => (
      <DropdownMenu>
        <DropdownMenuTrigger>Open menu</DropdownMenuTrigger>
        <DropdownMenuContent variant="accent">
          <DropdownMenuItem as="a" href="#menu-link-target">
            Jump
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    ));
    await openByKeyboard();
    expect(document.activeElement?.textContent).toBe("Jump");
    await userEvent.keyboard("{Enter}");
    await settle();
    expect(location.hash).toBe("#menu-link-target");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  /** One link in an open accent menu, focused from the keyboard. */
  function Jump(props: { disabled?: boolean; onSelect?: () => void }) {
    return (
      <DropdownMenu>
        <DropdownMenuTrigger>Open menu</DropdownMenuTrigger>
        <DropdownMenuContent variant="accent">
          <DropdownMenuItem
            as="a"
            href="#menu-link-target"
            disabled={props.disabled}
            onSelect={props.onSelect}
          >
            Jump
          </DropdownMenuItem>
          <DropdownMenuItem>Stay</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  it("follows a mouse click, runs its onSelect, and then closes", async () => {
    const [picked, setPicked] = createSignal("");
    render(() => <Jump onSelect={() => setPicked("jump")} />);
    await open();
    await userEvent.click(screen.getByRole("menuitem", { name: "Jump" }));
    await settle();
    expect(picked()).toBe("jump");
    expect(location.hash).toBe("#menu-link-target");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("follows the link on Space, as on Enter, and then closes", async () => {
    render(() => <Jump />);
    await openByKeyboard();
    expect(document.activeElement?.textContent).toBe("Jump");
    await userEvent.keyboard(" ");
    await settle();
    expect(location.hash).toBe("#menu-link-target");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("follows a tap whose click arrives after the finger lifts", async () => {
    render(() => <Jump />);
    await open();
    const link = screen.getByRole("menuitem", { name: "Jump" });
    const rect = link.getBoundingClientRect();
    const [x, y] = [rect.left + rect.width / 2, rect.top + rect.height / 2];
    const touch = {
      bubbles: true,
      cancelable: true,
      pointerType: "touch",
      isPrimary: true,
      button: 0,
      clientX: x,
      clientY: y,
    };
    link.dispatchEvent(new PointerEvent("pointerdown", touch));
    link.dispatchEvent(new PointerEvent("pointerup", touch));
    // A phone sends the tap's click as a task of its own, after the pointer
    // events. It lands on whatever is under the finger by then.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const target = document.elementFromPoint(x, y);
    target?.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true, clientX: x, clientY: y }),
    );
    await settle();
    expect(location.hash).toBe("#menu-link-target");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("goes nowhere while disabled, whatever presses it", async () => {
    render(() => <Jump disabled />);
    await open();
    const link = screen.getByRole("menuitem", { name: "Jump" });
    expect(link.getAttribute("aria-disabled")).toBe("true");
    expect(link.hasAttribute("href")).toBe(false);
    link.click();
    await settle();
    expect(location.hash).toBe("");
  });
});

describe("inside a Modal", () => {
  it("puts the panel where a click on its item lands, and the item answers", async () => {
    const [picked, setPicked] = createSignal("");
    render(() => (
      <Modal open onClose={() => {}} label="Test dialog">
        <DropdownMenu>
          <DropdownMenuTrigger>Open menu</DropdownMenuTrigger>
          <DropdownMenuContent variant="accent">
            <DropdownMenuItem onSelect={() => setPicked("copy")}>Copy message</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        {/* Room under the trigger: the dialog scrolls its own box, so a panel
            past its edge is clipped by it, as a popover's is. */}
        <div style={{ height: "160px" }} />
      </Modal>
    ));
    await open();
    const item = screen.getByRole("menuitem", { name: "Copy message" });
    const rect = item.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    expect(item === hit || item.contains(hit)).toBe(true);
    expect(item.closest("dialog")).not.toBeNull();
    expect(screen.getByRole("menu").hasAttribute("data-kb-top-layer")).toBe(true);
    await userEvent.click(item);
    expect(picked()).toBe("copy");
  });

  it("mounts into the upper of two open modals, where the click lands", async () => {
    const [picked, setPicked] = createSignal("");
    render(() => (
      <>
        <Modal open onClose={() => {}} label="Lower dialog">
          <p>Behind</p>
        </Modal>
        <Modal open onClose={() => {}} label="Upper dialog">
          <DropdownMenu>
            <DropdownMenuTrigger>Open menu</DropdownMenuTrigger>
            <DropdownMenuContent variant="accent">
              <DropdownMenuItem onSelect={() => setPicked("copy")}>Copy message</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <div style={{ height: "160px" }} />
        </Modal>
      </>
    ));
    await open();
    const item = screen.getByRole("menuitem", { name: "Copy message" });
    expect(item.closest("dialog")?.getAttribute("aria-label")).toBe("Upper dialog");
    const rect = item.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    expect(item === hit || item.contains(hit)).toBe(true);
    await userEvent.click(item);
    expect(picked()).toBe("copy");
  });
});

describe("the accent variant", () => {
  function Accent(props: { theme?: "dark" | "light" }) {
    return (
      <DropdownMenu>
        <DropdownMenuTrigger>Open menu</DropdownMenuTrigger>
        <DropdownMenuContent variant="accent" style={props.theme ? CIRE[props.theme] : undefined}>
          <DropdownMenuGroup>
            <DropdownMenuLabel tone="eyebrow">Appearance</DropdownMenuLabel>
            <DropdownMenuItem>Security &amp; passkeys</DropdownMenuItem>
            <DropdownMenuItem>Sign out</DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  it("closes at once on Escape, with focus back on the trigger", async () => {
    render(() => <Accent />);
    await openByKeyboard();
    expect(screen.getByRole("menu")).toBeTruthy();
    await userEvent.keyboard("{Escape}");
    // No closing animation: the panel is gone in the next frame, not after one.
    await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 20)));
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Open menu" }));
  });

  for (const theme of ["dark", "light"] as const) {
    it(`reads at 4.5:1 at rest, highlighted and in its group label, on cire's ${theme} ramp`, async () => {
      render(() => <Accent theme={theme} />);
      await openByKeyboard();
      const panel = screen.getByRole("menu");
      const panelStyle = getComputedStyle(panel);
      const ground = CIRE[theme]["--ui-ground"];
      const raised = panelStyle.backgroundColor;
      const highlighted = screen.getByRole("menuitem", { name: "Security & passkeys" });
      const idle = screen.getByRole("menuitem", { name: "Sign out" });
      const label = screen.getByText("Appearance");
      expect(highlighted.hasAttribute("data-highlighted")).toBe(true);
      const ratio = (el: Element, layers: string[]) =>
        contrast(paint([...layers, getComputedStyle(el).color]), paint(layers));
      const wash = getComputedStyle(highlighted).backgroundColor;
      expect(ratio(highlighted, [ground, raised, wash])).toBeGreaterThanOrEqual(4.5);
      expect(ratio(idle, [ground, raised])).toBeGreaterThanOrEqual(4.5);
      expect(ratio(label, [ground, raised])).toBeGreaterThanOrEqual(4.5);
    });
  }

  it("pops open from its trigger, and holds still for a reader who turned motion down", async () => {
    render(() => <Accent />);
    await open();
    const moving = getComputedStyle(screen.getByRole("menu"));
    expect(moving.animationName).toBe("ui-enter");
    expect(moving.getPropertyValue("--ui-enter-scale").trim()).toBe("0.96");
    await userEvent.keyboard("{Escape}");
    await settle();
    await emulateMedia({ reducedMotion: "reduce" });
    await open();
    expect(getComputedStyle(screen.getByRole("menu")).animationName).toBe("none");
  });

  it("rings a row reached by the keyboard, and never fades the ring in", async () => {
    render(() => <Accent />);
    await openByKeyboard();
    const row = screen.getByRole("menuitem", { name: "Security & passkeys" });
    expect(document.activeElement).toBe(row);
    const style = getComputedStyle(row);
    expect(style.outlineStyle).toBe("solid");
    expect(style.outlineWidth).toBe("2px");
    // `--ui-focus` in the test palette (`test-support/tailwind.css`).
    expect(style.outlineColor).toBe("rgb(47, 75, 216)");
    const properties = style.transitionProperty.split(",").map((p) => p.trim());
    expect(properties).not.toContain("all");
    expect(properties).not.toContain("outline");
    expect(properties).not.toContain("outline-color");
  });
});

describe("the touch row the guest site's link menu draws", () => {
  it("fills for the keyboard, and not for a press that focuses it", async () => {
    render(() => (
      <div class={MENU_TOUCH.panel} style={CIRE.light}>
        <a href="#one" class={MENU_TOUCH.row}>
          Google Calendar
        </a>
        <button type="button">After</button>
      </div>
    ));
    const link = screen.getByRole("link", { name: "Google Calendar" });
    const idle = getComputedStyle(link).backgroundColor;
    // A press focuses the link; a focus fill would read as already chosen.
    // The pointer then leaves, so only focus is left to fill it.
    await userEvent.click(link);
    await userEvent.unhover(link);
    await settle();
    expect(document.activeElement).toBe(link);
    expect(getComputedStyle(link).backgroundColor).toBe(idle);
    link.blur();
    // Reached by Tab, it is :focus-visible and fills.
    screen.getByRole("button", { name: "After" }).focus();
    await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
    await settle();
    expect(document.activeElement).toBe(link);
    expect(getComputedStyle(link).backgroundColor).not.toBe(idle);
    // The guest site's touch floor.
    expect(link.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
  });
});

describe("a handle on the menu", () => {
  it("opens the menu from a plain button outside it, onto its first row", async () => {
    let menu: DropdownMenuHandleValue | undefined;
    render(() => (
      <div>
        <button type="button" onClick={() => menu?.open("first")}>
          Row actions
        </button>
        <DropdownMenu>
          <DropdownMenuHandle ref={(m) => (menu = m)} />
          <DropdownMenuContent variant="accent">
            <DropdownMenuItem>Edit</DropdownMenuItem>
            <DropdownMenuItem>Remove</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    ));
    expect(menu).toBeDefined();
    screen.getByRole("button", { name: "Row actions" }).focus();
    await userEvent.keyboard("{Enter}");
    await settle();
    expect(screen.getByRole("menu")).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Edit" }));
  });
});
