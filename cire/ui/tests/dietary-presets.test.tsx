import { DIETARY_PRESETS, type DietaryPreset } from "@cire/dietary";
import "@testing-library/jest-dom/vitest";
// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { createSignal, Show } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";

import DietaryPresets from "../src/dietary-presets";

/*
 * The inline picker's contract: every option visible, nothing to open.
 *
 * This entry point has no viewport fork and imports no popover — that is the
 * bundle boundary `dietary-presets-popover.tsx` exists to hold — so nothing here
 * needs to stub `matchMedia`. The trigger and the wide shell are tested beside
 * the file that owns them.
 */

function Harness(props: { initial?: readonly DietaryPreset[] }) {
  const [value, setValue] = createSignal<readonly DietaryPreset[]>(props.initial ?? []);
  return (
    <>
      <DietaryPresets value={value()} onChange={setValue} label="Dietary requirements for Ada" />
      <output data-testid="value">{value().join(",")}</output>
    </>
  );
}

const valueOf = () => screen.getByTestId("value").textContent;

afterEach(cleanup);

describe("DietaryPresets", () => {
  it("renders every preset in the vocabulary as a checkbox", () => {
    render(() => <Harness />);
    expect(screen.getAllByRole("checkbox")).toHaveLength(DIETARY_PRESETS.length);
  });

  it("names the group for whoever the requirements belong to", () => {
    // On a household sheet "Vegetarian" means nothing without "for Ada" — the
    // label is what keeps a screen reader's announcement attributable.
    render(() => <Harness />);
    expect(screen.getByRole("group", { name: "Dietary requirements for Ada" })).toBeTruthy();
  });

  it("selects more than one, which is the whole reason this is not a select", () => {
    render(() => <Harness />);
    fireEvent.click(screen.getByRole("checkbox", { name: /vegetarian/i }));
    fireEvent.click(screen.getByRole("checkbox", { name: /^nuts$/i }));
    expect(valueOf()).toBe("vegetarian,nuts");
  });

  it("hands back canonical order however it was clicked", () => {
    render(() => <Harness />);
    fireEvent.click(screen.getByRole("checkbox", { name: /^nuts$/i }));
    fireEvent.click(screen.getByRole("checkbox", { name: /vegetarian/i }));
    // Clicked nuts-first, stored diet-first: nothing downstream re-sorts, and
    // two guests who picked the same things produce the same stored string.
    expect(valueOf()).toBe("vegetarian,nuts");
  });

  it("reflects the value it is given, so a saved reply re-lights", () => {
    render(() => <Harness initial={["gluten", "other"]} />);
    expect((screen.getByRole("checkbox", { name: /gluten/i }) as HTMLInputElement).checked).toBe(
      true,
    );
    expect((screen.getByRole("checkbox", { name: /^other$/i }) as HTMLInputElement).checked).toBe(
      true,
    );
    expect((screen.getByRole("checkbox", { name: /vegan/i }) as HTMLInputElement).checked).toBe(
      false,
    );
  });

  it("deselects", () => {
    render(() => <Harness initial={["vegetarian"]} />);
    fireEvent.click(screen.getByRole("checkbox", { name: /vegetarian/i }));
    expect(valueOf()).toBe("");
  });

  it("disables every checkbox when the form is locked", () => {
    render(() => (
      <DietaryPresets value={[]} onChange={() => {}} disabled label="Dietary requirements" />
    ));
    for (const box of screen.getAllByRole("checkbox")) {
      expect((box as HTMLInputElement).disabled).toBe(true);
    }
  });

  it("groups the bands, so an allergy does not read as a preference", () => {
    // A caterer isolates for an allergy and plates for a diet. The headings are
    // what carry that difference to the guest choosing.
    render(() => <Harness />);
    expect(screen.getByText("Diet")).toBeTruthy();
    expect(screen.getByText("Allergies")).toBeTruthy();
  });

  it("asks nothing of matchMedia at all", () => {
    // The property that keeps this entry point safe for every consumer's unit
    // suite, and the reason the viewport fork lives in the other file: mounting
    // must not depend on a DOM global jsdom does not provide.
    const original = window.matchMedia;
    // @ts-expect-error — deleting a DOM global is the situation being reproduced.
    delete window.matchMedia;
    try {
      expect(() => render(() => <Harness />)).not.toThrow();
      expect(screen.getAllByRole("checkbox")).toHaveLength(DIETARY_PRESETS.length);
    } finally {
      window.matchMedia = original;
    }
  });
});

/*
 * A key the server knows and this build does not.
 *
 * The vocabulary grows server-first, and a page already open in a guest's tab
 * keeps the build it loaded with. The saved reply then carries a key missing
 * from this build's vocabulary, and it is still the guest's answer — possibly an
 * allergy. It shows as a checked pill labelled from the key, so the guest can
 * see what they are consenting to and untick it; ticking or unticking any other
 * pill must hand it back, or the next save stores the answer without it and
 * stamps fresh consent over the shortened version.
 */
function OpenHarness(props: { initial: readonly string[] }) {
  const [value, setValue] = createSignal<readonly string[]>(props.initial);
  return (
    <>
      <DietaryPresets value={value()} onChange={setValue} label="Dietary requirements for Ada" />
      <output data-testid="value">{value().join(",")}</output>
    </>
  );
}

