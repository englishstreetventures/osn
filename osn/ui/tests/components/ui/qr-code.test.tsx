// @vitest-environment happy-dom
import { cleanup, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";

import { QrCode } from "../../../src/components/ui/qr-code";
import { encodeQr } from "../../../src/lib/qr";

/**
 * The symbol's own correctness is pinned in `tests/lib/qr.test.ts`. What is
 * checked here is the part a wrong render loses silently: that the graphic is
 * announced as one image with a label, that it carries the quiet zone and the
 * light ground a scanner needs, and that an unencodable payload degrades to
 * nothing rather than to a broken symbol.
 */

const URI = "otpauth://totp/Musubi:alice@example.com?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
const LABEL = "QR code for your authenticator app. Cannot scan it? Use the setup key below.";

const QUIET_ZONE = 4;

afterEach(() => cleanup());

describe("QrCode", () => {
  it("renders one labelled graphic rather than hundreds of shapes", () => {
    render(() => <QrCode value={URI} label={LABEL} />);
    const svg = screen.getByRole("img", { name: LABEL });
    expect(svg.tagName.toLowerCase()).toBe("svg");
    // One <path> for every dark module. A per-module <rect> would put a
    // thousand nodes in the document for a graphic that never changes.
    expect(svg.querySelectorAll("path")).toHaveLength(1);
    expect(svg.querySelectorAll("rect")).toHaveLength(1);
  });

  it("surrounds the symbol with the quiet zone a scanner needs", () => {
    render(() => <QrCode value={URI} label={LABEL} />);
    const svg = screen.getByRole("img", { name: LABEL });
    const side = encodeQr(URI).size + QUIET_ZONE * 2;
    expect(svg.getAttribute("viewBox")).toBe(`0 0 ${side} ${side}`);
  });

  it("paints its own light ground instead of inheriting the page's", () => {
    // These surfaces have a dark theme. A transparent QR on a dark background
    // is unreadable to every scanner, and nothing about the rendered markup
    // would look wrong.
    render(() => <QrCode value={URI} label={LABEL} />);
    const svg = screen.getByRole("img", { name: LABEL });
    expect(svg.querySelector("rect")?.getAttribute("fill")).toBe("#fff");
    expect(svg.querySelector("path")?.getAttribute("fill")).toBe("#000");
  });

  it("keeps module edges hard so a camera can resolve them", () => {
    render(() => <QrCode value={URI} label={LABEL} />);
    expect(screen.getByRole("img", { name: LABEL }).getAttribute("shape-rendering")).toBe(
      "crispEdges",
    );
  });

  it("draws a dark module for every dark module in the symbol", () => {
    render(() => <QrCode value={URI} label={LABEL} />);
    const drawn = (
      screen.getByRole("img", { name: LABEL }).querySelector("path")?.getAttribute("d") ?? ""
    ).match(/M/g)?.length;
    const expected = encodeQr(URI).modules.flat().filter(Boolean).length;
    expect(drawn).toBe(expected);
  });

  it("renders nothing at all when the payload cannot be encoded", () => {
    // The caller always shows the payload another way, so losing the symbol
    // costs a convenience. Throwing here would cost the whole screen.
    const { container } = render(() => <QrCode value={"a".repeat(500)} label={LABEL} />);
    expect(container.querySelector("svg")).toBeNull();
    expect(screen.queryByRole("img")).toBeNull();
  });
});
