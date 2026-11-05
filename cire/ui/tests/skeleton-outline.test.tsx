// @vitest-environment happy-dom
import { cleanup, render } from "@solidjs/testing-library";
import { createSignal, type JSX, Show } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";

import SkeletonOutline from "../src/skeleton-outline";

/*
 * The structural half of `SkeletonOutline`: which text it puts in a run and
 * which it leaves alone, and what the wrapper says to assistive technology.
 * Whether a run paints a bar, a control a block, and whether the outline keeps
 * the loaded markup's size is `skeleton-outline.browser.test.tsx`, since
 * happy-dom paints nothing and lays nothing out.
 */

afterEach(cleanup);

function outline(children: () => JSX.Element): HTMLElement {
  const { container } = render(() => <SkeletonOutline>{children()}</SkeletonOutline>);
  return container.firstElementChild as HTMLElement;
}

const runs = (root: Element) =>
  [...root.querySelectorAll("[data-skeleton-run]")].map((run) => run.textContent);

describe("SkeletonOutline", () => {
  it("puts a run of words deep in the tree in a span of its own", () => {
    const root = outline(() => (
      <table>
        <tbody>
          <tr>
            <td>
              <span class="block">Okonkwo</span>
            </td>
          </tr>
        </tbody>
      </table>
    ));
    const run = root.querySelector("[data-skeleton-run]")!;
    expect(run.tagName).toBe("SPAN");
    expect(run.childNodes).toHaveLength(1);
    expect(run.firstChild!.nodeType).toBe(Node.TEXT_NODE);
    expect(run.textContent).toBe("Okonkwo");
    expect(run.parentElement!.className).toBe("block");
  });

  it("puts a text child at the top level in a run too", () => {
    expect(runs(outline(() => "Households"))).toEqual(["Households"]);
  });

  it("draws nothing for text with no letter or digit", () => {
    const root = outline(() => (
      <p>
        <span>·</span>
        <span>--</span>
        <span>—</span> <span>Ceremony</span>
      </p>
    ));
    expect(runs(root)).toEqual(["Ceremony"]);
  });

  it("takes digits alone as a run", () => {
    expect(
      runs(
        outline(() => (
          <dl>
            <dt>Attending</dt>
            <dd>64</dd>
          </dl>
        )),
      ),
    ).toEqual(["Attending", "64"]);
  });

  it("leaves the text of a glyph, an option and a text box where it is", () => {
    const root = outline(() => (
      <div>
        <svg viewBox="0 0 10 10" aria-hidden="true">
          <text x="0" y="8">
            A
          </text>
        </svg>
        <select aria-label="Status">
          <option>Attending</option>
        </select>
        <textarea aria-label="Note">Vegetarian</textarea>
        <style>{".x { color: red }"}</style>
        <span>Kept</span>
      </div>
    ));
    expect(runs(root)).toEqual(["Kept"]);
    expect(root.querySelector("textarea")!.value).toBe("Vegetarian");
  });

  it("marks children that arrive later once, and never a run twice", () => {
    const [wide, setWide] = createSignal(true);
    const root = outline(() => (
      <Show
        when={wide()}
        fallback={
          <ul>
            <li>Phone row</li>
          </ul>
        }
      >
        <p>Table row</p>
      </Show>
    ));
    expect(runs(root)).toEqual(["Table row"]);
    setWide(false);
    expect(runs(root)).toEqual(["Phone row"]);
    setWide(true);
    expect(runs(root)).toEqual(["Table row"]);
    expect(root.querySelector("[data-skeleton-run] [data-skeleton-run]")).toBeNull();
  });

  it("is hidden from a screen reader and out of reach, with no role", () => {
    const root = outline(() => <button type="button">Edit</button>);
    expect(root.tagName).toBe("DIV");
    expect(root.getAttribute("aria-hidden")).toBe("true");
    expect(root.hasAttribute("inert")).toBe(true);
    expect(root.hasAttribute("data-skeleton-outline")).toBe(true);
    expect(root.hasAttribute("role")).toBe(false);
  });
});
