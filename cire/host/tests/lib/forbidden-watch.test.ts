import { describe, expect, it, vi } from "vitest";

import { refusesWedding, watchForbidden } from "../../src/lib/forbidden-watch";

const WEDDING_URL = "https://api.test/api/organiser/weddings/wed_a/vendors";

describe("refusesWedding", () => {
  it("is a 403 from a route scoped to one wedding", () => {
    const refused = new Response(null, { status: 403 });
    expect(refusesWedding(WEDDING_URL, refused)).toBe(true);
    expect(refusesWedding(new URL(WEDDING_URL), refused)).toBe(true);
    expect(refusesWedding(new Request(WEDDING_URL), refused)).toBe(true);
    expect(
      refusesWedding("https://api.test/api/organiser/weddings/wed_a/tasks/t_1?x=1", refused),
    ).toBe(true);
  });

  it("is not the list route, another route, or another status", () => {
    const refused = new Response(null, { status: 403 });
    expect(refusesWedding("https://api.test/api/organiser/weddings", refused)).toBe(false);
    expect(refusesWedding("https://api.test/api/organiser/weddings/wed_a", refused)).toBe(false);
    expect(refusesWedding("https://api.test/api/directory/listings", refused)).toBe(false);
    // 402 is a locked module, 404 an unknown row: neither says the role moved.
    for (const status of [200, 402, 404, 500]) {
      expect(refusesWedding(WEDDING_URL, new Response(null, { status }))).toBe(false);
    }
  });
});

describe("watchForbidden", () => {
  it("reports a refusal and hands the response back untouched", async () => {
    const refused = new Response("{}", { status: 403 });
    const inner = vi.fn().mockResolvedValue(refused);
    const onRefused = vi.fn();
    const watched = watchForbidden(inner, onRefused);

    const init = { method: "PATCH" };
    const res = await watched(WEDDING_URL, init);

    expect(res).toBe(refused);
    expect(inner).toHaveBeenCalledWith(WEDDING_URL, init);
    expect(onRefused).toHaveBeenCalledTimes(1);
  });

  it("reports when the refused request was sent, not when the answer came", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
    try {
      let answer: (res: Response) => void = () => {};
      const inner = vi.fn(() => new Promise<Response>((resolve) => (answer = resolve)));
      const onRefused = vi.fn();
      const pending = watchForbidden(inner, onRefused)(WEDDING_URL);

      clock.mockReturnValue(5_000);
      answer(new Response(null, { status: 403 }));
      await pending;

      expect(onRefused).toHaveBeenCalledWith(1_000);
    } finally {
      clock.mockRestore();
    }
  });

  it("stays quiet on anything else, and lets a thrown error through", async () => {
    const onRefused = vi.fn();
    const ok = watchForbidden(vi.fn().mockResolvedValue(new Response(null)), onRefused);
    await ok(WEDDING_URL);

    const failure = new Error("AuthExpiredError");
    const failing = watchForbidden(vi.fn().mockRejectedValue(failure), onRefused);
    await expect(failing(WEDDING_URL)).rejects.toBe(failure);

    expect(onRefused).not.toHaveBeenCalled();
  });
});
