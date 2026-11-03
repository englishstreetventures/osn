// @vitest-environment happy-dom
import { cleanup, fireEvent, render } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";

import { buttonClass } from "../src/button";
import PersonAvatar, { avatarTriggerClass } from "../src/person-avatar";

/**
 * A person's photo, or their stand-in when there is none: the empty avatar on
 * a stack of faces, the account's initial on an account's circle. What every
 * caller relies on: a photo is requested only from an absolute https URL, with
 * no `Referer`, and named by nobody (the caller names the person in text); a
 * URL that failed once is not tried again anywhere on the page, while a new
 * one gets its own try. That it loads no menu library is held in
 * `person-avatar-source.test.ts`.
 *
 * The failed-URL store lives for the page, so each test uses URLs of its own.
 */

afterEach(cleanup);

function root(container: HTMLElement): HTMLElement {
  return container.firstElementChild as HTMLElement;
}

function classesOf(el: Element): string[] {
  return (el.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);
}

describe("PersonAvatar", () => {
  it.each([
    ["http:", "http://photos.example/ada.png"],
    ["javascript:", "javascript:alert(1)"],
    ["a relative path", "/ada.png"],
    ["a malformed string", "not a url"],
    ["an empty string", ""],
    ["null", null],
    ["nothing", undefined],
  ])("requests no photo for %s", (_, url) => {
    const { container } = render(() => <PersonAvatar fallback="blank" url={url} class="size-8" />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("[data-blank-avatar]")).not.toBeNull();
  });

  it("requests an https photo with no Referer and no name of its own", () => {
    const { container } = render(() => (
      <PersonAvatar fallback="blank" url="https://photos.example/ok-1.png" class="size-8" />
    ));
    const img = container.querySelector("img")!;
    expect(img.getAttribute("src")).toBe("https://photos.example/ok-1.png");
    expect(img.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(img.getAttribute("alt")).toBe("");
  });

  it("falls back at once when its photo will not load", () => {
    const { container } = render(() => (
      <PersonAvatar
        fallback="initial"
        name="Ada"
        url="https://photos.example/dead-1.png"
        class="size-9"
      />
    ));
    fireEvent.error(container.querySelector("img")!);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toBe("A");
  });

  it("does not try a failed photo again anywhere on the page, but tries a new one", () => {
    const first = render(() => (
      <PersonAvatar fallback="blank" url="https://photos.example/dead-2.png" class="size-8" />
    ));
    fireEvent.error(first.container.querySelector("img")!);
    const again = render(() => (
      <PersonAvatar fallback="blank" url="https://photos.example/dead-2.png" class="size-8" />
    ));
    expect(again.container.querySelector("img")).toBeNull();
    const fresh = render(() => (
      <PersonAvatar fallback="blank" url="https://photos.example/fresh-2.png" class="size-8" />
    ));
    expect(fresh.container.querySelector("img")).not.toBeNull();
  });

  it("keeps a photo it has drawn when the same URL fails for another face", () => {
    const drawn = render(() => (
      <PersonAvatar fallback="blank" url="https://photos.example/flaky-4.png" class="size-8" />
    ));
    fireEvent.load(drawn.container.querySelector("img")!);
    const other = render(() => (
      <PersonAvatar fallback="blank" url="https://photos.example/flaky-4.png" class="size-8" />
    ));
    fireEvent.error(other.container.querySelector("img")!);
    expect(other.container.querySelector("img")).toBeNull();
    expect(drawn.container.querySelector("img")).not.toBeNull();
  });

  it("frames an account's circle, and never a face in a stack", () => {
    const frame = (el: HTMLElement) =>
      classesOf(el).filter((c) => /(^|:)(border|bg)(-|$)/.test(c) && !c.includes("group-hover"));
    const face = render(() => <PersonAvatar fallback="blank" class="size-8" />);
    expect(frame(root(face.container))).toEqual([]);
    cleanup();
    const account = render(() => <PersonAvatar fallback="initial" name="Ada" class="size-9" />);
    // A hairline and no fill: the guest site lays no ground under a gold word.
    expect(frame(root(account.container))).toEqual(["base:border", "base:border-ui-hairline"]);
  });

  it("draws the empty avatar, never a letter, for blank", () => {
    const { container } = render(() => <PersonAvatar fallback="blank" class="size-8" />);
    expect(container.querySelector("[data-blank-avatar]")).not.toBeNull();
    expect(container.textContent).toBe("");
  });

  it.each([
    ["Ada Lovelace", "A"],
    ["  jo  ", "J"],
    ["élise", "É"],
    ["𝒜da", "𝒜"],
    // An accent typed after its letter stays on it; a flag stays one flag.
    ["e\u0301lise", "E\u0301"],
    ["🇦🇺 crew", "🇦🇺"],
    // Upper-cased only when it stays one letter.
    ["ßen", "ß"],
    ["   ", "?"],
    ["", "?"],
  ])("draws the initial of %j as %j", (name, letter) => {
    const { container } = render(() => (
      <PersonAvatar fallback="initial" name={name} class="size-9" />
    ));
    expect(container.querySelector("[data-blank-avatar]")).toBeNull();
    expect(container.textContent).toBe(letter);
  });

  it("takes the first code point where the browser cannot segment graphemes", () => {
    // Firefox before 125 has no `Intl.Segmenter`.
    const segmenter = Intl.Segmenter;
    Reflect.deleteProperty(Intl, "Segmenter");
    try {
      const { container } = render(() => (
        <PersonAvatar fallback="initial" name="𝒜da" class="size-9" />
      ));
      expect(container.textContent).toBe("𝒜");
    } finally {
      Object.defineProperty(Intl, "Segmenter", {
        value: segmenter,
        configurable: true,
        writable: true,
      });
    }
  });

  it("draws the page-colour band only when asked", () => {
    const rings = (el: HTMLElement) => classesOf(el).filter((c) => /(^|:)ring-/.test(c));
    const plain = render(() => <PersonAvatar fallback="blank" class="size-8" />);
    expect(rings(root(plain.container))).toEqual([]);
    cleanup();
    const ringed = render(() => <PersonAvatar fallback="blank" ring class="size-7" />);
    expect(rings(root(ringed.container))).toEqual(["base:ring-2", "base:ring-ui-ground"]);
  });

  it("is hidden from assistive technology, whichever it draws", () => {
    const { container } = render(() => (
      <>
        <PersonAvatar fallback="blank" class="size-8" />
        <PersonAvatar fallback="initial" name="Ada" class="size-9" />
        <PersonAvatar fallback="blank" url="https://photos.example/ok-3.png" class="size-8" />
      </>
    ));
    for (const avatar of container.children) {
      expect(avatar.getAttribute("aria-hidden")).toBe("true");
    }
  });

  it("asks for a name with the initial, and for a size", () => {
    // Held by the type check (`bun run typecheck`), which fails if the line
    // under the directive compiles; never rendered.
    // @ts-expect-error -- `initial` needs the name it draws the letter from.
    const nameless = () => <PersonAvatar fallback="initial" class="size-9" />;
    // @ts-expect-error -- the circle measures its letter from the size it is given.
    const sizeless = () => <PersonAvatar fallback="blank" />;
    expect([nameless, sizeless]).toHaveLength(2);
  });
});

describe("avatarTriggerClass", () => {
  it("draws Button's own focus ring", () => {
    const ring = (classes: string[]) => classes.filter((c) => c.includes("focus-visible:"));
    expect(ring(avatarTriggerClass.split(/\s+/))).toEqual(ring(buttonClass().split(/\s+/)));
  });

  it("names the group the avatar's edge answers under the pointer", () => {
    const { container } = render(() => (
      <PersonAvatar fallback="initial" name="Ada" class="size-full" />
    ));
    const group = /(?:^|\s)group\/([\w-]+)/.exec(avatarTriggerClass)?.[1];
    expect(group).toBeTruthy();
    expect(classesOf(root(container)).some((c) => c.includes(`group-hover/${group}:`))).toBe(true);
  });
});
