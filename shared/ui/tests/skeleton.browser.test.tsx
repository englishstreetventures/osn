/**
 * `Skeleton` in real Chromium: what a DOM shim cannot see.
 *
 * - The pulse. It runs the theme's `--animate-pulse` (Tailwind's own token, 2s,
 *   down to half strength and back), follows an app that redefines that token,
 *   and stops for a reader who asked for reduced motion. This tier's stylesheet
 *   has no `*` reduced-motion switch, and neither have Musubi's or pulse's, so
 *   only the component's `motion-safe:` prefix can stop it.
 * - The fill and the corner: the contract's sunk well for every stand-in
 *   (Musubi's `--ui-surface` is its page white), no edge, and in a contrast
 *   theme an edge in the theme's text colour, whatever the page's own, and the corner of what each
 *   stands in for — a role's for a field and a button — a row's for a value it
 *   does not know.
 * - The size: spacing steps, as Tailwind's `w-n` and `h-n` compute them, 0
 *   included, never wider than its container, a square pill kept square in a
 *   crowded row, a bad number refused rather than written into an invalid
 *   `calc()`, and no caller's `w-*` or `h-*` able to resize it.
 * - Chrome hides it from a screen reader because it is `aria-hidden`, and a
 *   caller's placement class reaches it.
 *
 * Values are compared against a probe resolved the same way beside the block,
 * never against a custom property's raw text.
 */

import { cleanup, render } from "@solidjs/testing-library";
import type { JSX } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";
import { cdp, commands } from "vitest/browser";

import { Skeleton, type SkeletonStandIn } from "../src/ui/skeleton";

import "./test-support/tailwind.css";

type MediaPreference = {
  reducedMotion?: "reduce" | "no-preference";
  forcedColors?: "active" | "none";
};
const emulateMedia = (options: MediaPreference) =>
  (commands as unknown as { emulateMedia: (o: MediaPreference) => Promise<void> }).emulateMedia(
    options,
  );

const STAND_INS = [
  "line",
  "row",
  "field",
  "control",
  "card",
  "pill",
] as const satisfies readonly SkeletonStandIn[];

/**
 * Renders `ui` alone in a 400px host carrying `style`, and returns the host's
 * first child: the block itself, which takes no attribute a query could find.
 */
function mountOne(ui: () => JSX.Element, style = ""): HTMLElement {
  render(() => (
    <div data-host style={`width: 400px; ${style}`}>
      {ui()}
    </div>
  ));
  const block = document.querySelector("[data-host]")?.firstElementChild;
  if (!(block instanceof HTMLElement)) throw new Error("no block in the host");
  return block;
}

/** `property` on a probe styled `css`, beside `block` so it inherits the same tokens. */
function probed(block: HTMLElement, css: string, property: string): string {
  const probe = document.createElement("div");
  probe.style.cssText = css;
  block.parentElement!.append(probe);
  const value = getComputedStyle(probe).getPropertyValue(property);
  probe.remove();
  return value;
}

const px = (value: string) => Number.parseFloat(value);

interface DOMNode {
  backendNodeId: number;
  attributes?: string[];
  children?: DOMNode[];
  contentDocument?: DOMNode;
  shadowRoots?: DOMNode[];
}

interface AXNode {
  ignored: boolean;
  ignoredReasons?: { name: string }[];
}

/** Chrome's accessibility node for `element` itself, ignored or not. */
async function accessibilityNode(element: HTMLElement): Promise<AXNode> {
  const session = cdp();
  const marker = crypto.randomUUID();
  element.setAttribute("data-ax-probe", marker);
  const { root } = (await session.send("DOM.getDocument", { depth: -1, pierce: true })) as {
    root: DOMNode;
  };
  const find = (node: DOMNode): DOMNode | undefined => {
    const attributes = node.attributes ?? [];
    for (let i = 0; i < attributes.length; i += 2) {
      if (attributes[i] === "data-ax-probe" && attributes[i + 1] === marker) return node;
    }
    for (const next of [
      ...(node.children ?? []),
      ...(node.contentDocument ? [node.contentDocument] : []),
      ...(node.shadowRoots ?? []),
    ]) {
      const found = find(next);
      if (found) return found;
    }
    return undefined;
  };
  const own = find(root);
  if (!own) throw new Error("the block is not in the DOM Chrome reports");
  const { nodes } = (await session.send("Accessibility.getPartialAXTree", {
    backendNodeId: own.backendNodeId,
    fetchRelatives: false,
  })) as { nodes: AXNode[] };
  if (!nodes[0]) throw new Error("Chrome returned no accessibility node for the block");
  return nodes[0];
}

afterEach(async () => {
  await emulateMedia({ reducedMotion: "no-preference", forcedColors: "none" });
  cleanup();
});

