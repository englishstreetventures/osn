/**
 * `Button` in the portals' one pill language (the 2026-11-04 consistency
 * audit, items 1, 3, 4, 7 and 10), measured in Chromium against cire's two
 * ramps.
 *
 * The portals set two app tokens the guest site and the marketing site leave
 * unset: `--pill-sm-height`, the small pill's height, and `--pill-ground`, the
 * ground a non-primary pill sits on. Each case is one way a host would see the
 * language break: a small pill off the 28px of the tracks and filters beside
 * it; a guest's small button shrunk with it; a button beside a 34px field off
 * its height, or off it under a tall line; an icon button that is not the
 * bar's 28px; a pill with no ground beside the grounded track, or a guest's
 * pill given one; a chosen `glass` pill that is not the strip's glass, whose
 * word falls under 4.5:1, that shifts its row, that builds its content
 * twice, or that a contrast theme leaves unmarked; a halfway hover that is not the strip's; an open `quiet`
 * button that looks closed; or a change that runs on the wrong clock.
 */

import { cleanup, render, screen } from "@solidjs/testing-library";
import type { JSX } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";
import { commands, page as browserPage, userEvent } from "vitest/browser";

import Button, { type ButtonVariant } from "../src/button";
import { GLASS_FILL } from "../src/lib/glass";
import { composite, painted, ratio } from "./test-support/paint";

import "./test-support/tailwind.css";

const RAMPS = ["dark", "light"] as const;
type Ramp = (typeof RAMPS)[number];

type MediaPreference = { forcedColors?: "active" | "none" };
const emulateMedia = (options: MediaPreference) =>
  (commands as unknown as { emulateMedia: (o: MediaPreference) => Promise<void> }).emulateMedia(
    options,
  );

afterEach(async () => {
  await emulateMedia({ forcedColors: "none" });
  cleanup();
});

/** The two tokens as the portals set them (`cire/host/src/styles/global.css`). */
const PORTAL = {
  "--pill-ground": "color-mix(in oklab, var(--ui-surface) 30%, transparent)",
  "--pill-sm-height": "1.75rem",
} as JSX.CSSProperties;

function Ground(props: {
  ramp?: Ramp;
  portal?: boolean;
  style?: JSX.CSSProperties;
  children: JSX.Element;
}) {
  return (
    <div
      data-ramp={props.ramp === "light" ? "light" : undefined}
      class="bg-ui-ground flex items-start gap-2 p-4"
      style={{ ...(props.portal === false ? {} : PORTAL), ...props.style }}
    >
      {props.children}
    </div>
  );
}

const height = (el: Element) => el.getBoundingClientRect().height;
const token = (el: Element, name: string) => getComputedStyle(el).getPropertyValue(name).trim();
const settle = (ms = 400) => new Promise((resolve) => setTimeout(resolve, ms));

/** A colour as painted over the page ground beneath `el`. */
function onPage(el: Element, color: string): [number, number, number] {
  return composite([getComputedStyle(el.parentElement!).backgroundColor, color]);
}

