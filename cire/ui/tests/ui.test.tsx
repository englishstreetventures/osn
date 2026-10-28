import { Field } from "@shared/ui/ui/field";
import "@testing-library/jest-dom/vitest";
// @vitest-environment happy-dom
import { cleanup, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";

import Button, { type ButtonVariant, buttonClass } from "../src/button";
import { cardClass } from "../src/card";
import Loading from "../src/loading";
import { UsernameInput } from "../src/username-input";

/**
 * These are class-mapping components, and a test that asserts the classes is a
 * test that has to be edited every time the design moves — it pins the current
 * answer, not the contract. So what is checked here is what a call site can
 * rely on: that the variants differ from each other, that props reach the DOM,
 * and that the accessibility wiring is there. The one class a test does read is
 * the corner: each component carries exactly one `base:`-prefixed corner, from
 * the role the design spec gives it, so an app sets that role once and a
 * caller's plain `rounded-*` still wins.
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

/** Every class in the string that sets a corner. */
function corners(cls: string): string[] {
  return cls.split(/\s+/).filter((c) => c.includes("rounded-"));
}

describe("Button — corners and case", () => {
  it("every action variant takes the control role, and chip the pill step", () => {
    // One corner class, from the `control` role, so an app decides how round
    // its buttons are once in its stylesheet. A second corner class would tie
    // with the first at zero specificity and leave the stylesheet's order to
    // pick between them. `chip` takes the `pill` step instead: it sits beside a
    // round close button and stays round whatever `control` is.
    const actions: readonly { variant: ButtonVariant; corner: string }[] = [
      { variant: "primary", corner: "base:rounded-ui-control" },
      { variant: "cta", corner: "base:rounded-ui-control" },
      { variant: "outline", corner: "base:rounded-ui-control" },
      { variant: "quiet", corner: "base:rounded-ui-control" },
      { variant: "quietDanger", corner: "base:rounded-ui-control" },
      { variant: "danger", corner: "base:rounded-ui-control" },
      { variant: "choice", corner: "base:rounded-ui-control" },
      { variant: "dashed", corner: "base:rounded-ui-control" },
      { variant: "chip", corner: "base:rounded-ui-pill" },
    ];
    const wrong = actions
      .map(({ variant, corner }) => ({ variant, corner, found: corners(buttonClass({ variant })) }))
      .filter(({ corner, found }) => found.length !== 1 || found[0] !== corner);
    expect(wrong).toEqual([]);
  });

  it("tile, field and swatch take the field corner", () => {
    // A block, a value and a framed picture are not actions: a pill tile reads
    // as a lozenge, and a pill thumbnail crops its own picture.
    const cases = [
      { id: "tile", cls: buttonClass({ variant: "tile" }) },
      { id: "field", cls: buttonClass({ variant: "field" }) },
      { id: "choice/swatch", cls: buttonClass({ variant: "choice", size: "swatch" }) },
    ];
    const wrong = cases
      .map(({ id, cls }) => ({ id, found: corners(cls) }))
      .filter(({ found }) => found.length !== 1 || found[0] !== "base:rounded-ui-field");
    expect(wrong).toEqual([]);
  });

  it("labels are sentence case", () => {
    // The label is written in sentence case at the call site ("Event details")
    // and the button shows it as written: no transform and no wide tracking,
    // boxed or not. A boxed label takes a medium weight instead, which is what
    // tells it from the body text around it.
    const shouting = (["primary", "tile"] as const).flatMap((variant) =>
      (["sm", "md", "lg", "icon"] as const)
        .filter((size) => {
          const cls = buttonClass({ variant, size });
          return cls.includes("uppercase") || cls.includes("tracking-ui-wider");
        })
        .map((size) => `${variant}/${size}`),
    );
    expect(shouting).toEqual([]);

    // Tracking is set, not inherited: a button inside a tracked eyebrow would
    // otherwise spread its label to match.
    const unset = (["primary", "tile"] as const).flatMap((variant) =>
      (["sm", "md", "lg"] as const)
        .filter((size) => {
          const cls = buttonClass({ variant, size });
          return !cls.includes("base:font-medium") || !cls.includes("base:tracking-ui-normal");
        })
        .map((size) => `${variant}/${size}`),
    );
    expect(unset).toEqual([]);

    const link = render(() => <Button variant="link">View listing</Button>);
    expect(link.getByRole("button").className).not.toContain("uppercase");
  });

  it("a caller's corner still wins", () => {
    // `class` is appended with no merge step, so a caller's plain utility beats
    // the variant's only because every default corner is a zero-specificity
    // `base:` one. A plain default corner would tie with it instead.
    const { getByRole } = render(() => (
      <Button variant="chip" class="rounded-none">
        x
      </Button>
    ));
    const plain = corners(getByRole("button").className).filter(
      (c) => c !== "rounded-none" && !c.startsWith("base:"),
    );
    expect(plain).toEqual([]);
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
});

/** Every variant, as a record so a variant added to the type and not here fails to compile. */
const EVERY_VARIANT = Object.keys({
  primary: true,
  cta: true,
  outline: true,
  quiet: true,
  quietDanger: true,
  choice: true,
  tile: true,
  dashed: true,
  field: true,
  danger: true,
  chip: true,
  link: true,
  subtle: true,
  touchLink: true,
  bare: true,
  bareDanger: true,
} satisfies Record<ButtonVariant, true>) as ButtonVariant[];

describe("Button — motion", () => {
  it("fades only what a hover changes, so the focus ring shows at once", () => {
    // Tailwind's `transition-colors` includes `outline-color`, which would fade
    // the focus ring in over the hover's duration. The ring must show the
    // moment focus lands, so the transition names its properties instead.
    const wrong = EVERY_VARIANT.filter((variant) => {
      const cls = buttonClass({ variant }).split(/\s+/);
      return (
        cls.includes("base:transition-colors") ||
        !cls.includes("base:transition-[color,background-color,border-color,text-decoration-color]")
      );
    });
    expect(wrong).toEqual([]);
  });

  it("takes its hover duration from the app's motion token", () => {
    // A literal duration ignores the app's ladder, which is shorter under a
    // fine pointer. The fallback is for an app that declares no ladder.
    const wrong = EVERY_VARIANT.filter((variant) => {
      const durations = buttonClass({ variant })
        .split(/\s+/)
        .filter((c) => c.includes("duration-"));
      return durations.length !== 1 || durations[0] !== "base:duration-(--dur-fast,100ms)";
    });
    expect(wrong).toEqual([]);
  });
});

describe("Card", () => {
  it("a card takes the large corner", () => {
    const variants = [
      cardClass(),
      cardClass({ tone: "accent" }),
      cardClass({ interactive: true }),
      cardClass({ tone: "accent", interactive: true }),
    ];
    for (const cls of variants) expect(corners(cls)).toEqual(["base:rounded-ui-lg"]);
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
