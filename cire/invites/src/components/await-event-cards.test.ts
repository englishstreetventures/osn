import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  awaitEventCards,
  CARD_CHUNK_TIMEOUT_MS,
  CARD_RENDER_TIMEOUT_MS,
} from "./await-event-cards";

/** A section with `count` rendered event-card wrappers inside it. */
function sectionWithCards(count: number): HTMLElement {
  const section = document.createElement("section");
  section.innerHTML = "<div data-event-card></div>".repeat(count);
  return section;
}

describe("awaitEventCards", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns as soon as the cards are in the DOM", async () => {
    const section = sectionWithCards(2);
    const settled = vi.fn();
    const p = awaitEventCards(
      async () => {},
      () => section,
    ).then(settled);
    await vi.advanceTimersByTimeAsync(16);
    await p;
    expect(settled).toHaveBeenCalled();
  });

  it("waits for a chunk that resolves late, then for the cards it renders", async () => {
    let section: HTMLElement | undefined = document.createElement("section");
    let resolveChunk: () => void = () => {};
    const chunk = new Promise<void>((resolve) => {
      resolveChunk = resolve;
    });

    const settled = vi.fn();
    const p = awaitEventCards(
      () => chunk,
      () => section,
    ).then(settled);

    await vi.advanceTimersByTimeAsync(200);
    expect(settled).not.toHaveBeenCalled();

    // The chunk lands and Solid renders the cards a frame later.
    resolveChunk();
    await vi.advanceTimersByTimeAsync(0);
    section = sectionWithCards(3);
    await vi.advanceTimersByTimeAsync(32);
    await p;
    expect(settled).toHaveBeenCalled();
  });

  // Every wait here is capped: a reveal held back forever by a chunk that never
  // arrives is the invisible invite this whole flow guards against.
  it("gives up on a chunk that never resolves", async () => {
    const settled = vi.fn();
    const p = awaitEventCards(
      () => new Promise(() => {}),
      () => sectionWithCards(1),
    ).then(settled);
    await vi.advanceTimersByTimeAsync(CARD_CHUNK_TIMEOUT_MS + CARD_RENDER_TIMEOUT_MS + 100);
    await p;
    expect(settled).toHaveBeenCalled();
  });

  // Polling for a card the chunk never delivered is dead wait bolted onto a
  // reveal that has already been held for a second and a half.
  it("does not poll for cards after the chunk itself timed out", async () => {
    const started = Date.now();
    let finishedAt = 0;
    const p = awaitEventCards(
      () => new Promise(() => {}),
      () => sectionWithCards(1),
    ).then(() => (finishedAt = Date.now()));
    await vi.advanceTimersByTimeAsync(CARD_CHUNK_TIMEOUT_MS + CARD_RENDER_TIMEOUT_MS + 100);
    await p;
    expect(finishedAt - started).toBe(CARD_CHUNK_TIMEOUT_MS);
  });

  // The chunk race leaves a loser every time, and on the warm path that loser
  // is a 1.5s timer holding its closure alive long after the reveal is done.
  it("clears the chunk timeout when the chunk wins the race", async () => {
    const section = sectionWithCards(1);
    const p = awaitEventCards(
      async () => {},
      () => section,
    );
    await vi.advanceTimersByTimeAsync(16);
    await p;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("gives up when the cards never render", async () => {
    const settled = vi.fn();
    const p = awaitEventCards(
      async () => {},
      () => document.createElement("section"),
    ).then(settled);
    await vi.advanceTimersByTimeAsync(CARD_RENDER_TIMEOUT_MS + 100);
    await p;
    expect(settled).toHaveBeenCalled();
  });

  it("gives up when there is no section at all", async () => {
    const settled = vi.fn();
    const p = awaitEventCards(
      async () => {},
      () => undefined,
    ).then(settled);
    await vi.advanceTimersByTimeAsync(CARD_RENDER_TIMEOUT_MS + 100);
    await p;
    expect(settled).toHaveBeenCalled();
  });

  // A rejected chunk is not an error here — the caller reveals without the
  // stagger, exactly as it does when the motion chunk itself fails to load.
  it("swallows a rejected chunk instead of failing the reveal", async () => {
    const settled = vi.fn();
    const p = awaitEventCards(
      async () => {
        throw new Error("offline");
      },
      () => sectionWithCards(1),
    ).then(settled);
    await vi.advanceTimersByTimeAsync(16);
    await p;
    expect(settled).toHaveBeenCalled();
  });
});
