import Disclosure from "@cire/ui/disclosure";
import { cleanup, render } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, onTestFinished } from "vitest";
import { commands } from "vitest/browser";

import "../../src/styles/global.css";

/**
 * `@cire/ui`'s `Disclosure`, painted by the host's own stylesheet: what its
 * unit tests can only read as class names. The body's opening is the part's
 * own transition, gated by `no-preference`: the global reduced-motion block
 * selects `*`, which no pseudo-element matches, so it cannot reach
 * `::details-content`, and only a real engine computes a pseudo-element's
 * transition to show it.
 */

const body = (el: Element) => getComputedStyle(el, "::details-content");
const height = (el: Element) => el.getBoundingClientRect().height;
const nextFrame = () => new Promise<number>((resolve) => requestAnimationFrame(resolve));

/** One painted frame of an opening: each watched box's height, and the body's ink. */
interface Frame {
  boxes: number[];
  opacity: number;
  overflow: string;
}

/**
 * Opens `details` and reads every frame until its longest transition, delay
 * included, has run, plus a few frames to settle.
 */
async function openAndWatch(details: HTMLDetailsElement, boxes: Element[]): Promise<Frame[]> {
  details.open = true;
  const seconds = (list: string) => list.split(",").map((s) => Number.parseFloat(s));
  const durations = seconds(body(details).transitionDuration);
  const delays = seconds(body(details).transitionDelay);
  const longest = Math.max(...durations.map((d, i) => d + (delays[i] ?? 0)));
  const until = performance.now() + longest * 1000 + 100;
  const frames: Frame[] = [];
  while (performance.now() < until) {
    await nextFrame();
    frames.push({
      boxes: boxes.map(height),
      opacity: Number(body(details).opacity),
      overflow: body(details).overflow,
    });
  }
  return frames;
}

/** Slows the portal threefold, so an opening spans enough frames to read. */
function slowMotion() {
  const root = document.documentElement.style;
  root.setProperty("--motion-scale", "3");
  onTestFinished(() => {
    root.removeProperty("--motion-scale");
  });
}

/** Three lines of body, made fresh for each disclosure that shows them. */
const lines = () => (
  <>
    <p>Drag a table to move it.</p>
    <p>Tables keep their order on the printed plan.</p>
    <p>A table's number follows its place in the list.</p>
  </>
);

afterEach(async () => {
  cleanup();
  await commands.emulateMedia({ reducedMotion: "no-preference" });
});

