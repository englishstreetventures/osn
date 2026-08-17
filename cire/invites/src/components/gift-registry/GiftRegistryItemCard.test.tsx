// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { GiftRegistryHouseholdClaim, GiftRegistryItem } from "../../lib/gift-registry";
import {
  GIFT_CARD_IMAGE_ASPECT,
  GIFT_CARD_IMAGE_CLASS,
  GiftRegistryItemCard,
} from "./GiftRegistryItemCard";

/**
 * One gift card.
 *
 * The load-bearing assertions here are the privacy property (counts, never a
 * name), the render-site https re-check on the shop link, and the reserve
 * ceiling — which is NOT `remaining`, because the server's claim is an upsert
 * whose guard excludes this household's own row.
 */

const ITEM: GiftRegistryItem = {
  id: "gi-1",
  kind: "product",
  title: "Copper pan",
  description: "For the kitchen.",
  imageName: null,
  imageCrop: null,
  externalUrl: null,
  priceMinor: null,
  quantityWanted: 1,
  quantityClaimed: 0,
  category: null,
  sortOrder: 0,
};

function renderCard(
  overrides: {
    item?: Partial<GiftRegistryItem>;
    claim?: GiftRegistryHouseholdClaim;
    canClaim?: boolean;
    busy?: boolean;
    imageBase?: string | null;
    onClaim?: (body: unknown) => Promise<boolean>;
    onRelease?: () => void;
  } = {},
) {
  const onClaim = vi.fn(overrides.onClaim ?? (async () => true));
  const onRelease = vi.fn(overrides.onRelease ?? (() => {}));
  const result = render(() => (
    <GiftRegistryItemCard
      item={{ ...ITEM, ...overrides.item }}
      currency="AUD"
      imageBase={overrides.imageBase ?? null}
      claim={overrides.claim}
      canClaim={overrides.canClaim ?? true}
      busy={overrides.busy ?? false}
      onClaim={onClaim}
      onRelease={onRelease}
    />
  ));
  return { ...result, onClaim, onRelease };
}

afterEach(cleanup);

describe("privacy: counts, never names", () => {
  it("renders only a count for an item another household has taken", () => {
    const { container } = renderCard({
      item: { quantityWanted: 2, quantityClaimed: 1 },
    });

    expect(container.querySelector("[data-gift-remaining]")?.textContent).toBe("1 of 2 left");
    // Nothing in the payload names a claimant, and nothing here invents one.
    expect(container.querySelector("[data-gift-mine]")).toBeNull();
    expect(container.textContent).not.toMatch(/reserved by/i);
  });

  it("says a fully-claimed item is covered without saying by whom", () => {
    const { container } = renderCard({ item: { quantityWanted: 1, quantityClaimed: 1 } });
    expect(container.querySelector("[data-gift-remaining]")?.textContent).toBe("All reserved");
    expect(screen.getByText("Another guest has this one covered.")).toBeTruthy();
  });

  it("echoes back only THIS household's own display name", () => {
    const { container } = renderCard({
      item: { quantityWanted: 2, quantityClaimed: 2 },
      claim: {
        itemId: "gi-1",
        quantity: 2,
        status: "reserved",
        note: "hidden from the list",
        displayName: "The Ashworths",
      },
    });

    const mine = container.querySelector("[data-gift-mine]");
    expect(mine?.textContent).toContain("You reserved 2 of these");
    expect(mine?.textContent).toContain("The Ashworths");
    // A note is for the couple, not for the page.
    expect(container.textContent).not.toContain("hidden from the list");
  });
});

