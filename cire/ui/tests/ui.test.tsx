import { Field } from "@shared/ui/ui/field";
import "@testing-library/jest-dom/vitest";
// @vitest-environment happy-dom
import { cleanup, render, screen } from "@solidjs/testing-library";
import type { JSX } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";

import Button, {
  type ButtonVariant,
  buttonClass,
  type ProseLinkTone,
  proseLinkClass,
} from "../src/button";
import Card, {
  CardCta,
  type CardFill,
  type CardPadding,
  type CardTone,
  cardBoxClass,
  cardClass,
} from "../src/card";
import Loading from "../src/loading";
import { UsernameInput } from "../src/username-input";

/**
 * These are class-mapping components, and a test that asserts the classes is a
 * test that has to be edited every time the design moves — it pins the current
 * answer, not the contract. So what is checked here is what a call site can
 * rely on: that the variants differ from each other, that props reach the DOM,
 * and that the accessibility wiring is there.
 *
 * A test reads a class only where the class is the contract:
 *
 * - **The corner.** Each component carries exactly one `base:`-prefixed corner,
 *   from the role the design spec gives it, so an app sets that role once and a
 *   caller's plain `rounded-*` still wins.
 * - **One of each step.** A card carries exactly one padding and one border
 *   colour. Two classes for one property tie at zero specificity, and the
 *   stylesheet's order would choose between them.
 * - **Timing.** A transition names only what its hover changes, on the app's
 *   `--dur-*` token, so the focus ring lands at once and the ladder follows the
 *   input.
 * - **The card with no options.** Every card drawn before the steps existed
 *   calls it, so its string is pinned: a change to it moves every one of them.
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

/**
 * The link inside a sentence. Its browser tier (`prose-link.browser.test.tsx`)
 * proves the painted result; these read the classes where the class is the
 * contract, which is also what lets mutation testing see them, since Stryker
 * runs this project alone.
 */
describe("proseLinkClass", () => {
  const TONES = ["accent", "muted"] as const satisfies readonly ProseLinkTone[];
  const classes = (tone?: ProseLinkTone) => proseLinkClass(tone ? { tone } : {}).split(/\s+/);

  it("stays inline and lets its sentence wrap it", () => {
    // Every `buttonClass` starts `inline-flex … whitespace-nowrap`, which holds
    // a long link to one line. A link in running text must break with it.
    const wrong = TONES.filter((tone) =>
      classes(tone).some((c) => /inline-flex|whitespace-nowrap|^base:flex$/.test(c)),
    );
    expect(wrong).toEqual([]);
  });

  it("is underlined at rest at a 2px offset, in every tone", () => {
    for (const tone of TONES) {
      expect(classes(tone)).toEqual(
        expect.arrayContaining(["base:underline", "base:underline-offset-2"]),
      );
      expect(classes(tone).some((c) => c.includes("hover:underline"))).toBe(false);
    }
  });

  it("brings no type size and no weight of its own", () => {
    const wrong = TONES.filter((tone) =>
      classes(tone).some((c) => /text-ui-(xs|sm|base|md|lg|xl)|font-/.test(c)),
    );
    expect(wrong).toEqual([]);
  });

  it("takes one corner, the control role, which only its focus ring shows", () => {
    for (const tone of TONES) {
      expect(corners(proseLinkClass({ tone }))).toEqual(["base:rounded-ui-control"]);
    }
  });

  it("fades only its colours, on the app's motion token, never the ring", () => {
    for (const tone of TONES) {
      const cls = classes(tone);
      expect(cls).toEqual(
        expect.arrayContaining([
          "base:transition-[color,text-decoration-color]",
          "base:duration-(--dur-fast,100ms)",
          "base:ease-out",
        ]),
      );
      expect(cls.filter((c) => c.includes("transition"))).toHaveLength(1);
    }
  });

  it("draws its own focus ring from the contract's focus token", () => {
    // `@cire/landing` declares no blanket `:focus-visible` rule.
    for (const tone of TONES) {
      expect(classes(tone)).toEqual(
        expect.arrayContaining([
          "base:focus-visible:outline-2",
          "base:focus-visible:outline-offset-2",
          "base:focus-visible:outline-ui-focus",
        ]),
      );
    }
  });

  it("paints accent in readable gold, and muted in the secondary ink that brightens on hover", () => {
    expect(classes("accent")).toContain("base:text-ui-accent-ink");
    expect(classes("accent").some((c) => c.includes("hover:text-"))).toBe(false);
    expect(classes("muted")).toEqual(
      expect.arrayContaining(["base:text-ui-ink-secondary", "base:hover:text-ui-ink"]),
    );
    expect(classes("muted")).not.toContain("base:text-ui-accent-ink");
  });

  it("is the accent tone when no tone is named", () => {
    expect(proseLinkClass()).toBe(proseLinkClass({ tone: "accent" }));
  });
});

const EVERY_PADDING = Object.keys({
  sm: true,
  md: true,
  lg: true,
  xl: true,
} satisfies Record<CardPadding, true>) as CardPadding[];

