/**
 * When `Tooltip`'s panel opens and closes, and when it animates.
 *
 * - A cold hover waits out the open delay before a panel shows.
 * - The panel closes as soon as the pointer leaves, yet stays while the pointer
 *   crosses the gap onto it (WCAG 2.1 SC 1.4.13, hoverable). That claim is about
 *   the order the browser fires its pointer events in, so the pointer here is
 *   Playwright's real mouse, moved in steps.
 * - A panel opened at once, because another had just closed, carries
 *   `data-instant` from its first frame and runs no entry; one opened after the
 *   delay animates. Nothing about one open leaks into the next.
 *
 * Its own file: Kobalte keeps every tooltip's warm-up and skip-delay state in
 * module scope, and Vitest gives each file its own module graph. Every test
 * ends with the pointer away and the skip window passed, so the next one starts
 * cold.
 */

import { cleanup, render, screen } from "@solidjs/testing-library";
import { createSignal, Show } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";

import { Tooltip } from "../src/ui/tooltip";
import { emulateMedia, frames, movePointer, wait } from "./test-support/motion";

import "./test-support/tailwind.css";

/** Past a close and the skip window, so the next hover starts cold. */
const COOL = 450;

const panels = () => [...document.querySelectorAll<HTMLElement>('[role="tooltip"]')];
const panelSaying = (text: string) => panels().find((p) => p.textContent === text) ?? null;

async function waitForPanel(text: string): Promise<HTMLElement> {
  return vi.waitFor(
    () => {
      const found = panelSaying(text);
      if (!found) throw new Error(`no panel saying "${text}"`);
      return found;
    },
    { timeout: 3000, interval: 5 },
  );
}

async function moveAway() {
  await userEvent.hover(screen.getByRole("button", { name: "Away" }));
  await vi.waitFor(() => expect(panels()).toEqual([]), { timeout: 2000 });
  await wait(COOL);
}

afterEach(async () => {
  await emulateMedia({ reducedMotion: "no-preference" });
  if (panels().length > 0) await moveAway();
  cleanup();
});

/** Two badges side by side, room above them for the panels, and a place to go. */
function Badges(props: { first?: boolean }) {
  return (
    <div style={{ padding: "160px 40px" }}>
      <Show when={props.first ?? true}>
        <Tooltip text="First explained">
          <span data-testid="first">First</span>
        </Tooltip>
      </Show>
      <Tooltip text="Second explained">
        <span data-testid="second">Second</span>
      </Tooltip>
      <button type="button" style={{ "margin-left": "240px" }}>
        Away
      </button>
    </div>
  );
}

describe("Tooltip timing", () => {
  it("waits before it opens on a cold hover", async () => {
    render(() => <Badges />);
    await userEvent.hover(screen.getByTestId("first"));
    await wait(300);
    expect(panels()).toEqual([]);
    await wait(300);
    expect(panelSaying("First explained")).not.toBeNull();
  });

  it("stays while the pointer crosses onto it, and goes once the pointer leaves it", async () => {
    render(() => <Badges />);
    await userEvent.hover(screen.getByTestId("first"));
    const panel = await waitForPanel("First explained");
    await Promise.all(panel.getAnimations().map((a) => a.finished));
    // From the badge's centre to the panel's, a pixel or two per move, across
    // the 4px gutter between them.
    await movePointer({ selector: '[role="tooltip"]', steps: 30 });
    await wait(150);
    expect(panelSaying("First explained")).toBe(panel);
    await userEvent.hover(screen.getByRole("button", { name: "Away" }));
    await vi.waitFor(() => expect(panels()).toEqual([]), { timeout: 1000 });
    await wait(COOL);
  });

  it("opens a neighbour at once and still, from its first frame", async () => {
    render(() => <Badges />);
    await userEvent.hover(screen.getByTestId("first"));
    const first = await waitForPanel("First explained");
    await Promise.all(first.getAnimations().map((a) => a.finished));
    expect(first.getAnimations()).toHaveLength(1);

    // Every tooltip panel as it is added, with whether it was already marked.
    const added: boolean[] = [];
    const observer = new MutationObserver((records) => {
      for (const record of records)
        for (const node of record.addedNodes) {
          if (!(node instanceof HTMLElement)) continue;
          for (const panel of node.matches('[role="tooltip"]')
            ? [node]
            : node.querySelectorAll('[role="tooltip"]'))
            added.push(panel.hasAttribute("data-instant"));
        }
    });
    observer.observe(document.body, { childList: true, subtree: true });

    await userEvent.hover(screen.getByTestId("second"));
    const second = await waitForPanel("Second explained");
    await frames();
    observer.disconnect();

    expect(added).toEqual([true]);
    expect(second.hasAttribute("data-instant")).toBe(true);
    expect(second.getAnimations()).toHaveLength(0);
    expect(panels()).toEqual([second]);
  });

  it("animates a later panel once the skip window has passed", async () => {
    render(() => <Badges />);
    await userEvent.hover(screen.getByTestId("first"));
    await waitForPanel("First explained");
    await moveAway();

    await userEvent.hover(screen.getByTestId("second"));
    const second = await waitForPanel("Second explained");
    expect(second.hasAttribute("data-instant")).toBe(false);
    expect(second.getAnimations()).toHaveLength(1);
  });

  it("keeps nothing from a panel that unmounted while open", async () => {
    // A row re-rendered under the pointer takes its open tooltip with it. The
    // next hover must still start cold: the delay, then an entry.
    const [first, setFirst] = createSignal(true);
    render(() => <Badges first={first()} />);
    await userEvent.hover(screen.getByTestId("first"));
    await waitForPanel("First explained");
    setFirst(false);
    await moveAway();

    await userEvent.hover(screen.getByTestId("second"));
    await wait(300);
    expect(panels()).toEqual([]);
    const second = await waitForPanel("Second explained");
    expect(second.hasAttribute("data-instant")).toBe(false);
    expect(second.getAnimations()).toHaveLength(1);
  });
});
