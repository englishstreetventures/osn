import Disclosure from "@cire/ui/disclosure";
import { cleanup, render } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, onTestFinished } from "vitest";
import { commands } from "vitest/browser";

import "../../src/styles/global.css";

/**
 * A `<details>` body fading in as it opens, and not for a reader who asked for
 * no motion. The global reduced-motion block selects `*`, which no
 * pseudo-element matches, so it cannot reach `::details-content`: the fade is
 * gated by its own `no-preference` query, and only a real engine computes a
 * pseudo-element's animation to show which one won.
 */

const body = (el: Element) => getComputedStyle(el, "::details-content");

afterEach(async () => {
  cleanup();
  await commands.emulateMedia({ reducedMotion: "no-preference" });
});

describe("a disclosure opening", () => {
  it("fades its body in, and simply opens under reduced motion", async () => {
    const { container } = render(() => (
      <details>
        <summary>More</summary>
        <p>Inside</p>
      </details>
    ));
    const details = container.querySelector("details")!;
    details.open = true;
    expect(body(details).animationName).toBe("details-in");

    details.open = false;
    await commands.emulateMedia({ reducedMotion: "reduce" });
    details.open = true;
    expect(body(details).animationName).toBe("none");
  });
});

/**
 * `@cire/ui`'s `Disclosure`, painted by the host's own stylesheet: what its
 * unit tests can only read as class names. Until the app's `<details>` move
 * onto it, the host's `details-in` keyframe also runs on its body, so the fade
 * is read from the transition and not from the opacity.
 */