const EVERY_FILL = Object.keys({
  wash: true,
  well: true,
  opaque: true,
  none: true,
} satisfies Record<CardFill, true>) as CardFill[];

const EVERY_TONE = Object.keys({
  default: true,
  accent: true,
  danger: true,
} satisfies Record<CardTone, true>) as CardTone[];

/** Every card `cardClass` can draw: each padding × fill × tone, plus the interactive ones. */
function everyCard(): string[] {
  const cards: string[] = [];
  for (const padding of EVERY_PADDING) {
    for (const fill of EVERY_FILL) {
      for (const tone of EVERY_TONE) cards.push(cardClass({ padding, fill, tone }));
    }
    for (const tone of ["default", "accent"] as const) {
      cards.push(cardClass({ padding, tone, interactive: true }));
    }
  }
  return cards;
}

/** Every class in the string that sets a padding. */
function paddings(cls: string): string[] {
  return cls.split(/\s+/).filter((c) => /^base:p[xytrbl]?-/.test(c));
}

/** Every class in the string that colours the border at rest. */
function borderColours(cls: string): string[] {
  return cls.split(/\s+/).filter((c) => c.startsWith("base:border-ui-"));
}

describe("Card", () => {
  it("a card takes the large corner", () => {
    const wrong = everyCard().filter((cls) => {
      const found = corners(cls);
      return found.length !== 1 || found[0] !== "base:rounded-ui-lg";
    });
    expect(wrong).toEqual([]);
  });

  it("a card with no options is the card every existing call site draws", () => {
    // Pinned on purpose: the cards on the host's Overview, the vendor's inbox
    // and the rest call `cardClass()` or `<Card>` with no options, and adding
    // the steps must not move one of them.
    expect(cardClass()).toBe(
      "base:flex base:flex-col base:gap-3 base:rounded-ui-lg base:border base:p-5 " +
        "base:border-ui-hairline base:bg-ui-surface/30",
    );
    expect(cardClass({ padding: "md", fill: "wash", tone: "default" })).toBe(cardClass());
  });

  it("each padding step is its own, and every card has exactly one", () => {
    // One padding class, so a step never ties with a second one at zero
    // specificity and leaves the stylesheet's order to choose.
    expect(new Set(EVERY_PADDING.map((padding) => cardClass({ padding }))).size).toBe(4);
    expect(EVERY_PADDING.filter((padding) => cardClass({ padding }) === cardClass())).toEqual([
      "md",
    ]);
    expect(everyCard().filter((cls) => paddings(cls).length !== 1)).toEqual([]);
  });

  it("each fill is its own", () => {
    expect(new Set(EVERY_FILL.map((fill) => cardClass({ fill }))).size).toBe(4);
    expect(EVERY_FILL.filter((fill) => cardClass({ fill }) === cardClass())).toEqual(["wash"]);
  });

  it("a card with no fill is the ordinary card without its ground", () => {
    // `none` is for a card set on something that already has a ground — a row
    // in a list, a box inside a panel. It keeps the border, corner and padding.
    expect(cardClass({ fill: "none" }).split(" ")).toEqual(
      cardClass()
        .split(" ")
        .filter((c) => !c.includes("bg-")),
    );
  });

  it("each tone is its own, and every card has exactly one border colour", () => {
    expect(new Set(EVERY_TONE.map((tone) => cardClass({ tone }))).size).toBe(3);
    expect(everyCard().filter((cls) => borderColours(cls).length !== 1)).toEqual([]);
  });

  it("adds nothing for a card that is not a control", () => {
    // The hover treatment is a promise that the whole rectangle is clickable.
    expect(cardClass()).not.toContain("hover:");
    expect(cardClass({ interactive: true })).toContain("hover:");
  });

  it("refuses a hover on a card whose fill or tone has none", () => {
    // The interactive hover lifts the wash and turns the border gold: no other
    // fill has a lifted step, and a danger card is never the control itself.
    // These lines are checked by the type-check, not by this run.
    expect(cardClass({ fill: "wash", tone: "accent", interactive: true })).toContain("hover:");
    // @ts-expect-error — no hover for the well fill
    cardClass({ fill: "well", interactive: true });
    // @ts-expect-error — no hover for the opaque fill
    cardClass({ fill: "opaque", interactive: true });
    // @ts-expect-error — no hover for a card with no fill
    cardClass({ fill: "none", interactive: true });
    // @ts-expect-error — a danger card is never the control
    cardClass({ tone: "danger", interactive: true });
    // A flag decided at run time is held to the same pairs.
    const washed = (clickable: boolean) => cardClass({ fill: "wash", interactive: clickable });
    expect(washed(true)).toContain("hover:");
    expect(washed(false)).not.toContain("hover:");
    const opaque = (clickable: boolean) =>
      // @ts-expect-error — no hover for the opaque fill, however the flag is written
      cardClass({ fill: "opaque", interactive: clickable });
    expect(opaque).toBeTypeOf("function");
  });

  it("keeps the hover off `Card`, which is a `<div>`", () => {
    // A `<div>` with the interactive hover promises a click nothing answers; a
    // card that is the control is a `<button>` or `<a>` wearing `cardClass`.
    // The line below is checked by the type-check, not by this run.
    const { container } = render(() => (
      // @ts-expect-error — `Card` takes no `interactive`
      <Card interactive>x</Card>
    ));
    expect((container.firstElementChild as HTMLElement).className).toBe(cardClass());
  });
});

