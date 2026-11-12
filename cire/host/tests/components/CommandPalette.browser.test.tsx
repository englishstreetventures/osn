import { cleanup, render, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";

import "../../src/styles/global.css";
import CommandPalette from "../../src/components/CommandPalette";
import { setThemePreference } from "../../src/lib/preferences";

/**
 * The palette's theme row is a keyboard action, so it changes the theme at once
 * (DESIGN.md §6): only a choice in the account menu cross-fades. Only a real
 * engine has `document.startViewTransition` and answers `matchMedia`, which is
 * what a fade would need, so this runs where one could start.
 */

function mount() {
  const [open, setOpen] = createSignal(true);
  render(() => (
    <CommandPalette
      open={open()}
      onOpenChange={setOpen}
      wedding={null}
      weddings={[]}
      onModule={() => {}}
      onWedding={() => {}}
      onAll={() => {}}
      onSecurity={() => {}}
      onSignOut={() => {}}
    />
  ));
  return open;
}

afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
  setThemePreference("system");
});

describe("the command palette's theme row", () => {
  it("switches the theme at once, with no view transition", async () => {
    setThemePreference("dark");
    const open = mount();
    const start = vi.spyOn(document, "startViewTransition");

    await userEvent.type(screen.getByRole("combobox", { name: /search commands/i }), "light");
    expect(screen.getByRole("option", { name: /switch to light theme/i })).toBeTruthy();
    await userEvent.keyboard("{Enter}");

    expect(open()).toBe(false);
    expect(start).not.toHaveBeenCalled();
    expect(document.documentElement.dataset.theme).toBe("light");
  });
});