describe("the Disclosure part", () => {
  const markerOf = (details: Element) =>
    [...details.querySelector(":scope > summary")!.children].find(
      (el) => el.textContent === "›" || el.textContent === "+",
    )!;

  it("fades its body in as it opens, closes at once, and not at all under reduced motion", async () => {
    const { container } = render(() => <Disclosure summary="Change history">Inside</Disclosure>);
    const details = container.querySelector("details")!;
    expect(body(details).transitionDuration).toBe("0s");

    details.open = true;
    expect(body(details).transitionProperty).toBe("opacity, translate");
    expect(Number.parseFloat(body(details).transitionDuration)).toBeGreaterThan(0);

    details.open = false;
    expect(body(details).transitionDuration).toBe("0s");

    await commands.emulateMedia({ reducedMotion: "reduce" });
    details.open = true;
    expect(body(details).transitionProperty).toBe("all");
    expect(body(details).transitionDuration).toBe("0s");
  });

  it("turns each marker with its own disclosure, a closed one inside an open one included", () => {
    const { container } = render(() => (
      <>
        <Disclosure summary="How to structure your sheet" open>
          <Disclosure summary="Formatting tips" nested>
            Inside
          </Disclosure>
        </Disclosure>
        <Disclosure tone="rule" summary="Is there parking?" open>
          Yes.
        </Disclosure>
        <Disclosure tone="rule" summary="Can I bring a guest?">
          Ask the couple.
        </Disclosure>
      </>
    ));
    const [outer, inner, ruleOpen, ruleClosed] = container.querySelectorAll("details");
    const turn = (details: Element) => getComputedStyle(markerOf(details)).rotate;
    expect([turn(outer!), turn(inner!), turn(ruleOpen!), turn(ruleClosed!)]).toEqual([
      "90deg",
      "none",
      "45deg",
      "none",
    ]);
  });

  it("gives a nested card the small corner and one on the page the large", () => {
    const { container } = render(() => (
      <Disclosure summary="How to structure your sheet" open>
        <Disclosure summary="Formatting tips" nested>
          Inside
        </Disclosure>
      </Disclosure>
    ));
    const [outer, inner] = container.querySelectorAll("details");
    const corner = (el: Element) => getComputedStyle(el).borderTopLeftRadius;
    expect([corner(outer!), corner(inner!)]).toEqual(["16px", "6px"]);
  });

  it("times the fade and the turn on the app's own steps and easing", () => {
    // Read from the host's tokens, so a lost class, a renamed token or a
    // build that drops one fails here. The portal is slowed threefold so no
    // step can match Tailwind's own default duration by chance.
    const root = document.documentElement.style;
    root.setProperty("--motion-scale", "3");
    onTestFinished(() => {
      root.removeProperty("--motion-scale");
    });
    const probe = document.createElement("span");
    document.body.append(probe);
    onTestFinished(() => probe.remove());
    probe.style.transitionDuration = "var(--dur-fast)";
    probe.style.transitionTimingFunction = "var(--ease-out)";
    const fast = getComputedStyle(probe).transitionDuration;
    const easeOut = getComputedStyle(probe).transitionTimingFunction;
    probe.style.transitionDuration = "var(--dur-base)";
    const base = getComputedStyle(probe).transitionDuration;

    const { container } = render(() => (
      <Disclosure summary="Change history" open>
        x
      </Disclosure>
    ));
    const details = container.querySelector("details")!;
    const marker = getComputedStyle(markerOf(details));
    expect([
      marker.transitionProperty,
      marker.transitionDuration,
      marker.transitionTimingFunction,
    ]).toEqual(["rotate", fast, easeOut]);
    expect([body(details).transitionDuration, body(details).transitionTimingFunction]).toEqual([
      base,
      easeOut,
    ]);
    expect(fast).not.toBe(base);
  });

  it("wraps a long unbroken summary inside its row, the marker still in it", () => {
    // An organiser can write a word longer than the row: a venue, a link.
    const long = "Wherecanweparkifthecarparkbehindthehallisalreadyfullbysix";
    const { container } = render(() => (
      <div style={{ width: "360px" }}>
        <Disclosure summary={long}>x</Disclosure>
        <Disclosure tone="rule" summary={long}>
          x
        </Disclosure>
      </div>
    ));
    const [card, rule] = container.querySelectorAll("details");
    for (const details of [card!, rule!]) {
      const summary = details.querySelector("summary")!;
      expect(summary.scrollWidth).toBeLessThanOrEqual(summary.clientWidth);
    }
    const ruleMarker = markerOf(rule!) as HTMLElement;
    const ruleSummary = rule!.querySelector("summary")!;
    expect(ruleMarker.offsetLeft + ruleMarker.offsetWidth).toBe(
      ruleSummary.offsetLeft + ruleSummary.offsetWidth,
    );
  });

  it("paints the marker in the app's readable gold", () => {
    const { container } = render(() => (
      <>
        <Disclosure summary="Change history">x</Disclosure>
        <span style={{ color: "var(--ui-accent-ink)" }}>gold</span>
      </>
    ));
    const gold = getComputedStyle(container.querySelector("span[style]")!).color;
    expect(getComputedStyle(markerOf(container.querySelector("details")!)).color).toBe(gold);
  });

  it("makes the whole summary row the click target and sets the body under it", () => {
    // The host stylesheet also fades every open `<details>` with its own
    // `details-in` keyframe, which holds an unpainted body at its first frame;
    // switched off here so the measurements read the part alone.
    const noKeyframe = document.createElement("style");
    noKeyframe.textContent = "details::details-content { animation: none !important; }";
    document.head.append(noKeyframe);
    onTestFinished(() => noKeyframe.remove());
    const { container } = render(() => (
      <div
        style={{
          width: "360px",
          "--ui-font-body": "body-face",
          "--ui-font-display": "display-face",
        }}
      >
        <Disclosure summary="Arrange tables" open>
          <p>Drag a table to move it.</p>
          <p>Tables keep their order on the printed plan.</p>
        </Disclosure>
        <Disclosure tone="rule" summary="Is there parking?" open>
          <p>Yes, behind the hall.</p>
        </Disclosure>
      </div>
    ));
    const [card, rule] = container.querySelectorAll("details");
    for (const details of [card!, rule!]) {
      const summary = details.querySelector("summary")!.getBoundingClientRect();
      const row = details.querySelector("p")!.getBoundingClientRect();
      const box = details.getBoundingClientRect();
      // The row spans the box inside its border, so a tap anywhere along it opens it.
      expect(Math.round(summary.width)).toBe(details.clientWidth);
      // The row is a comfortable tap target on a phone.
      expect(summary.height).toBeGreaterThanOrEqual(44);
      // The body keeps clear of the box's bottom edge.
      const last = details.querySelector("p:last-of-type")!.getBoundingClientRect();
      expect(box.bottom - last.bottom).toBeGreaterThanOrEqual(8);
      expect(row.top).toBeGreaterThanOrEqual(summary.bottom);
    }
    // Rows in a card's body stand apart.
    const [first, second] = card!.querySelectorAll("p");
    expect(
      second!.getBoundingClientRect().top - first!.getBoundingClientRect().bottom,
    ).toBeGreaterThanOrEqual(8);
    // A card's summary is in the body face, an FAQ question in the display face.
    // The wrapper names the two faces, since the test page loads neither.
    const face = (details: Element) =>
      getComputedStyle(details.querySelector("summary")!).fontFamily;
    expect([face(card!), face(rule!)]).toEqual(["body-face", "display-face"]);
    // A card's body starts where its summary's contents do, inset from the border.
    const cardSummary = card!.querySelector("summary")!;
    const contentLeft =
      cardSummary.getBoundingClientRect().left +
      Number.parseFloat(getComputedStyle(cardSummary).paddingLeft);
    expect(Math.round(card!.querySelector("p")!.getBoundingClientRect().left)).toBe(
      Math.round(contentLeft),
    );
    expect(contentLeft - card!.getBoundingClientRect().left).toBeGreaterThanOrEqual(8);
    // A rule's marker ends the row, however short the question. Layout boxes,
    // not painted ones: the turned marker paints wider than it lays out.
    const ruleMarker = markerOf(rule!) as HTMLElement;
    const ruleSummary = rule!.querySelector("summary")!;
    expect(ruleMarker.offsetLeft + ruleMarker.offsetWidth).toBe(
      ruleSummary.offsetLeft + ruleSummary.offsetWidth,
    );
  });
});