describe("the heights", () => {
  it("draws a small pill at 28px in the portals, whatever the variant", () => {
    render(() => (
      <Ground>
        <Button variant="outline" size="sm">
          Download events
        </Button>
        <Button variant="quiet" size="sm">
          Record
        </Button>
        <Button variant="primary" size="sm">
          Save
        </Button>
        <Button variant="danger" size="sm">
          Delete
        </Button>
      </Ground>
    ));
    expect(screen.getAllByRole("button").map(height)).toEqual([28, 28, 28, 28]);
  });

  it("leaves a small button its own padded height where no portal sets one", () => {
    render(() => (
      <Ground portal={false}>
        <Button variant="cta" size="sm">
          Accept all
        </Button>
      </Ground>
    ));
    expect(height(screen.getByRole("button"))).toBeGreaterThan(29);
  });

  it("draws a button beside a form field at 34px, under a 2em line as well", () => {
    for (const line of ["normal", "2em"]) {
      render(() => (
        <Ground style={{ "line-height": line }}>
          <Button variant="primary" size="form">
            Add item
          </Button>
          <Button variant="quiet" size="form">
            Cancel
          </Button>
          <Button variant="field" size="form">
            Vegetarian
          </Button>
        </Ground>
      ));
      expect(screen.getAllByRole("button").map(height)).toEqual([34, 34, 34]);
      cleanup();
    }
  });

  it("gives a form-height action md's type, and a field its own", () => {
    render(() => (
      <Ground>
        <Button variant="quiet" size="form">
          Add item
        </Button>
        <Button variant="quiet" size="md">
          Add item
        </Button>
        <Button variant="field" size="form">
          Vegetarian
        </Button>
        <Button variant="field" size="md">
          Vegetarian
        </Button>
      </Ground>
    ));
    const [form, md, field, fieldMd] = screen
      .getAllByRole("button")
      .map((b) => getComputedStyle(b));
    expect([form!.fontSize, form!.fontWeight, form!.paddingLeft]).toEqual([
      md!.fontSize,
      md!.fontWeight,
      md!.paddingLeft,
    ]);
    expect([field!.fontSize, field!.fontWeight, field!.paddingLeft]).toEqual([
      fieldMd!.fontSize,
      fieldMd!.fontWeight,
      fieldMd!.paddingLeft,
    ]);
  });

  it("holds every sizing table to the form height and the icon square", () => {
    render(() => (
      <Ground>
        <Button variant="tile" size="form">
          Tile
        </Button>
        <Button variant="tile" size="md">
          Tile md
        </Button>
        <Button variant="round" size="form" aria-label="Round">
          ×
        </Button>
        <Button variant="tile" size="icon" aria-label="Tile icon">
          +
        </Button>
        <Button variant="field" size="icon" aria-label="Field icon">
          +
        </Button>
        <Button variant="link" size="form">
          Link
        </Button>
        <Button variant="link" size="md">
          Link md
        </Button>
      </Ground>
    ));
    const box = (name: string) => {
      const r = screen.getByRole("button", { name }).getBoundingClientRect();
      return [r.width, r.height];
    };
    expect(box("Tile")[1]).toBe(34);
    const tile = getComputedStyle(screen.getByRole("button", { name: "Tile" }));
    const tileMd = getComputedStyle(screen.getByRole("button", { name: "Tile md" }));
    expect([tile.fontSize, tile.paddingLeft]).toEqual([tileMd.fontSize, tileMd.paddingLeft]);
    expect(box("Round")).toEqual([34, 34]);
    expect(box("Tile icon")).toEqual([28, 28]);
    expect(box("Field icon")).toEqual([28, 28]);
    const type = (name: string) => getComputedStyle(screen.getByRole("button", { name })).fontSize;
    expect(type("Link")).toBe(type("Link md"));
  });

  it("draws an icon button as a 28px circle", () => {
    render(() => (
      <Ground>
        <Button variant="quiet" size="icon" aria-label="Allow everyone">
          +
        </Button>
        <Button variant="outline" size="icon" aria-label="Download">
          ↓
        </Button>
      </Ground>
    ));
    for (const button of screen.getAllByRole("button")) {
      const box = button.getBoundingClientRect();
      expect([box.width, box.height]).toEqual([28, 28]);
    }
  });
});

describe("the ground", () => {
  const GROUNDED: ButtonVariant[] = [
    "cta",
    "outline",
    "quiet",
    "quietDanger",
    "dashed",
    "danger",
    "choice",
    "glass",
  ];

  for (const ramp of RAMPS) {
    it(`sits every non-primary pill on the track's ground in the portals, ${ramp}`, () => {
      render(() => (
        <Ground ramp={ramp}>
          {GROUNDED.map((variant) => (
            <Button variant={variant}>{variant}</Button>
          ))}
          <Button variant="primary">primary</Button>
        </Ground>
      ));
      const page = screen.getByRole("button", { name: "primary" }).parentElement!;
      const track = `color-mix(in oklab, ${token(page, "--ui-surface")} 30%, transparent)`;
      for (const variant of GROUNDED) {
        const button = screen.getByRole("button", { name: variant });
        expect([variant, onPage(button, getComputedStyle(button).backgroundColor)]).toEqual([
          variant,
          onPage(button, track),
        ]);
      }
      const primary = screen.getByRole("button", { name: "primary" });
      expect(painted(getComputedStyle(primary).backgroundColor)).toBe(
        painted(token(primary, "--ui-accent")),
      );
    });
  }

  it("leaves a guest's pills clear where no portal sets a ground", () => {
    render(() => (
      <Ground portal={false}>
        {(["cta", "outline", "quiet", "danger", "choice"] as const).map((variant) => (
          <Button variant={variant}>{variant}</Button>
        ))}
      </Ground>
    ));
    for (const button of screen.getAllByRole("button")) {
      expect(getComputedStyle(button).backgroundColor).toBe("rgba(0, 0, 0, 0)");
    }
  });
});