describe("Skeleton: the pulse", () => {
  it("runs the theme's --animate-pulse: 2s, on its curve, without end", () => {
    const block = mountOne(() => <Skeleton height={10} />);
    const style = getComputedStyle(block);
    // The control: the probe reads the token, so the token is in the build.
    expect(probed(block, "animation: var(--animate-pulse)", "animation-name")).toBe("pulse");
    expect(style.animationName).toBe("pulse");
    expect(style.animationDuration).toBe("2s");
    expect(style.animationIterationCount).toBe("infinite");
    expect(style.animationTimingFunction).toBe(
      probed(block, "animation: var(--animate-pulse)", "animation-timing-function"),
    );
  });

  it("fades to half strength halfway through each pulse", () => {
    const block = mountOne(() => <Skeleton height={10} />);
    const [animation] = block.getAnimations();
    expect(animation).toBeDefined();
    animation!.pause();
    animation!.currentTime = 1000;
    expect(Number(getComputedStyle(block).opacity)).toBeCloseTo(0.5, 3);
  });

  it("stands still at full strength for a reader who asked for reduced motion", async () => {
    await emulateMedia({ reducedMotion: "reduce" });
    const block = mountOne(() => <Skeleton height={10} />);
    expect(getComputedStyle(block).animationName).toBe("none");
    expect(block.getAnimations()).toHaveLength(0);
    expect(getComputedStyle(block).opacity).toBe("1");
  });

  it("runs an app's own pulse when the app redefines --animate-pulse", () => {
    const block = mountOne(
      () => <Skeleton height={10} />,
      "--animate-pulse: pulse 4s linear infinite;",
    );
    const style = getComputedStyle(block);
    expect(style.animationDuration).toBe("4s");
    expect(style.animationTimingFunction).toBe("linear");
  });
});

describe("Skeleton: fill and corner", () => {
  it.each(STAND_INS)("paints a %s in the sunk well, with no edge", (standIn) => {
    const block = mountOne(() => <Skeleton standsFor={standIn} height={10} />);
    const fill = getComputedStyle(block).backgroundColor;
    expect(fill).toBe(
      probed(block, "background-color: var(--ui-surface-sunk)", "background-color"),
    );
    expect(fill).not.toBe(probed(block, "background-color: var(--ui-surface)", "background-color"));
    expect(getComputedStyle(block).borderTopWidth).toBe("0px");
  });

  // The host's own text colour is near-white, as a dark page's is, so a block
  // that took the page's colour instead of the theme's would show it here.
  const PAGE_TEXT = "rgb(250, 250, 250)";

  it.each(STAND_INS)(
    "edges a %s in the theme's text colour in a contrast theme, not the page's",
    async (standIn) => {
      await emulateMedia({ forcedColors: "active" });
      expect(matchMedia("(forced-colors: active)").matches).toBe(true);
      const block = mountOne(
        () => <Skeleton standsFor={standIn} height={10} />,
        `color: ${PAGE_TEXT};`,
      );
      const style = getComputedStyle(block);
      const theme = (colour: string) =>
        probed(block, `forced-color-adjust: none; color: ${colour}`, "color");
      expect(style.borderTopStyle).toBe("solid");
      expect(px(style.borderTopWidth)).toBe(1);
      expect(style.borderTopColor).toBe(theme("CanvasText"));
      expect(theme("CanvasText")).not.toBe(theme("Canvas"));
      expect(style.borderTopColor).not.toBe(PAGE_TEXT);
    },
  );

  // Every corner token at a value no other one takes, so a stand-in that reads
  // a sized step where its role is meant (or the reverse) lands on the wrong one.
  const RADII = [
    "--ui-radius-sm: 3px;",
    "--ui-radius-md: 7px;",
    "--ui-radius-lg: 13px;",
    "--ui-radius-pill: 501px;",
    "--ui-radius-control: 11px;",
    "--ui-radius-field: 17px;",
  ].join(" ");
  const CORNER = {
    line: "3px",
    row: "7px",
    field: "17px",
    control: "11px",
    card: "13px",
    pill: "501px",
  } as const satisfies Record<SkeletonStandIn, string>;

  it.each(STAND_INS)("gives a %s the corner of what it stands in for", (standIn) => {
    const block = mountOne(() => <Skeleton standsFor={standIn} height={10} />, RADII);
    expect(getComputedStyle(block).borderTopLeftRadius).toBe(CORNER[standIn]);
  });

  it.each([undefined, "blob", "constructor"])(
    "gives a row's corner to a value it does not know (%s)",
    (value) => {
      const block = mountOne(
        () => <Skeleton standsFor={value as SkeletonStandIn | undefined} height={10} />,
        RADII,
      );
      expect(getComputedStyle(block).borderTopLeftRadius).toBe(CORNER.row);
    },
  );
});

