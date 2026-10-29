import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GuestEmailBox } from "../../src/components/GuestEmailBox";
import type { FamilyMember } from "../../src/components/types";
import { description } from "../test-support/described";

const ada: FamilyMember = {
  guestId: "g-ada",
  firstName: "Ada",
  lastName: "Okafor",
  nickname: null,
  eventIds: [],
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("GuestEmailBox", () => {
  // The browser passed the address and the server refused it: the line under
  // the box says so, and the field names it, since the field is what to fix.
  // A failure that is not the address's leaves the field unmarked.
  it("names the email box by the server's address refusal, and only by that", async () => {
    render(() => (
      <GuestEmailBox
        apiUrl="https://api.test"
        member={ada}
        email={null}
        onChange={() => {}}
        onMemberRequired={() => {}}
      />
    ));
    const field = screen.getByLabelText("Your email, Ada");
    // The browser's own check names the field by its own sentence.
    fireEvent.input(field, { target: { value: "ada@" } });
    fireEvent.blur(field);
    expect(field.getAttribute("aria-describedby")?.split(" ")).toHaveLength(1);
    expect(description(field)).toMatch(/look like one email address/);
    expect(field.getAttribute("aria-invalid")).toBe("true");

    fireEvent.input(field, { target: { value: "ada@example.test" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /emails about this wedding/ }));
    expect(field.hasAttribute("aria-describedby")).toBe(false);
    expect(field.hasAttribute("aria-invalid")).toBe(false);

    fetchMock.mockResolvedValueOnce(Response.json({ error: "invalid_email" }, { status: 400 }));
    fireEvent.click(screen.getByRole("button", { name: "Add email" }));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toMatch(/look like one email address/),
    );
    expect(description(field)).toMatch(/look like one email address/);
    expect(field.getAttribute("aria-invalid")).toBe("true");

    // Both at once: the browser's sentence joins the server's line, and
    // neither replaces the other.
    fireEvent.input(field, { target: { value: "ada@" } });
    fireEvent.blur(field);
    expect(field.getAttribute("aria-describedby")?.split(" ")).toHaveLength(2);
    fireEvent.input(field, { target: { value: "ada@example.test" } });

    fetchMock.mockResolvedValueOnce(new Response(null, { status: 500 }));
    fireEvent.click(screen.getByRole("button", { name: "Add email" }));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toMatch(/Couldn’t save your email/),
    );
    expect(field.hasAttribute("aria-describedby")).toBe(false);
    expect(field.hasAttribute("aria-invalid")).toBe(false);
  });
});
