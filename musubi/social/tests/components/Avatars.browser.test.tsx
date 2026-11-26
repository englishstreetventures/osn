import { cleanup, render, waitFor } from "@solidjs/testing-library";
import type { JSX } from "solid-js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { page } from "vitest/browser";

import "../../src/App.css";
import { OrgAvatar, ProfileAvatar } from "../../src/components/Avatars";
// `?no-inline`: Vite would inline a file this small as a `data:` address,
// which an avatar refuses; a picture is drawn only from an http(s) one.
import picture from "../test-support/app-logo.svg?no-inline";

/**
 * An avatar's picture in a real browser, for both of Musubi's avatars: the
 * picture when it loads, the initials when there is none, when it does not
 * load, or when its address is not http(s) — one or the other, never both.
 * No seeded profile or organisation has a picture, so no flow reaches this.
 * Shots go to `__screenshots__/` beside this file.
 */

const SHOTS = "__screenshots__/Avatars.browser.test.tsx";

/** A picture the test server serves. */
const LOADS = new URL(picture, location.origin).href;
/** An address the test server holds no picture at. */
const MISSING = new URL("/tests/test-support/no-such-avatar.png", location.origin).href;
/** A 1x1 PNG that would draw if its address reached `src`. */
const DATA_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

type Kind = { name: string; initials: string; draw: (url: string) => JSX.Element };

const KINDS: Kind[] = [
  {
    name: "OrgAvatar",
    initials: "AC",
    draw: (url) => (
      <OrgAvatar org={{ name: "Acme", handle: "acme", avatarUrl: url }} class="size-16" />
    ),
  },
  {
    name: "ProfileAvatar",
    initials: "AD",
    draw: (url) => (
      <ProfileAvatar
        profile={{ handle: "ada", displayName: "Ada Lovelace", avatarUrl: url }}
        class="size-16"
      />
    ),
  },
];

function renderAvatar(kind: Kind, url: string): HTMLElement {
  const { container } = render(() => <div class="p-4">{kind.draw(url)}</div>);
  return container.querySelector<HTMLElement>("div > span")!;
}

/** What a press at the avatar's centre would land on: what is seen there. */
function seenAtCentre(avatar: HTMLElement): Element | null {
  const box = avatar.getBoundingClientRect();
  return document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
}

beforeEach(async () => {
  await page.viewport(390, 844);
});

afterEach(() => {
  cleanup();
});

describe.each(KINDS)("$name", (kind) => {
  it("draws the initials, and drops the img, when the picture does not load", async () => {
    const avatar = renderAvatar(kind, MISSING);
    // The picture is asked for first.
    expect(avatar.querySelector("img")?.getAttribute("src")).toBe(MISSING);

    await waitFor(() => expect(avatar.querySelector("img")).toBeNull());
    expect(avatar.textContent).toBe(kind.initials);
    expect(seenAtCentre(avatar)?.textContent).toBe(kind.initials);
    await page.screenshot({ path: `${SHOTS}/${kind.name}-missing.png` });
  });

  it("never puts a data: or javascript: address in an img, and draws the initials", async () => {
    for (const url of [DATA_PNG, "javascript:alert(1)"]) {
      const avatar = renderAvatar(kind, url);
      expect(avatar.querySelector("img")).toBeNull();
      expect(avatar.textContent).toBe(kind.initials);
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      expect(avatar.querySelector("img")).toBeNull();
      cleanup();
    }
    const avatar = renderAvatar(kind, DATA_PNG);
    expect(seenAtCentre(avatar)?.textContent).toBe(kind.initials);
    await page.screenshot({ path: `${SHOTS}/${kind.name}-refused.png` });
  });

  it("draws a picture that loads, with no initials behind or beside it", async () => {
    const avatar = renderAvatar(kind, LOADS);
    const img = avatar.querySelector("img")!;
    expect(img.getAttribute("src")).toBe(LOADS);

    await waitFor(() => expect(img.complete && img.naturalWidth > 0).toBe(true));
    expect(avatar.querySelector("img")).toBe(img);
    expect(avatar.textContent).toBe("");
    expect(seenAtCentre(avatar)).toBe(img);
    await page.screenshot({ path: `${SHOTS}/${kind.name}-loaded.png` });
  });
});