describe("the shop link", () => {
  it("renders an https link that hands the shop no opener handle", () => {
    const { container } = renderCard({ item: { externalUrl: "https://shop.example/pan" } });
    const link = container.querySelector("a") as HTMLAnchorElement | null;
    expect(link?.getAttribute("href")).toBe("https://shop.example/pan");
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("renders NO link for a non-https url, whatever the column says", () => {
    for (const externalUrl of [
      "javascript:alert(1)",
      "http://shop.example/pan",
      "data:text/html,<script>alert(1)</script>",
      "https://shop.example@evil.test/",
    ]) {
      const { container, unmount } = renderCard({ item: { externalUrl } });
      expect(container.querySelector("a")).toBeNull();
      unmount();
    }
  });
});

describe("the reserve ceiling", () => {
  it("offers up to `remaining` for a household with no claim yet", () => {
    const { container } = renderCard({ item: { quantityWanted: 3, quantityClaimed: 1 } });
    fireEvent.click(screen.getByRole("button", { name: "Reserve" }));
    const input = container.querySelector('input[type="number"]') as HTMLInputElement;
    expect(input.max).toBe("2");
    expect(input.value).toBe("1");
  });

  it("adds this household's own claim back in, because the claim is an upsert", () => {
    // 2 wanted, both claimed BY US: `remaining` is 0, but we may still change
    // our own reservation to 2 — the server's guard excludes our own row.
    const { container } = renderCard({
      item: { quantityWanted: 2, quantityClaimed: 2 },
      claim: { itemId: "gi-1", quantity: 2, status: "reserved", note: null, displayName: null },
    });
    fireEvent.click(screen.getByRole("button", { name: "Change" }));
    const input = container.querySelector('input[type="number"]') as HTMLInputElement;
    expect(input.max).toBe("2");
    // Opens on what they already have, not back at 1.
    expect(input.value).toBe("2");
  });

  it("offers no reserve control at all when nothing is left and we hold none", () => {
    renderCard({ item: { quantityWanted: 1, quantityClaimed: 1 } });
    expect(screen.queryByRole("button", { name: "Reserve" })).toBeNull();
  });

  it("shows no controls at all for a signed-out guest", () => {
    const { container } = renderCard({ canClaim: false });
    expect(container.querySelectorAll("button")).toHaveLength(0);
  });
});

describe("the claim form", () => {
  it("sends the trimmed fields and nulls what the guest left blank", async () => {
    const { container, onClaim } = renderCard({ item: { quantityWanted: 2 } });
    fireEvent.click(screen.getByRole("button", { name: "Reserve" }));

    const quantity = container.querySelector('input[type="number"]') as HTMLInputElement;
    fireEvent.input(quantity, { target: { value: "2" } });
    const name = container.querySelector('input[type="text"]') as HTMLInputElement;
    fireEvent.input(name, { target: { value: "  The Ashworths  " } });

    fireEvent.submit(container.querySelector("form") as HTMLFormElement);
    await Promise.resolve();

    expect(onClaim).toHaveBeenCalledWith({
      quantity: 2,
      note: null,
      displayName: "The Ashworths",
    });
  });

  it("closes on success", async () => {
    const { container } = renderCard({ onClaim: async () => true });
    fireEvent.click(screen.getByRole("button", { name: "Reserve" }));
    fireEvent.submit(container.querySelector("form") as HTMLFormElement);
    await Promise.resolve();
    await Promise.resolve();
    expect(container.querySelector("form")).toBeNull();
  });

  it("KEEPS the form open when the claim did not land, so the words are not thrown away", async () => {
    // The 409 race reaches the card as `false`. Discarding what the guest typed
    // because another household was a second faster would be its own bug.
    const { container } = renderCard({ onClaim: async () => false });
    fireEvent.click(screen.getByRole("button", { name: "Reserve" }));
    const name = container.querySelector('input[type="text"]') as HTMLInputElement;
    fireEvent.input(name, { target: { value: "The Ashworths" } });

    fireEvent.submit(container.querySelector("form") as HTMLFormElement);
    await Promise.resolve();
    await Promise.resolve();

    expect(container.querySelector("form")).toBeTruthy();
    expect((container.querySelector('input[type="text"]') as HTMLInputElement).value).toBe(
      "The Ashworths",
    );
  });

  it("sends 1, not 0, when the guest empties the quantity box", async () => {
    const { container, onClaim } = renderCard({ item: { quantityWanted: 2 } });
    fireEvent.click(screen.getByRole("button", { name: "Reserve" }));
    const quantity = container.querySelector('input[type="number"]') as HTMLInputElement;

    // The box must be EMPTIABLE — a numeric signal bound back into `value` snaps
    // it to "0" here, and clearing that writes 0 → 0, which notifies nothing and
    // leaves it visibly blank.
    fireEvent.input(quantity, { target: { value: "" } });
    expect(quantity.value).toBe("");

    fireEvent.submit(container.querySelector("form") as HTMLFormElement);
    await Promise.resolve();

    // An empty number input passes native validation (`min` bounds a value, and
    // there is none), so this reached the server as 0 — outside its 1…99 range,
    // a 400, reported to the guest as "pick a smaller one" than a number they
    // never chose.
    expect(onClaim).toHaveBeenCalledWith({ quantity: 1, note: null, displayName: null });
    expect(quantity.value).toBe("1");
  });

  it("bounds what it sends into 1…ceiling, whatever the box says", async () => {
    const { container, onClaim } = renderCard({
      item: { quantityWanted: 2 },
      // Stays open, so one form can be tried with several inputs.
      onClaim: async () => false,
    });
    fireEvent.click(screen.getByRole("button", { name: "Reserve" }));
    const quantity = container.querySelector('input[type="number"]') as HTMLInputElement;
    const form = container.querySelector("form") as HTMLFormElement;

    for (const [typed, sent] of [
      ["0", 1],
      ["-3", 1],
      ["abc", 1],
      ["2.7", 2],
      ["9", 2],
    ] as const) {
      onClaim.mockClear();
      fireEvent.input(quantity, { target: { value: typed } });
      fireEvent.submit(form);
      await Promise.resolve();
      await Promise.resolve();
      expect(onClaim).toHaveBeenCalledWith({ quantity: sent, note: null, displayName: null });
      // And the box shows what was actually sent, not what was refused.
      expect(quantity.value).toBe(String(sent));
    }
  });

  it("closes an open form when the ceiling falls to zero under it", () => {
    // The 409 race: the guest was filling this in while another household took
    // the last one, and the section re-read the counts underneath them. Leaving
    // the form would leave `min="1"` beside `max="0"` and a Confirm that can only
    // be refused.
    const [gift, setGift] = createSignal<GiftRegistryItem>({
      ...ITEM,
      quantityWanted: 2,
      quantityClaimed: 1,
    });
    const { container } = render(() => (
      <GiftRegistryItemCard
        item={gift()}
        currency="AUD"
        imageBase={null}
        claim={undefined}
        canClaim={true}
        busy={false}
        onClaim={async () => false}
        onRelease={() => {}}
      />
    ));

    fireEvent.click(screen.getByRole("button", { name: "Reserve" }));
    expect(container.querySelector("form")).toBeTruthy();

    setGift({ ...ITEM, quantityWanted: 2, quantityClaimed: 2 });

    expect(container.querySelector("form")).toBeNull();
    expect(screen.queryByRole("button", { name: "Confirm" })).toBeNull();
  });

  it("is inline, never a fixed overlay — a transformed ancestor would trap one", () => {
    const { container } = renderCard();
    fireEvent.click(screen.getByRole("button", { name: "Reserve" }));
    const form = container.querySelector("form") as HTMLFormElement;
    expect(form.className).not.toMatch(/\bfixed\b/);
    expect(container.querySelector(".fixed")).toBeNull();
  });
});

describe("release", () => {
  it("offers release only to a household that holds a claim", () => {
    renderCard();
    expect(screen.queryByRole("button", { name: "Release" })).toBeNull();

    cleanup();
    const { onRelease } = renderCard({
      claim: { itemId: "gi-1", quantity: 1, status: "reserved", note: null, displayName: null },
    });
    fireEvent.click(screen.getByRole("button", { name: "Release" }));
    expect(onRelease).toHaveBeenCalledOnce();
  });
});

describe("the image", () => {
  it("asks the registry image route for the right variants", () => {
    const { container } = renderCard({
      imageBase: "https://api.test/api/invite/anita-and-ben/registry/image/registry-abc",
    });
    const img = container.querySelector("img") as HTMLImageElement;
    expect(img.getAttribute("src")).toContain("variant=card");
    expect(img.getAttribute("srcset")).toContain("variant=thumb 320w");
    expect(img.getAttribute("srcset")).toContain("variant=card 800w");
    // Decorative: the title beside it is the accessible name.
    expect(img.getAttribute("alt")).toBe("");
    expect(img.getAttribute("loading")).toBe("lazy");
  });

  it("renders no image element at all when the item has none", () => {
    const { container } = renderCard({ imageBase: null });
    expect(container.querySelector("img")).toBeNull();
  });

  /**
   * DRIFT GUARD. The aspect ratio exists twice: as the LITERAL `aspect-[4/3]`
   * inside the class string (Tailwind reads source as text, so a computed class
   * emits no CSS at all) and as the number the card reasons about. Neither can
   * be derived from the other at runtime, so assert they agree.
   */
  it("keeps GIFT_CARD_IMAGE_CLASS and GIFT_CARD_IMAGE_ASPECT in step", () => {
    const match = /aspect-\[(\d+)\/(\d+)\]/.exec(GIFT_CARD_IMAGE_CLASS);
    expect(match).not.toBeNull();
    const [, width, height] = match as RegExpExecArray;
    expect(Number(width) / Number(height)).toBeCloseTo(GIFT_CARD_IMAGE_ASPECT, 6);
  });
});
