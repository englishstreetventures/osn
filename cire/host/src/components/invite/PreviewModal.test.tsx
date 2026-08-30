// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";

import PreviewModal from "./PreviewModal";
import type { PreviewPaneProps } from "./PreviewPane";

vi.mock("../../lib/api", () => ({ apiUrl: (path: string) => `https://api.test${path}` }));

/** A minimal, valid `PreviewPaneProps` fixture — the modal is a thin wrapper
 *  around `PreviewPane`, so what matters here is the dialog chrome (open
 *  state, close affordances), not the composed preview's own content, which
 *  `previews.test.tsx` and `InviteBuilder.test.tsx` already cover. */
const previewProps: PreviewPaneProps = {
  tokens: {},
  toneSurface: () => "var(--color-bg)",
  design: "classic",
  hero: {
    shown: true,
    imageUrl: null,
    crop: null,
    cropMobile: null,
    title: "Anita & Ben",
    heroBlur: 28,
    backdropOpacity: 0,
    backdropBlur: 0,
  },
  story: { shown: false, eyebrow: "", heading: "", body: "" },
  welcome: { message: "" },
  events: { eyebrow: "", heading: "" },
  closing: { shown: false, message: "", imageUrl: null, imageCrop: null },
};

afterEach(() => {
  cleanup();
});

describe("PreviewModal", () => {
  it("renders nothing when open={false}", () => {
    render(() => <PreviewModal {...previewProps} open={false} onClose={vi.fn()} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("renders the dialog and the composed preview when open={true}", () => {
    render(() => <PreviewModal {...previewProps} open={true} onClose={vi.fn()} />);
    expect(screen.getByRole("dialog", { name: "Invite preview modal" })).toBeInTheDocument();
    // The same `PreviewPane` the sticky side pane uses — one markup source.
    expect(screen.getByLabelText("Invite preview")).toBeInTheDocument();
  });

  it("names the pack, falling back to the raw id for one this build doesn't carry", () => {
    // The mid-deploy case. If the `?? props.design` fallback were dropped the
    // label would render EMPTY while the miniature silently showed the default
    // pack's shape — a preview that says nothing about a design it isn't
    // showing, which is worse than the design-blind state it replaced.
    render(() => (
      <PreviewModal {...previewProps} design="not-a-design" open={true} onClose={vi.fn()} />
    ));
    expect(screen.getByTestId("preview-design").textContent).toContain("not-a-design");
    // …and the shape falls back to the default pack rather than to nothing.
    expect(screen.getByLabelText("Invite preview").querySelector(".text-center")).toBeTruthy();
  });

  it("names a catalog pack by its display name, not its id", () => {
    render(() => <PreviewModal {...previewProps} design="gala" open={true} onClose={vi.fn()} />);
    expect(screen.getByTestId("preview-design").textContent).toContain("Gala");
  });

  it("Close button calls onClose", () => {
    const onClose = vi.fn();
    render(() => <PreviewModal {...previewProps} open={true} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("clicking the backdrop calls onClose", () => {
    const onClose = vi.fn();
    render(() => <PreviewModal {...previewProps} open={true} onClose={onClose} />);
    const backdrop = screen.getByRole("dialog").parentElement as HTMLElement;
    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("clicking inside the dialog does not call onClose", () => {
    const onClose = vi.fn();
    render(() => <PreviewModal {...previewProps} open={true} onClose={onClose} />);
    fireEvent.click(screen.getByRole("dialog"));
    expect(onClose).not.toHaveBeenCalled();
  });
});