describe("a key this build does not know", () => {
  it("survives a tick on another preset, trailing the keys it does know", () => {
    render(() => <OpenHarness initial={["vegan", "a_future_key"]} />);
    fireEvent.click(screen.getByRole("checkbox", { name: /^nuts$/i }));
    expect(valueOf()).toBe("vegan,nuts,a_future_key");
  });

  it("survives an untick", () => {
    render(() => <OpenHarness initial={["vegan", "a_future_key"]} />);
    fireEvent.click(screen.getByRole("checkbox", { name: /vegan/i }));
    expect(valueOf()).toBe("a_future_key");
  });

  it("hands back every such key, in the order they arrived", () => {
    render(() => <OpenHarness initial={["vegan", "future_b", "future_a"]} />);
    fireEvent.click(screen.getByRole("checkbox", { name: /^nuts$/i }));
    expect(valueOf()).toBe("vegan,nuts,future_b,future_a");
  });

  it("is handed back once, however often it arrived", () => {
    render(() => <OpenHarness initial={["a_future_key", "a_future_key"]} />);
    fireEvent.click(screen.getByRole("checkbox", { name: /^egg$/i }));
    expect(valueOf()).toBe("egg,a_future_key");
  });

  it("renders a checked pill labelled from the key", () => {
    render(() => <OpenHarness initial={["a_future_key"]} />);
    const boxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
    expect(boxes).toHaveLength(DIETARY_PRESETS.length + 1);
    const pill = screen.getByRole("checkbox", { name: "A future key" }) as HTMLInputElement;
    expect(pill.checked).toBe(true);
    // Only its own pill lights: nothing in the vocabulary was picked.
    expect(boxes.filter((box) => box.checked)).toEqual([pill]);
  });

  it("renders the pill after every known one, which is the order the value is handed back in", () => {
    render(() => <OpenHarness initial={["a_future_key", "vegan"]} />);
    const names = (screen.getAllByRole("checkbox") as HTMLInputElement[]).map(
      (box) => box.closest("label")?.textContent,
    );
    expect(names.at(-1)).toContain("A future key");
    expect(names.at(-2)).toContain("Other");
  });

  it("renders one pill for a key that arrived twice", () => {
    render(() => <OpenHarness initial={["a_future_key", "a_future_key"]} />);
    expect(screen.getAllByRole("checkbox", { name: "A future key" })).toHaveLength(1);
  });

  it("lets the guest untick it, which drops it from the answer", () => {
    render(() => <OpenHarness initial={["vegan", "a_future_key"]} />);
    const pill = screen.getByRole("checkbox", { name: "A future key" }) as HTMLInputElement;
    fireEvent.click(pill);
    expect(valueOf()).toBe("vegan");
    // The pill stays, unticked — the same element, so a keyboard user's focus
    // stays where they put it rather than falling to the page.
    expect(screen.getByRole("checkbox", { name: "A future key" })).toBe(pill);
    expect(pill.checked).toBe(false);
  });

  it("lets the guest tick it again while the picker is open", () => {
    render(() => <OpenHarness initial={["vegan", "a_future_key"]} />);
    const pill = screen.getByRole("checkbox", { name: "A future key" });
    fireEvent.click(pill);
    fireEvent.click(pill);
    expect(valueOf()).toBe("vegan,a_future_key");
    expect((pill as HTMLInputElement).checked).toBe(true);
  });

  it("forgets an unticked key once the picker unmounts", () => {
    // The popover unmounts this component when it closes, and the guest sheet
    // when a member stops attending. A remounted picker knows only the value.
    const [value, setValue] = createSignal<readonly string[]>(["a_future_key"]);
    const [open, setOpen] = createSignal(true);
    render(() => (
      <Show when={open()}>
        <DietaryPresets value={value()} onChange={setValue} />
      </Show>
    ));
    fireEvent.click(screen.getByRole("checkbox", { name: "A future key" }));
    setOpen(false);
    setOpen(true);
    expect(screen.queryByRole("checkbox", { name: "A future key" })).toBeNull();
  });

  it("disables the pill with the rest when the form is locked", () => {
    render(() => <DietaryPresets value={["a_future_key"]} onChange={() => {}} disabled />);
    expect(
      (screen.getByRole("checkbox", { name: "A future key" }) as HTMLInputElement).disabled,
    ).toBe(true);
  });

  it("renders no pill for an empty or blank key, which has no words to show", () => {
    render(() => <OpenHarness initial={["", "   "]} />);
    expect(screen.getAllByRole("checkbox")).toHaveLength(DIETARY_PRESETS.length);
  });
});

describe("the pill's containing block", () => {
  it("positions each pill, so its hidden checkbox resolves inside it", () => {
    // `sr-only` is `position: absolute`. With a static label the input resolves
    // against whatever box is positioned further up the tree — on the guest
    // invite that was the `<dialog>`, outside the horizontally scrolling track,
    // so the input did not travel with the scroll and focusing it slid the
    // whole sheet sideways. Measured in Chromium at
    // `cire/invites/tests/components/DietaryPresets.browser.test.tsx`; this is
    // the cheap guard that the class survives an edit to the list.
    const { container } = render(() => <DietaryPresets value={[]} onChange={() => {}} />);
    const labels = [...container.querySelectorAll("label")];
    expect(labels.length).toBeGreaterThan(0);
    // A token, not a substring: `md:relative` and `has-[:checked]:relative` both
    // contain the word and neither makes the pill a containing block at the
    // moment the input is focused.
    for (const label of labels) expect(label.className.split(/\s+/)).toContain("relative");
  });
});
