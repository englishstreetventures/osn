// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The marketing site's closing field sends a couple here as `/?name=<their
 * names>`, so the create form opens with the names already in it. The name is
 * read from a link anyone can write, so what reaches the field is stripped of
 * control, direction and invisible characters, has each run of whitespace made
 * one space, is trimmed, and is cut to the length cire-api accepts. It only
 * ever fills the field: nothing submits until
 * the organiser presses the button, and the parameter is gone from the address
 * once read, so a reload or a second wedding starts empty.
 *
 * The real CreateWeddingForm, not the stub `WeddingList.test.tsx` uses: what
 * matters here is what lands in its field and what it sends.
 */

vi.mock("@shared/rp-auth/solid", async () => {
  const { rpAuthSolidMock } = await import("../test-support/mocks");
  return rpAuthSolidMock();
});
vi.mock("../../src/lib/api", async () => {
  const { organiserApiMock } = await import("../test-support/mocks");
  return organiserApiMock();
});

import type { WeddingSummary } from "../../src/components/CreateWeddingForm";
import WeddingList from "../../src/components/WeddingList";
import { authFetchMock, resetOrganiserMocks } from "../test-support/mocks";

const ONE: WeddingSummary[] = [
  {
    id: "wed_a",
    slug: "alice-bob",
    displayName: "Alice & Bob",
    role: "owner",
    entitlements: [],
    guestCap: 100,
  },
];

/** Arrive at the portal root with this query string. */
function arriveAt(search: string) {
  window.history.replaceState(null, "", `/${search}`);
}

function renderList(weddings: WeddingSummary[] = ONE) {
  return render(() => <WeddingList weddings={weddings} onSelect={vi.fn()} onCreated={vi.fn()} />);
}

function nameField(): HTMLInputElement | null {
  return screen.queryByRole("textbox", { name: "Wedding name" }) as HTMLInputElement | null;
}

describe("WeddingList, arriving with ?name=", () => {
  beforeEach(() => arriveAt(""));
  afterEach(() => {
    cleanup();
    resetOrganiserMocks();
    arriveAt("");
  });

  it("opens the create form with the names in the field, for an organiser who has weddings", () => {
    arriveAt("?name=Amara%20%26%20Sam");
    renderList();
    expect(nameField()?.value).toBe("Amara & Sam");
  });

  it("keeps the form closed when there is no name, as before", () => {
    renderList();
    expect(nameField()).toBeNull();
    expect(screen.getByRole("button", { name: /Create a wedding/i })).toBeTruthy();
  });

  it("drops the name from the address once read, so a second visit starts empty", () => {
    arriveAt("?name=Amara%20%26%20Sam&keep=1#/weddings");
    const first = renderList();
    expect(new URLSearchParams(window.location.search).has("name")).toBe(false);
    expect(window.location.search).toBe("?keep=1");
    expect(window.location.hash).toBe("#/weddings");

    // The same visit: cancelled, the form opens empty the next time.
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: /Create a wedding/i }));
    expect(nameField()?.value).toBe("");
    first.unmount();

    renderList();
    expect(nameField()).toBeNull();
  });

  it("cuts a long name to the length cire-api accepts, after trimming, never splitting a character", () => {
    // 118 letters and two emoji is 122 UTF-16 units; the first emoji fits in
    // 120 and the second does not, and half of it must not be left behind.
    const long = `${"a".repeat(118)}😀😀`;
    arriveAt(`?name=${encodeURIComponent(`   ${long}   `)}`);
    renderList();
    expect(nameField()?.value).toBe(`${"a".repeat(118)}😀`);

    cleanup();
    arriveAt(`?name=${encodeURIComponent(`  ${"b".repeat(130)}`)}`);
    renderList();
    expect(nameField()?.value).toBe("b".repeat(120));

    // A cut that lands just after a space leaves no trailing space behind.
    cleanup();
    arriveAt(`?name=${encodeURIComponent(`${"c".repeat(119)} de`)}`);
    renderList();
    expect(nameField()?.value).toBe("c".repeat(119));
  });

  it("strips control characters and direction overrides, for an organiser with no weddings yet", () => {
    // Built from code points: a direction override typed into source is
    // invisible and reorders the line around it.
    const [rlo, lri, pdi, rlm] = [0x202e, 0x2066, 0x2069, 0x200f].map((c) =>
      String.fromCodePoint(c),
    );
    arriveAt(`?name=${encodeURIComponent(`Amara${rlo} & ${lri}Sam${pdi}\u0007${rlm}`)}`);
    renderList([]);
    expect(nameField()?.value).toBe("Amara & Sam");

    // Nothing left once they are gone: no prefill, so the form stays shut for
    // an organiser who has weddings.
    cleanup();
    arriveAt(`?name=${encodeURIComponent(`${rlo}\u0007 ${rlm}`)}`);
    renderList();
    expect(nameField()).toBeNull();
  });

  it("collapses padding to one space, so a tail past the field's edge shows beside the names", () => {
    // 121 UTF-16 units as sent; 32 once the run of spaces is one. Collapsed
    // after the cut instead, the tail would be cut short.
    arriveAt(`?name=${encodeURIComponent(`Amara & Sam${" ".repeat(90)}RSVP at evil.example`)}`);
    renderList();
    expect(nameField()?.value).toBe("Amara & Sam RSVP at evil.example");
  });

  it("turns every other kind of space and line break into one space", () => {
    const [nbsp, ideographic, lineSep, paraSep, bel] = [0xa0, 0x3000, 0x2028, 0x2029, 0x07].map(
      (c) => String.fromCodePoint(c),
    );
    const cases: Array<[string, string]> = [
      [`Amara${nbsp}${nbsp}${nbsp}&${ideographic}Sam`, "Amara & Sam"],
      [`Amara${lineSep}&${paraSep}Sam`, "Amara & Sam"],
      ["Amara\t&\nSam", "Amara & Sam"],
      ["Amara\r\n&  \r\nSam", "Amara & Sam"],
      // A control between two spaces goes, and leaves one space, not two.
      [`Amara ${bel} & Sam`, "Amara & Sam"],
    ];
    for (const [sent, shown] of cases) {
      cleanup();
      arriveAt(`?name=${encodeURIComponent(sent)}`);
      renderList();
      expect(nameField()?.value).toBe(shown);
    }
  });

  it("strips zero-width and other invisible format characters", () => {
    // Each one, and both ends of each range: soft hyphen, Mongolian vowel
    // separator, zero-width space, word joiner to invisible plus, byte-order
    // mark, the interlinear annotation marks, and the tag characters.
    const invisible = [
      0xad, 0x180e, 0x200b, 0x2060, 0x2064, 0xfeff, 0xfff9, 0xfffb, 0xe0000, 0xe0041, 0xe007f,
    ];
    for (const code of invisible) {
      cleanup();
      const c = String.fromCodePoint(code);
      arriveAt(`?name=${encodeURIComponent(`Am${c}ara & S${c}am${c}`)}`);
      renderList();
      expect(nameField()?.value, `U+${code.toString(16).toUpperCase()}`).toBe("Amara & Sam");
    }
  });

  it("keeps the joiners a name needs: an emoji sequence and a Persian name", () => {
    const zwj = String.fromCodePoint(0x200d);
    const zwnj = String.fromCodePoint(0x200c);
    const couple = ["👩", "❤️", "👨"].join(zwj);
    const persian = `می${zwnj}خواهم`;
    arriveAt(`?name=${encodeURIComponent(`Amara & Sam ${couple} ${persian}`)}`);
    renderList();
    expect(nameField()?.value).toBe(`Amara & Sam ${couple} ${persian}`);
  });

  it("opens nothing for a name made only of invisible characters and spaces", () => {
    const [zwsp, wj, bom] = [0x200b, 0x2060, 0xfeff].map((c) => String.fromCodePoint(c));
    arriveAt(`?name=${encodeURIComponent(` ${zwsp}${wj} ${bom}${zwsp} `)}`);
    renderList();
    expect(nameField()).toBeNull();
  });

  it("puts markup in the field as text, never as HTML", () => {
    const markup = '<img src="x" onerror="alert(1)">Amara';
    arriveAt(`?name=${encodeURIComponent(markup)}`);
    const { container } = renderList();
    expect(nameField()?.value).toBe(markup);
    expect(container.querySelector("img")).toBeNull();
  });

  it("never submits on its own; the organiser's press sends the prefilled name", async () => {
    authFetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          wedding: { id: "wed_new", slug: "amara-sam-abc123", displayName: "Amara & Sam" },
        }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      ),
    );
    arriveAt("?name=Amara%20%26%20Sam");
    renderList();
    await Promise.resolve();
    expect(authFetchMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /Create wedding/i }));
    await waitFor(() => expect(authFetchMock).toHaveBeenCalledTimes(1));
    const [, init] = authFetchMock.mock.calls[0]!;
    expect((init as RequestInit).method).toBe("POST");
    expect(JSON.parse(String((init as RequestInit).body)).displayName).toBe("Amara & Sam");

    // Created: the form closes, and the next wedding starts with an empty field.
    await waitFor(() => expect(nameField()).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: /Create a wedding/i }));
    expect(nameField()?.value).toBe("");
  });
});
