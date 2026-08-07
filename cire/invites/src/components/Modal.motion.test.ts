import { describe, it, expect, vi, beforeEach } from "vitest";

const { animateMock } = vi.hoisted(() => ({
  animateMock: vi.fn(() => ({ finished: Promise.resolve() })),
}));
vi.mock("motion", () => ({ animate: animateMock }));

import { modalEnter, modalExit } from "./Modal.motion";

describe("modalEnter", () => {
  let backdrop: HTMLElement;
  let panel: HTMLElement;

  beforeEach(() => {
    animateMock.mockClear();
    backdrop = document.createElement("div");
    panel = document.createElement("div");
  });

  it("animates backdrop opacity", () => {
    modalEnter(backdrop, panel);
    expect(animateMock).toHaveBeenCalledWith(
      backdrop,
      { opacity: [0, 1] },
      expect.objectContaining({ duration: 0.25 }),
    );
  });

  it("animates panel with slide-up and scale", () => {
    modalEnter(backdrop, panel);
    expect(animateMock).toHaveBeenCalledWith(
      panel,
      expect.objectContaining({ opacity: [0, 1] }),
      expect.objectContaining({ duration: 0.35 }),
    );
  });
});

describe("modalExit", () => {
  let backdrop: HTMLElement;
  let panel: HTMLElement;

  beforeEach(() => {
    animateMock.mockClear();
    backdrop = document.createElement("div");
    panel = document.createElement("div");
  });

  it("resolves after panel animation finishes", async () => {
    await modalExit(backdrop, panel);
    expect(animateMock).toHaveBeenCalledTimes(2);
  });

  it("animates backdrop to transparent", async () => {
    await modalExit(backdrop, panel);
    expect(animateMock).toHaveBeenCalledWith(
      backdrop,
      { opacity: [1, 0] },
      expect.objectContaining({ duration: 0.2 }),
    );
  });

  it("animates panel out with slide-down", async () => {
    await modalExit(backdrop, panel);
    expect(animateMock).toHaveBeenCalledWith(
      panel,
      expect.objectContaining({ opacity: [1, 0] }),
      expect.objectContaining({ duration: 0.2 }),
    );
  });
});
