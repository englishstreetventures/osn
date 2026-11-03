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
    const { container } = render(() => <PersonAvatar fallback="blank" url={url} />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("[data-blank-avatar]")).not.toBeNull();
  });

  it("requests an https photo with no Referer and no name of its own", () => {
    const { container } = render(() => (
      <PersonAvatar fallback="blank" url="https://photos.example/ok-1.png" />
    ));
    const img = container.querySelector("img")!;
    expect(img.getAttribute("src")).toBe("https://photos.example/ok-1.png");
    expect(img.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(img.getAttribute("alt")).toBe("");
  });

  it("falls back at once when its photo will not load", () => {
    const { container } = render(() => (
      <PersonAvatar fallback="initial" name="Ada" url="https://photos.example/dead-1.png" />
    ));
    fireEvent.error(container.querySelector("img")!);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toBe("A");
  });

  it("does not try a failed photo again anywhere on the page, but tries a new one", () => {
    const first = render(() => (
      <PersonAvatar fallback="blank" url="https://photos.example/dead-2.png" />
    ));
    fireEvent.error(first.container.querySelector("img")!);
    const again = render(() => (
      <PersonAvatar fallback="blank" url="https://photos.example/dead-2.png" />
    ));
    expect(again.container.querySelector("img")).toBeNull();
    const fresh = render(() => (
      <PersonAvatar fallback="blank" url="https://photos.example/fresh-2.png" />
    ));
    expect(fresh.container.querySelector("img")).not.toBeNull();
  });

  it("draws the empty avatar, never a letter, for blank", () => {
    const { container } = render(() => <PersonAvatar fallback="blank" />);
    expect(container.querySelector("[data-blank-avatar]")).not.toBeNull();
    expect(container.textContent).toBe("");
  });

  it.each([
    ["Ada Lovelace", "A"],
    ["  jo  ", "J"],
    ["élise", "É"],
    ["𝒜da", "𝒜"],
    ["   ", "?"],
    ["", "?"],
  ])("draws the initial of %j as %j", (name, letter) => {
    const { container } = render(() => <PersonAvatar fallback="initial" name={name} />);
    expect(container.querySelector("[data-blank-avatar]")).toBeNull();
    expect(container.textContent).toBe(letter);
  });

  it("draws the page-colour band only when asked", () => {
    const rings = (el: HTMLElement) => classesOf(el).filter((c) => /(^|:)ring-/.test(c));
    const plain = render(() => <PersonAvatar fallback="blank" />);
    expect(rings(root(plain.container))).toEqual([]);
    cleanup();
    const ringed = render(() => <PersonAvatar fallback="blank" ring />);
    expect(rings(root(ringed.container))).toEqual(["base:ring-2", "base:ring-ui-ground"]);
  });

  it("is hidden from assistive technology, whichever it draws", () => {
    const { container } = render(() => (
      <>
        <PersonAvatar fallback="blank" />
        <PersonAvatar fallback="initial" name="Ada" />
        <PersonAvatar fallback="blank" url="https://photos.example/ok-3.png" />
      </>
    ));
    for (const avatar of container.children) {
      expect(avatar.getAttribute("aria-hidden")).toBe("true");
    }
  });

  it("asks for a name with the initial", () => {
    // Held by the type check (`bun run typecheck`), which fails if the line
    // under the directive compiles; never rendered.
    // @ts-expect-error -- `initial` needs the name it draws the letter from.
    const nameless = () => <PersonAvatar fallback="initial" />;
    expect(nameless).toBeTypeOf("function");
  });
});

describe("avatarTriggerClass", () => {
  it("draws Button's own focus ring", () => {
    const ring = (classes: string[]) => classes.filter((c) => c.includes("focus-visible:"));
    expect(ring(avatarTriggerClass.split(/\s+/))).toEqual(ring(buttonClass().split(/\s+/)));
  });

  it("names the group the avatar's edge answers under the pointer", () => {
    const { container } = render(() => <PersonAvatar fallback="initial" name="Ada" />);
    const group = /(?:^|\s)group\/([\w-]+)/.exec(avatarTriggerClass)?.[1];
    expect(group).toBeTruthy();
    expect(classesOf(root(container)).some((c) => c.includes(`group-hover/${group}:`))).toBe(true);
  });
});