describe("glass, one of several", () => {
  /** The strip's own glass, painted on a probe, for "the same glass". */
  function stripGlass(ramp: Ramp): string {
    const probe = document.createElement("span");
    probe.className = GLASS_FILL;
    const host = document.querySelector(`[data-probe-${ramp}]`)!;
    host.append(probe);
    const color = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return color;
  }

  function Pair(props: { ramp: Ramp; chosen?: "Desktop" | "Phone" }) {
    return (
      <Ground ramp={props.ramp}>
        <span data-probe-dark={props.ramp === "dark" ? "" : undefined} />
        <span data-probe-light={props.ramp === "light" ? "" : undefined} />
        <fieldset class="m-0 flex gap-1.5 border-0 p-0">
          <legend class="sr-only">Preview device</legend>
          <Button variant="glass" size="sm" aria-pressed={props.chosen === "Desktop"}>
            Desktop
          </Button>
          <Button variant="glass" size="sm" aria-pressed={props.chosen === "Phone"}>
            Phone
          </Button>
        </fieldset>
      </Ground>
    );
  }

  for (const ramp of RAMPS) {
    it(`wears the strip's glass and readable gold when chosen, at 4.5:1, ${ramp}`, async () => {
      render(() => <Pair ramp={ramp} chosen="Desktop" />);
      await settle();
      const chosen = screen.getByRole("button", { name: "Desktop" });
      const style = getComputedStyle(chosen);
      expect(painted(style.backgroundColor)).toBe(painted(stripGlass(ramp)));
      expect(style.borderTopColor).toBe("rgba(0, 0, 0, 0)");
      expect(style.backdropFilter).not.toBe("none");
      expect(painted(style.color)).toBe(painted(token(chosen, "--ui-accent-ink")));
      // The cue that is not colour, as a strip's chosen word carries it: the
      // chosen word at medium weight, the rest at normal.
      const weight = (button: HTMLElement) =>
        getComputedStyle(button.querySelector("[data-glass-word]")!).fontWeight;
      expect(weight(chosen)).toBe("500");
      expect(weight(screen.getByRole("button", { name: "Phone" }))).toBe("400");
      const page = getComputedStyle(chosen.closest("[class*='bg-ui-ground']")!).backgroundColor;
      const under = composite([page, style.backgroundColor]);
      const word = composite([page, style.backgroundColor, style.color]);
      expect(ratio(word, under)).toBeGreaterThanOrEqual(4.5);
    });

    it(`rests on the track's look and goes halfway under the pointer, ${ramp}`, async () => {
      render(() => <Pair ramp={ramp} chosen="Desktop" />);
      // The pointer starts on the chosen pill, so the idle one is at rest.
      await userEvent.hover(screen.getByRole("button", { name: "Desktop" }));
      await settle();
      const idle = screen.getByRole("button", { name: "Phone" });
      const rest = getComputedStyle(idle);
      expect(painted(rest.borderTopColor)).toBe(painted(token(idle, "--ui-hairline")));
      expect(painted(rest.color)).toBe(painted(token(idle, "--ui-ink-secondary")));
      const restColor = rest.color;
      await userEvent.hover(idle);
      await settle();
      const hovered = getComputedStyle(idle);
      const half = `color-mix(in srgb, color-mix(in srgb, ${token(idle, "--ui-accent")} 21.5%, ${token(idle, "--ui-surface-raised")}) 32.6%, transparent)`;
      expect(painted(hovered.backgroundColor)).toBe(painted(half));
      expect(hovered.color).not.toBe(restColor);
      const page = getComputedStyle(idle.closest("[class*='bg-ui-ground']")!).backgroundColor;
      expect(
        ratio(
          composite([page, hovered.backgroundColor, hovered.color]),
          composite([page, hovered.backgroundColor]),
        ),
      ).toBeGreaterThanOrEqual(4.5);
    });
  }

  it("moves nothing in its row when the choice and its weight move, and names each by its word once", async () => {
    render(() => <Pair ramp="dark" chosen="Desktop" />);
    const widths = () => screen.getAllByRole("button").map((b) => b.getBoundingClientRect().width);
    const before = widths();
    cleanup();
    render(() => <Pair ramp="dark" chosen="Phone" />);
    expect(widths()).toEqual(before);
    // The room held for the medium weight is drawn, never named or found as
    // text: the browser's own accessibility tree, which reads generated
    // content, names each pill by its word once.
    expect(browserPage.getByRole("button", { name: "Phone", exact: true }).elements()).toHaveLength(
      1,
    );
    expect(
      browserPage.getByRole("button", { name: "Desktop", exact: true }).elements(),
    ).toHaveLength(1);
    expect(screen.getAllByText("Phone")).toHaveLength(1);
    // And the room sits under the word, not beside it: the word's box is its
    // own width at the wider weight, not twice it.
    const word = screen.getByText("Phone");
    const range = document.createRange();
    range.selectNodeContents(word.firstChild!);
    expect(word.getBoundingClientRect().width).toBeLessThan(
      range.getBoundingClientRect().width * 1.15,
    );
  });

  it("lets content that is more than a word name itself, unwrapped", () => {
    render(() => (
      <Ground>
        <Button variant="glass" aria-pressed="false">
          <span>Wide</span>
        </Button>
      </Ground>
    ));
    const pill = browserPage.getByRole("button", { name: "Wide", exact: true });
    expect(pill.elements()).toHaveLength(1);
    expect(pill.element().querySelector("[data-glass-word]")).toBeNull();
  });

  it("builds content that is more than a word once", () => {
    let built = 0;
    const Swatch = () => {
      built += 1;
      return <span>Wide</span>;
    };
    render(() => (
      <Ground>
        <Button variant="glass" aria-pressed="false">
          <Swatch />
        </Button>
      </Ground>
    ));
    expect(built).toBe(1);
    expect(browserPage.getByRole("button", { name: "Wide", exact: true }).elements()).toHaveLength(
      1,
    );
  });

  it("marks a chosen radio as it marks a pressed button", async () => {
    render(() => (
      <Ground>
        <span role="radiogroup" aria-label="Shape">
          {/* oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- a radio pill is a `Button` with the radio role, as a portal's is. */}
          <Button variant="glass" role="radio" aria-checked="true">
            Square
          </Button>
          {/* oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- as above. */}
          <Button variant="glass" role="radio" aria-checked="false">
            Wide
          </Button>
        </span>
      </Ground>
    ));
    await settle();
    const [chosen, idle] = screen.getAllByRole("radio");
    expect(getComputedStyle(chosen!).backdropFilter).not.toBe("none");
    expect(getComputedStyle(idle!).backdropFilter).toBe("none");
  });

  it("keeps an outline on the chosen pill in a contrast theme", async () => {
    await emulateMedia({ forcedColors: "active" });
    render(() => <Pair ramp="dark" chosen="Phone" />);
    const chosen = getComputedStyle(screen.getByRole("button", { name: "Phone" }));
    expect([chosen.outlineStyle, chosen.outlineWidth, chosen.outlineOffset]).toEqual([
      "solid",
      "1px",
      "0px",
    ]);
    expect(getComputedStyle(screen.getByRole("button", { name: "Desktop" })).outlineStyle).toBe(
      "none",
    );
  });
});