describe("Skeleton: size", () => {
  it("sizes in spacing steps, and fills its container when given no width", () => {
    const sized = mountOne(() => <Skeleton width={48} height={14} />);
    expect(sized.getBoundingClientRect().width).toBe(192);
    expect(sized.getBoundingClientRect().height).toBe(56);
    cleanup();
    const full = mountOne(() => <Skeleton height={14} />);
    expect(full.getBoundingClientRect().width).toBe(400);
    cleanup();
    const named = mountOne(() => <Skeleton width="full" height={14} />);
    expect(named.getBoundingClientRect().width).toBe(400);
  });

  it("follows an app's spacing step", () => {
    const block = mountOne(() => <Skeleton width={48} height={14} />, "--spacing: 0.5rem;");
    expect(block.getBoundingClientRect().width).toBe(384);
    expect(block.getBoundingClientRect().height).toBe(112);
  });

  it("takes 0 as a size, not as a refusal", () => {
    const flat = mountOne(() => <Skeleton width={48} height={0} />);
    expect(flat.getBoundingClientRect().height).toBe(0);
    expect(flat.getBoundingClientRect().width).toBe(192);
    cleanup();
    const narrow = mountOne(() => <Skeleton width={0} height={14} />);
    expect(narrow.getBoundingClientRect().width).toBe(0);
    expect(narrow.getBoundingClientRect().height).toBe(56);
  });

  it.each([Number.NaN, -4, Number.POSITIVE_INFINITY])(
    "refuses a width of %s: it fills what its row leaves and pushes nothing out",
    (width) => {
      render(() => (
        <div data-row style="width: 288px; display: flex; align-items: center; gap: 12px;">
          <Skeleton standsFor="pill" width={10} height={10} />
          <Skeleton width={width} height={14} />
        </div>
      ));
      const row = document.querySelector<HTMLElement>("[data-row]")!;
      const [pill, block] = [...row.children] as HTMLElement[];
      expect(block!.getBoundingClientRect().width).toBe(288 - 40 - 12);
      expect(block!.getBoundingClientRect().height).toBe(56);
      expect(pill!.getBoundingClientRect().width).toBe(40);
      expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth);
    },
  );

  it.each([Number.NaN, -4, Number.POSITIVE_INFINITY])(
    "refuses a height of %s and stands one line of text high",
    (height) => {
      const block = mountOne(() => <Skeleton width={48} height={height} />);
      expect(block.getBoundingClientRect().height).toBe(16);
      expect(block.getBoundingClientRect().width).toBe(192);
    },
  );

  it("never runs wider than a phone column", () => {
    const block = mountOne(
      () => <Skeleton standsFor="line" width={96} height={5} />,
      "width: 288px; display: flex; flex-direction: column;",
    );
    const column = block.parentElement!;
    expect(block.getBoundingClientRect().width).toBe(288);
    expect(column.scrollWidth).toBeLessThanOrEqual(column.clientWidth);
  });

  it("keeps a square pill square beside a full-width line in a crowded row", () => {
    render(() => (
      <div data-row style="width: 288px; display: flex; align-items: center; gap: 12px;">
        <Skeleton standsFor="pill" width={10} height={10} />
        <Skeleton standsFor="line" height={4} />
      </div>
    ));
    const [pill, line] = [...document.querySelector("[data-row]")!.children] as HTMLElement[];
    expect(pill!.getBoundingClientRect().width).toBe(40);
    expect(pill!.getBoundingClientRect().height).toBe(40);
    expect(line!.getBoundingClientRect().width).toBe(288 - 40 - 12);
    expect(px(getComputedStyle(pill!).borderTopLeftRadius)).toBeGreaterThanOrEqual(20);
  });
});

describe("Skeleton: what reaches it", () => {
  it("is hidden from a screen reader because it is aria-hidden, with no role or child", async () => {
    const block = mountOne(() => <Skeleton height={5} />);
    expect(block.getAttribute("role")).toBeNull();
    expect(block.childNodes).toHaveLength(0);
    const node = await accessibilityNode(block);
    expect(node.ignored).toBe(true);
    expect(node.ignoredReasons?.map((reason) => reason.name)).toContain("ariaHiddenElement");
  });

  it("takes a caller's placement class", () => {
    const block = mountOne(() => <Skeleton height={5} class="mt-2" />);
    expect(getComputedStyle(block).marginTop).toBe("8px");
  });

  it("keeps its own size against a caller's w-* or h-*, with a width or without", () => {
    const sized = mountOne(() => <Skeleton width={48} height={14} class="h-2 w-10" />);
    expect(sized.getBoundingClientRect().width).toBe(192);
    expect(sized.getBoundingClientRect().height).toBe(56);
    cleanup();
    const full = mountOne(() => <Skeleton height={14} class="w-10" />);
    expect(full.getBoundingClientRect().width).toBe(400);
  });
});
