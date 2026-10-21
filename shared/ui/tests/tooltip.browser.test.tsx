/**
 * Two of `Tooltip`'s guarantees that a caller's own test cannot see, because
 * each one only matters where the caller's page does not already cover it:
 *
 * - The hidden copy is `normal-case`. Chrome passes a `text-transform` into the
 *   text it exposes, so a trigger inside an `uppercase` run (`Th` is one) would
 *   otherwise reach a screen reader in capitals.
 * - The panel's enter and exit sit behind `motion-safe:`. This tier's
 *   stylesheet has no `*` reduced-motion switch of its own, unlike cire host's,
 *   so here nothing but the prefix stops the animation.
 *
 * Every other guarantee is held where the component is used, by
 * `cire/host/tests/components/RsvpView.badges.browser.test.tsx`.
 */

import { cleanup, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cdp, commands, userEvent } from "vitest/browser";

import { Tooltip } from "../src/ui/tooltip";

import "./test-support/tailwind.css";

const TEXT = "Recorded by a host from a phone call";

type MotionPreference = { reducedMotion: "reduce" | "no-preference" };
const emulateMedia = (options: MotionPreference) =>
  (commands as unknown as { emulateMedia: (o: MotionPreference) => Promise<void> }).emulateMedia(
    options,
  );

interface AXNode {
  ignored: boolean;
  role?: { value: string };
  name?: { value: string };
}

interface Frame {
  frame: { id: string; url: string };
  childFrames?: Frame[];
}

/** Chrome's accessibility tree for the frame this test runs in. */
async function accessibilityTree(): Promise<AXNode[]> {
  const session = cdp();
  const { frameTree } = (await session.send("Page.getFrameTree")) as { frameTree: Frame };
  const find = (node: Frame): Frame | undefined =>
    node.frame.url === location.href ? node : node.childFrames?.map(find).find(Boolean);
  const own = find(frameTree);
  if (!own) throw new Error(`no frame at ${location.href}`);
  const { nodes } = (await session.send("Accessibility.getFullAXTree", {
    frameId: own.frame.id,
  })) as { nodes: AXNode[] };
  return nodes;
}

/** The open panel. It is `aria-hidden`, so a role query skips it. */
async function openPanel(): Promise<HTMLElement> {
  await userEvent.hover(screen.getByText("Host-entered"));
  return vi.waitFor(
    () => {
      const found = document.querySelector<HTMLElement>('[role="tooltip"]');
      if (!found) throw new Error("no panel after hovering");
      return found;
    },
    { timeout: 3000 },
  );
}

function mount() {
  return render(() => (
    <p class="uppercase">
      Guest{" "}
      <Tooltip text={TEXT}>
        <span>Host-entered</span>
      </Tooltip>
    </p>
  ));
}

afterEach(async () => {
  await emulateMedia({ reducedMotion: "no-preference" });
  cleanup();
});

describe("Tooltip", () => {
  it("hands the hidden copy over as written, inside an uppercase run", async () => {
    mount();
    const texts = (await accessibilityTree())
      .filter((node) => !node.ignored && node.role?.value === "StaticText")
      .map((node) => node.name?.value);
    expect(texts.filter((name) => name === TEXT)).toHaveLength(1);
    expect(texts.filter((name) => name === TEXT.toUpperCase())).toHaveLength(0);
  });

  it("animates the panel in for a reader who has not asked for less motion", async () => {
    mount();
    // The control for the test below: an empty list there means something only
    // if an animation shows up here. `fill-mode: both` keeps a finished one in
    // the list.
    expect((await openPanel()).getAnimations()).toHaveLength(1);
  });

  it("does not animate the panel for a reader who asked for reduced motion", async () => {
    await emulateMedia({ reducedMotion: "reduce" });
    mount();
    expect((await openPanel()).getAnimations()).toHaveLength(0);
  });
});