describe("an open quiet button", () => {
  it("holds its hover look while what it opens is open", () => {
    render(() => (
      <Ground>
        <Button variant="quiet" size="icon" aria-label="What the reply icons mean" aria-expanded>
          i
        </Button>
        <Button variant="quiet" size="icon" aria-label="Closed" aria-expanded={false}>
          i
        </Button>
      </Ground>
    ));
    const open = screen.getByRole("button", { name: "What the reply icons mean" });
    const closed = screen.getByRole("button", { name: "Closed" });
    expect(painted(getComputedStyle(open).borderTopColor)).toBe(
      painted(token(open, "--ui-accent")),
    );
    expect(painted(getComputedStyle(open).color)).toBe(painted(token(open, "--ui-accent-ink")));
    expect(painted(getComputedStyle(closed).borderTopColor)).toBe(
      painted(token(closed, "--ui-hairline")),
    );
  });
});

describe("the clock each change runs on", () => {
  const LADDER = {
    "--dur-fast": "70ms",
    "--dur-base": "170ms",
    "--ease-out": "cubic-bezier(0.1, 0.9, 0.2, 1)",
    "--ease-in-out": "cubic-bezier(0.6, 0, 0.4, 1)",
  } as JSX.CSSProperties;
  const clock = (el: Element) => {
    const style = getComputedStyle(el);
    return [style.transitionDuration, style.transitionTimingFunction];
  };

  for (const variant of ["choice", "glass"] as const) {
    it(`moves a ${variant}'s hover on the fast step and its choosing on the base step`, () => {
      render(() => (
        <Ground style={LADDER}>
          <Button variant={variant} aria-pressed="false">
            Idle
          </Button>
          <Button variant={variant} aria-pressed="true">
            Chosen
          </Button>
          {/* oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- a radio pill is a `Button` with the radio role, as a portal's is. */}
          <Button variant={variant} role="radio" aria-checked="true">
            Checked
          </Button>
        </Ground>
      ));
      expect(clock(screen.getByRole("button", { name: "Idle" }))).toEqual([
        "0.07s",
        "cubic-bezier(0.1, 0.9, 0.2, 1)",
      ]);
      for (const chosen of [
        screen.getByRole("button", { name: "Chosen" }),
        screen.getByRole("radio", { name: "Checked" }),
      ]) {
        expect(clock(chosen)).toEqual(["0.17s", "cubic-bezier(0.6, 0, 0.4, 1)"]);
      }
      const properties = getComputedStyle(
        screen.getByRole("button", { name: "Idle" }),
      ).transitionProperty;
      expect(properties).not.toMatch(/outline|all/);
    });
  }
});
