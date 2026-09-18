import { Field } from "@shared/ui/ui/field";
import "@testing-library/jest-dom/vitest";
// @vitest-environment happy-dom
import { cleanup, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";

import Button from "../src/button";
import Card, { cardClass, CardEyebrow } from "../src/card";
import Loading from "../src/loading";
import { UsernameInput } from "../src/username-input";

/**
 * These are class-mapping components, and a test that asserts the classes is a
 * test that has to be edited every time the design moves — it pins the current
 * answer, not the contract. So what is checked here is what a call site can
 * rely on: that the variants differ from each other, that props reach the DOM,
 * and that the accessibility wiring is there.
 *
 * They came from `cire/host` and `cire/vendor`, which each had a copy. The
 * components they cover are the ones that stayed cire's — everything else the
 * two portals duplicated is in `@shared/ui` now, and so are its tests.
 */

afterEach(cleanup);

describe("Button", () => {
  it("does not submit the form it is standing in, unless told to", () => {
    // A toolbar control inside a settings form is the common case, and a button
    // with no type is a submit button.
    const { getByRole } = render(() => <Button>Export</Button>);
    expect(getByRole("button")).toHaveProperty("type", "button");
  });

  it("still takes a type when the caller means it", () => {
    const { getByRole } = render(() => <Button type="submit">Save</Button>);
    expect(getByRole("button")).toHaveProperty("type", "submit");
  });

  it("gives each variant a different look", () => {
    const { getByText } = render(() => (
      <>
        <Button variant="primary">Commit</Button>
        <Button variant="outline">Second</Button>
        <Button variant="quiet">Quiet</Button>
        <Button variant="danger">Delete</Button>
      </>
    ));
    const classes = ["Commit", "Second", "Quiet", "Delete"].map(
      (label) => getByText(label).className,
    );
    expect(new Set(classes).size).toBe(4);
  });

  it("gives each size a different look", () => {
    const { getByText } = render(() => (
      <>
        <Button size="sm">Small</Button>
        <Button size="md">Medium</Button>
        <Button size="icon">✕</Button>
      </>
    ));
    const classes = ["Small", "Medium", "✕"].map((label) => getByText(label).className);
    expect(new Set(classes).size).toBe(3);
  });

  it("keeps the caller's own classes", () => {
    const { getByRole } = render(() => <Button class="self-start">Add</Button>);
    expect(getByRole("button").className).toContain("self-start");
  });

  it("passes everything else through", () => {
    const { getByRole } = render(() => (
      <Button disabled aria-label="Remove guest">
        ✕
      </Button>
    ));
    expect(getByRole("button")).toBeDisabled();
    expect(getByRole("button")).toHaveAttribute("aria-label", "Remove guest");
  });
});

describe("Button — the borderless variants", () => {
  it("draws no box, which is the whole distinction from the bordered four", () => {
    // Collected then asserted once, so a failure names the variant that broke
    // rather than stopping at the first and leaving the rest unmeasured.
    const boxed = (["link", "subtle", "bare", "bareDanger"] as const).filter((variant) => {
      const { getByRole, unmount } = render(() => <Button variant={variant}>Go</Button>);
      const cls = getByRole("button").className;
      unmount();
      return !cls.includes("border-transparent") || !cls.includes("bg-transparent");
    });
    expect(boxed).toEqual([]);
  });

  it("does not shout, where a bordered button does", () => {
    // Uppercase is the bordered house style. A text link reads as a sentence
    // fragment — "Cancel", "View listing" — and shouting it makes it a button
    // wearing a link's clothes.
    const bordered = render(() => <Button variant="primary">Save</Button>);
    expect(bordered.getByRole("button").className).toContain("uppercase");
    bordered.unmount();

    const link = render(() => <Button variant="link">View listing</Button>);
    expect(link.getByRole("button").className).not.toContain("uppercase");
  });

  it("takes the type size but not a bordered control's padding", () => {
    // `px-4 py-2` is what makes a bordered control a control. The same padding
    // on a text link is a word floating in a gap.
    const { getByRole } = render(() => <Button variant="link">Go</Button>);
    const cls = getByRole("button").className;
    expect(cls).toContain("text-ui-sm");
    expect(cls).not.toMatch(/base:px-4|base:py-2/);
  });

  it("underlines a link but never a glyph", () => {
    // `bare` is an arrow or a cross. There is no word to underline.
    const link = render(() => <Button variant="subtle">Cancel</Button>);
    expect(link.getByRole("button").className).toContain("hover:underline");
    link.unmount();

    const glyph = render(() => <Button variant="bare">{"\u25B2"}</Button>);
    expect(glyph.getByRole("button").className).not.toContain("underline");
  });

  it("keeps a destructive glyph muted at rest and red only on hover", () => {
    // Folding these into `bare` was a real regression: five delete actions
    // stopped signalling anything. A row of red crosses down a table reads as
    // an error state rather than a column of controls, so the danger belongs
    // on hover, where it arrives exactly when it is useful.
    const { getByRole } = render(() => <Button variant="bareDanger">{"\u00D7"}</Button>);
    const cls = getByRole("button").className;
    expect(cls).toContain("text-ui-ink-secondary");
    expect(cls).toContain("hover:text-ui-danger");
    expect(cls).not.toMatch(/base:text-ui-danger\b/);
  });
});

describe("Button — the variants that carry state or fill", () => {
  it("keeps a destructive worded action muted at rest, like its glyph twin", () => {
    // Same reasoning as `bareDanger`, for the control that OFFERS the
    // destruction rather than the one that commits it. `danger` is the commit.
    const quiet = render(() => <Button variant="quietDanger">Deactivate</Button>);
    const cls = quiet.getByRole("button").className;
    expect(cls).toContain("text-ui-ink-secondary");
    expect(cls).toContain("hover:text-ui-danger");
    expect(cls).not.toMatch(/base:text-ui-danger\b/);
    quiet.unmount();

    const commit = render(() => <Button variant="danger">Delete</Button>);
    expect(commit.getByRole("button").className).toMatch(/base:text-ui-danger\b/);
  });

  it("marks the chosen option whichever ARIA property the group uses", () => {
    // Two of the four call sites are toggle groups (`aria-pressed`) and two are
    // radio groups (`aria-checked`). Which one carries the state is the group's
    // business; the mark has to be the same either way.
    const { getByRole } = render(() => <Button variant="choice">Phone</Button>);
    const cls = getByRole("button").className;
    expect(cls).toContain("aria-pressed:border-ui-accent");
    expect(cls).toContain("aria-checked:border-ui-accent");
  });

  it("leaves the focus ring to the shared base rather than drawing its own", () => {
    // The call sites this replaces each hand-rolled a gold ring. `--ui-focus`
    // is the app's own contrast-checked token and is already on every button.
    const { getByRole } = render(() => <Button variant="choice">Phone</Button>);
    const cls = getByRole("button").className;
    expect(cls).toContain("focus-visible:outline-ui-focus");
    expect(cls).not.toContain("focus-visible:ring");
  });

  it("fills a tile, because a hairline stops describing a card-sized target", () => {
    const tile = render(() => <Button variant="tile">Open dashboard</Button>);
    const tileClass = tile.getByRole("button").className;
    expect(tileClass).toContain("bg-ui-surface/30");
    // Full ink, not the muted label ink: a tile's interior is composed content.
    expect(tileClass).toMatch(/base:text-ui-ink(?![\w-])/);
    tile.unmount();

    const quiet = render(() => <Button variant="quiet">Open dashboard</Button>);
    expect(quiet.getByRole("button").className).not.toContain("bg-ui-surface/30");
  });

  it("gives a tile room for a layout rather than for a label", () => {
    // `px-4 py-2` around a marker and two lines of text reads as a paragraph
    // squeezed into a button.
    const { getByRole } = render(() => (
      <Button variant="tile" size="lg">
        Open dashboard
      </Button>
    ));
    const cls = getByRole("button").className;
    expect(cls).toContain("base:p-6");
    expect(cls).not.toMatch(/base:px-6|base:py-3\.5/);
  });

  it("sizes a swatch from its picture, not from type it does not have", () => {
    const { getByRole } = render(() => (
      <Button variant="choice" size="swatch" aria-label="Second picture">
        <img src="/x.png" alt="" width={80} height={80} />
      </Button>
    ));
    const cls = getByRole("button").className;
    expect(cls).toContain("base:p-1");
    // The size contributes no type at all — there is no type to size.
    expect(cls).not.toMatch(/base:text-ui-(xs|sm|base|md|lg)\b/);
    expect(cls).not.toContain("base:uppercase");
  });
});

describe("Card", () => {
  it("renders its children in a plain box", () => {
    const { getByText } = render(() => (
      <Card>
        <CardEyebrow>Guests</CardEyebrow>
      </Card>
    ));
    expect(getByText("Guests")).toBeInTheDocument();
  });

  it("marks the accented card out from the ordinary one", () => {
    expect(cardClass({ tone: "accent" })).not.toBe(cardClass());
  });

  it("adds nothing for a card that is not a control", () => {
    // The hover treatment is a promise that the whole rectangle is clickable.
    expect(cardClass()).not.toContain("hover:");
    expect(cardClass({ interactive: true })).toContain("hover:");
  });
});

describe("UsernameInput", () => {
  it("shows a fixed @ ahead of the box", () => {
    const { getByText } = render(() => <UsernameInput aria-label="OSN handle" />);
    expect(getByText("@")).toBeInTheDocument();
  });

  it("names the control by the label alone — the @ isn't part of it", () => {
    const { getByRole } = render(() => <UsernameInput aria-label="OSN handle" />);
    expect(getByRole("textbox")).toHaveAccessibleName("OSN handle");
  });

  it("wires up Field the same as a plain Input", () => {
    // The combobox use in HostsPanel spreads Field's {...field} (id,
    // aria-describedby, aria-invalid) onto this component — same contract
    // Field already proves for Input above.
    const { getByRole } = render(() => (
      <Field label="OSN handle" errors={["No account with that handle."]}>
        {(field) => <UsernameInput {...field} />}
      </Field>
    ));
    const input = getByRole("textbox");
    expect(input).toHaveAccessibleName("OSN handle");
    expect(input).toHaveAttribute("aria-invalid", "true");
  });

  it("passes everything else through to the input", () => {
    const { getByRole } = render(() => (
      <UsernameInput aria-label="OSN handle" placeholder="alice" disabled />
    ));
    const input = getByRole("textbox");
    expect(input).toHaveAttribute("placeholder", "alice");
    expect(input).toBeDisabled();
  });
});

describe("Loading", () => {
  it("announces itself without interrupting", () => {
    render(() => <Loading label="Loading enquiries…" />);
    const el = screen.getByRole("status");
    expect(el).toHaveTextContent("Loading enquiries…");
    // `status`, not `alert`: something starting to load is not urgent.
    expect(el).not.toHaveAttribute("role", "alert");
  });
});