describe("the Disclosure part opening", () => {
  it("grows the card to its height as the text fades in, neither ahead of the other", async () => {
    slowMotion();
    const { container } = render(() => (
      <div style={{ width: "360px" }}>
        <Disclosure summary="Arrange tables">{lines()}</Disclosure>
      </div>
    ));
    const details = container.querySelector("details")!;
    const closed = height(details);

    const frames = await openAndWatch(details, [details]);
    const full = height(details);
    expect(full).toBeGreaterThan(closed + 40);
    const share = (frame: Frame) => (frame.boxes[0]! - closed) / (full - closed);

    // The card passes through heights between closed and open, not one jump.
    expect(frames.filter((f) => share(f) > 0.1 && share(f) < 0.9).length).toBeGreaterThan(2);
    // The text's ink keeps pace with the box on every frame: no frame shows
    // the card at full height with the text still faint, or the reverse.
    for (const frame of frames) {
      expect(Math.abs(frame.opacity - share(frame))).toBeLessThanOrEqual(0.05);
    }
    // The body is clipped while it grows, so no line spills past the card,
    // and let go once open, so nothing inside is cut at rest.
    expect(frames.find((f) => share(f) < 0.5)?.overflow).toBe("clip");
    expect(body(details).overflow).toBe("visible");
    expect(frames.at(-1)!.boxes[0]).toBe(full);
  });

  it("grows a nested card and the card round it together", async () => {
    slowMotion();
    const { container } = render(() => (
      <div style={{ width: "360px" }}>
        <Disclosure summary="How to structure your sheet" open>
          <Disclosure summary="Formatting tips" nested>
            {lines()}
          </Disclosure>
        </Disclosure>
      </div>
    ));
    const [outer, inner] = container.querySelectorAll("details");
    const start = [height(outer!), height(inner!)];

    const frames = await openAndWatch(inner!, [outer!, inner!]);
    const end = [height(outer!), height(inner!)];
    expect(end[1]! - start[1]!).toBeGreaterThan(40);

    // On some frame both boxes are partway open at once.
    const partway = (f: Frame) => f.boxes.every((h, i) => h > start[i]! + 1 && h < end[i]! - 1);
    expect(frames.some(partway)).toBe(true);
    // The outer card grows by what the inner one does, frame by frame.
    for (const frame of frames) {
      expect(frame.boxes[0]! - start[0]!).toBeCloseTo(frame.boxes[1]! - start[1]!, 0);
    }
  });

  it("opens at full height on the first frame under reduced motion", async () => {
    await commands.emulateMedia({ reducedMotion: "reduce" });
    const { container } = render(() => (
      <div style={{ width: "360px" }}>
        <Disclosure summary="Arrange tables">{lines()}</Disclosure>
        <Disclosure summary="Arrange tables" open>
          {lines()}
        </Disclosure>
      </div>
    ));
    const [details, alreadyOpen] = container.querySelectorAll("details");

    details!.open = true;
    await nextFrame();
    expect(height(details!)).toBe(height(alreadyOpen!));
    expect(body(details!).opacity).toBe("1");
  });

  it("runs nothing for a disclosure that is open when it first paints", async () => {
    slowMotion();
    const { container } = render(() => (
      <Disclosure summary="Arrange tables" open>
        {lines()}
      </Disclosure>
    ));
    const details = container.querySelector("details")!;
    // Read by height, not `getAnimations()`: Chromium does not list a
    // transition on `::details-content` there.
    const first = height(details);
    await nextFrame();
    expect(height(details)).toBe(first);
    expect(body(details).opacity).toBe("1");
  });
});

describe("the Disclosure part", () => {
  const markerOf = (details: Element) =>
    [...details.querySelector(":scope > summary")!.children].find(
      (el) => el.textContent === "›" || el.textContent === "+",
    )!;

  it("opens its body on a transition, closes at once, and has none under reduced motion", async () => {
    const { container } = render(() => <Disclosure summary="Change history">Inside</Disclosure>);
    const details = container.querySelector("details")!;
    expect(body(details).transitionDuration).toBe("0s");

    details.open = true;
    expect(body(details).transitionProperty).toBe("opacity, translate, height, overflow");
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

  it("times the opening and the turn on the app's own steps and easing", () => {
    // Read from the host's tokens, so a lost class, a renamed token or a
    // build that drops one fails here. The portal is slowed threefold so no
    // step can match Tailwind's own default duration by chance.
    slowMotion();
    const probe = document.createElement("span");
    document.body.append(probe);
    onTestFinished(() => probe.remove());
    probe.style.transitionDuration = "var(--dur-fast)";
    probe.style.transitionTimingFunction = "var(--ease-out)";
    const fast = getComputedStyle(probe).transitionDuration;
    const easeOut = getComputedStyle(probe).transitionTimingFunction;
    probe.style.transitionDuration = "var(--dur-slow)";
    const slow = getComputedStyle(probe).transitionDuration;

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
    // The fade, the drop and the growth share the slow step, the owner's
    // choice; the clip is let go by a step delayed by the same.
    const opening = body(details);
    expect([
      opening.transitionDuration,
      opening.transitionDelay,
      opening.transitionTimingFunction,
      opening.transitionBehavior,
    ]).toEqual([`${slow}, ${slow}, ${slow}, 0s`, `0s, 0s, 0s, ${slow}`, easeOut, "allow-discrete"]);
    expect(fast).not.toBe(slow);
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
