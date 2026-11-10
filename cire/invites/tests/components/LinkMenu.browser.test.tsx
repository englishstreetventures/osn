import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";
import { page } from "vitest/browser";

import "../../src/styles/global.css";
import { LinkMenu, type LinkMenuItem } from "../../src/components/LinkMenu";

/**
 * The link menu's pop, measured in the top layer it paints in.
 *
 * It opens as the portals' menus do: scaled up a little from the corner at its
 * trigger as it fades in, one animation on the ladder's `--dur-base` and the
 * house curve. Sampled at its first frame, it is at the enter scale and
 * transparent, growing from the trigger's corner — the top corner when it
 * opens under the trigger, the bottom one when it opens over it. It has no
 * exit: a close takes it out of the document at once, so focus goes back to
 * the trigger with nothing held mounted.
 *
 * jsdom runs no animation and resolves no `transform-origin`.
 */

const ITEMS: LinkMenuItem[] = [
  { label: "Google Calendar", href: "https://calendar.example/google" },
  { label: "Outlook.com", href: "https://calendar.example/outlook" },
];

afterEach(async () => {
  cleanup();
  await page.viewport(390, 844);
});

const frame = () => new Promise(requestAnimationFrame);

/** Mount the menu's trigger at `top`, `left` on a phone screen and open it with a tap. */
async function openAt(top: number, left: number) {
  await page.viewport(390, 844);
  render(() => (
    <div style={{ "padding-top": `${top}px`, "padding-left": `${left}px` }}>
      <LinkMenu label="Add to calendar" menuLabel="Add to calendar options" items={ITEMS} />
    </div>
  ));
  const trigger = screen.getByRole("button", { name: "Add to calendar" });
  fireEvent.click(trigger, { detail: 1 });
  // The popover is shown a microtask after it mounts, and placed again then.
  await Promise.resolve();
  await frame();
  const menu = screen.getByRole("menu");
  return { trigger, menu };
}

/** What `--dur-base` resolves to here, in milliseconds. */
function durBase(): number {
  const probe = document.createElement("div");
  probe.style.transitionDuration = "var(--dur-base)";
  document.body.append(probe);
  const ms = parseFloat(getComputedStyle(probe).transitionDuration) * 1000;
  probe.remove();
  return ms;
}

/** The menu's one animation, paused at its first frame. */
function firstFrame(menu: HTMLElement) {
  const running = menu.getAnimations();
  expect(running).toHaveLength(1);
  const pop = running[0] as CSSAnimation;
  pop.pause();
  pop.currentTime = 0;
  const style = getComputedStyle(menu);
  const sample = {
    name: pop.animationName,
    duration: Number(pop.effect?.getTiming().duration),
    opacity: Number(style.opacity),
    transform: style.transform,
    origin: style.transformOrigin.split(" ").map(parseFloat),
  };
  pop.finish();
  return sample;
}

describe("LinkMenu's pop", () => {
  it("grows from its trigger's top corner as it opens under it", async () => {
    const { trigger, menu } = await openAt(120, 24);
    const sample = firstFrame(menu);
    // Measured once the pop has finished: a box mid-pop is scaled.
    const t = trigger.getBoundingClientRect();
    const m = menu.getBoundingClientRect();
    expect(m.top).toBeGreaterThan(t.bottom);

    // The shared enter keyframe, the one the portals' menus run.
    expect(sample.name).toBe("ui-enter");
    expect(sample.duration).toBe(durBase());
    expect(sample.opacity).toBe(0);
    expect(sample.transform).toBe(`matrix(0.96, 0, 0, 0.96, 0, 0)`);
    expect(sample.origin[0]).toBeCloseTo(t.left - m.left, 0);
    expect(sample.origin[1]).toBe(0);
  });

  it("grows from its trigger's bottom corner as it opens over it, near the right edge", async () => {
    // The menu is held inside the right-hand gutter, so its left edge is
    // short of the trigger's and the origin sits inside the menu.
    const { trigger, menu } = await openAt(760, 300);
    const sample = firstFrame(menu);
    const t = trigger.getBoundingClientRect();
    const m = menu.getBoundingClientRect();
    expect(m.bottom).toBeLessThan(t.top);
    expect(t.left - m.left).toBeGreaterThan(100);

    expect(sample.origin[0]).toBeCloseTo(t.left - m.left, 0);
    expect(sample.origin[1]).toBeCloseTo(m.height, 0);
  });

  it("has no exit: a close takes it out of the document at once", async () => {
    const { trigger } = await openAt(120, 24);
    fireEvent.click(trigger, { detail: 1 });
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