describe("cardBoxClass", () => {
  /** Every box it can draw: each fill × tone. */
  function everyBox(): { fill: CardFill; tone: CardTone; cls: string }[] {
    return EVERY_FILL.flatMap((fill) =>
      EVERY_TONE.map((tone) => ({ fill, tone, cls: cardBoxClass({ fill, tone }) })),
    );
  }

  it("is a card's box: the large corner, one border colour and the card's own fill", () => {
    // A disclosure pads its summary and body itself, so it takes the box alone.
    const wrong = everyBox().filter(({ fill, tone, cls }) => {
      const ground = (c: string) => c.split(/\s+/).filter((x) => x.includes("bg-"));
      return (
        corners(cls).join() !== "base:rounded-ui-lg" ||
        !cls.split(/\s+/).includes("base:border") ||
        borderColours(cls).join() !== borderColours(cardClass({ tone })).join() ||
        ground(cls).join() !== ground(cardClass({ fill })).join()
      );
    });
    expect(wrong).toEqual([]);
  });

  it("brings no padding and no layout of its own", () => {
    const leaks = everyBox().filter(
      ({ cls }) => paddings(cls).length > 0 || /(^|:)(flex|gap-)/.test(cls.replace(/\s+/g, " ")),
    );
    expect(leaks).toEqual([]);
  });

  it("takes the small corner when nested, and changes nothing else", () => {
    // A bordered box set inside a card, a modal or a frame.
    const wrong = everyBox().filter(({ fill, tone, cls }) => {
      const nested = cardBoxClass({ fill, tone, nested: true });
      return (
        corners(nested).join() !== "base:rounded-ui-sm" ||
        nested.replace("base:rounded-ui-sm", "base:rounded-ui-lg") !== cls
      );
    });
    expect(wrong).toEqual([]);
  });

  it("with no options is the ordinary card's box", () => {
    expect(cardBoxClass()).toBe(cardBoxClass({ fill: "wash", tone: "default" }));
  });
});

describe("Card — the component", () => {
  it("draws the same card `cardClass` does, for every option it takes", () => {
    // A prop the component forgets to pass on draws the default card instead.
    const wrong: string[] = [];
    const check = (name: string, card: () => JSX.Element, expected: string) => {
      const { container, unmount } = render(card);
      if ((container.firstElementChild as HTMLElement).className !== expected) wrong.push(name);
      unmount();
    };
    for (const padding of EVERY_PADDING) {
      check(`padding ${padding}`, () => <Card padding={padding}>x</Card>, cardClass({ padding }));
    }
    for (const fill of EVERY_FILL) {
      check(`fill ${fill}`, () => <Card fill={fill}>x</Card>, cardClass({ fill }));
    }
    for (const tone of EVERY_TONE) {
      check(`tone ${tone}`, () => <Card tone={tone}>x</Card>, cardClass({ tone }));
    }
    expect(wrong).toEqual([]);
  });

  it("keeps the caller's own classes after its own", () => {
    const { container } = render(() => (
      <Card padding="lg" class="gap-6">
        x
      </Card>
    ));
    expect((container.firstElementChild as HTMLElement).className).toBe(
      `${cardClass({ padding: "lg" })} gap-6`,
    );
  });
});

/** The classes that time a transition, for every element in a rendered tree. */
function timings(root: Element): string[][] {
  return [root, ...root.querySelectorAll("*")].map((el) =>
    [...el.classList].filter((c) => c.includes("transition") || c.includes("duration-")),
  );
}

describe("Card — motion", () => {
  it("an interactive card fades only what its hover changes, on the app's token", () => {
    // An interactive card is drawn on a `<button>`, and Tailwind's
    // `transition-colors` would fade its focus ring in along with the hover.
    for (const tone of ["default", "accent"] as const) {
      const cls = cardClass({ tone, interactive: true }).split(/\s+/);
      expect(cls.filter((c) => c.includes("transition") || c.includes("duration-"))).toEqual([
        "base:transition-[color,background-color,border-color,text-decoration-color]",
        "base:duration-(--dur-fast,100ms)",
      ]);
    }
  });

  it("the card's call to action takes its durations from the app's tokens", () => {
    // The label's colour is a hover; the arrow's nudge is a short slide.
    const { container } = render(() => <CardCta>Open guests</CardCta>);
    const timed = timings(container.firstElementChild as Element).filter((t) => t.length > 0);
    expect(timed).toEqual([
      [
        "base:transition-[color,background-color,border-color,text-decoration-color]",
        "base:duration-(--dur-fast,100ms)",
      ],
      ["base:transition-transform", "base:duration-(--dur-base,200ms)"],
    ]);
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
