import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GuestEmailBox } from "../../src/components/GuestEmailBox";
import type { FamilyMember, MemberEmail } from "../../src/components/types";
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

  describe("after the RSVP deadline", () => {
    const hostsAdded: MemberEmail = { address: "ada@example.test", source: "organiser_attested" };

    // An address is not a reply, but the hosts have stopped taking them: the
    // page shows what is on file and the way to remove it, and nothing to add.
    it("offers removal of a stored address and no way to change it", async () => {
      const onChange = vi.fn();
      render(() => (
        <GuestEmailBox
          apiUrl="https://api.test"
          member={ada}
          email={hostsAdded}
          closed
          onChange={onChange}
          onMemberRequired={() => {}}
        />
      ));
      expect(screen.getByText("ada@example.test")).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Change email" })).toBeNull();
      expect(screen.queryByLabelText("Your email, Ada")).toBeNull();
      expect(screen.getByRole("status").textContent).toMatch(/RSVPs have closed/);
      expect(document.body.textContent).not.toMatch(/Change it if/);
      expect(document.body.textContent).toMatch(/Remove it to stop wedding emails to it/);

      fetchMock.mockResolvedValueOnce(Response.json({ email: null }));
      fireEvent.click(screen.getByRole("button", { name: "Remove email" }));
      await waitFor(() => expect(onChange).toHaveBeenCalledWith(null));
      // The removal is announced, nothing offers to add the address again,
      // and the heading holds focus.
      expect(screen.getByRole("status").textContent).toMatch(/won’t email that address/);
      expect(screen.getByRole("status").textContent).not.toMatch(/add it again/);
      // With the form gone, the note keeps the reason beside it.
      expect(screen.getByRole("status").textContent).toMatch(/RSVPs have closed/);
      expect(screen.queryByLabelText("Your email, Ada")).toBeNull();
      await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading")));
    });

    // The clock passes the deadline under a guest who is typing: the form goes,
    // the closed line is announced, and focus lands on the heading, not the page.
    it("closes the form under a guest who is typing and moves focus to the heading", async () => {
      const [closed, setClosed] = createSignal(false);
      render(() => (
        <GuestEmailBox
          apiUrl="https://api.test"
          member={ada}
          email={null}
          closed={closed()}
          onChange={() => {}}
          onMemberRequired={() => {}}
        />
      ));
      const field = screen.getByLabelText("Your email, Ada");
      field.focus();
      expect(document.activeElement).toBe(field);
      setClosed(true);
      await waitFor(() => expect(screen.queryByLabelText("Your email, Ada")).toBeNull());
      expect(screen.getByRole("status").textContent).toMatch(/RSVPs have closed/);
      expect(document.activeElement).toBe(screen.getByRole("heading"));
    });

    // A page that loads closed has nothing to rescue focus from, and a guest
    // who is somewhere else on the page when the deadline passes keeps their place.
    it("moves focus to the heading only from the box or from nowhere", async () => {
      const loadedClosed = render(() => (
        <GuestEmailBox
          apiUrl="https://api.test"
          member={ada}
          email={null}
          closed
          onChange={() => {}}
          onMemberRequired={() => {}}
        />
      ));
      expect(document.activeElement).not.toBe(screen.getByRole("heading"));
      loadedClosed.unmount();

      const [closed, setClosed] = createSignal(false);
      const elsewhere = document.createElement("button");
      document.body.append(elsewhere);
      render(() => (
        <GuestEmailBox
          apiUrl="https://api.test"
          member={ada}
          email={null}
          closed={closed()}
          onChange={() => {}}
          onMemberRequired={() => {}}
        />
      ));
      elsewhere.focus();
      setClosed(true);
      await waitFor(() => expect(screen.queryByLabelText("Your email, Ada")).toBeNull());
      expect(document.activeElement).toBe(elsewhere);
      elsewhere.remove();
    });

    // Only the server's own closed answer closes the box: any other 403 is an
    // ordinary failure, and the form stays for another try.
    it("keeps the form after a 403 that is not the deadline's", async () => {
      render(() => (
        <GuestEmailBox
          apiUrl="https://api.test"
          member={ada}
          email={null}
          onChange={() => {}}
          onMemberRequired={() => {}}
        />
      ));
      fireEvent.input(screen.getByLabelText("Your email, Ada"), {
        target: { value: "ada@example.test" },
      });
      fireEvent.click(screen.getByRole("checkbox", { name: /emails about this wedding/ }));
      fetchMock.mockResolvedValueOnce(Response.json({ error: "not_a_guest" }, { status: 403 }));
      fireEvent.click(screen.getByRole("button", { name: "Add email" }));
      await waitFor(() =>
        expect(screen.getByRole("alert").textContent).toMatch(/Couldn’t save your email/),
      );
      expect(screen.getByLabelText("Your email, Ada")).toBeTruthy();
    });

    // The page's clock can run behind the server's: the server's refusal is the
    // verdict, and the form goes instead of inviting a retry.
    it("closes the form when the server says RSVPs have closed", async () => {
      render(() => (
        <GuestEmailBox
          apiUrl="https://api.test"
          member={ada}
          email={null}
          onChange={() => {}}
          onMemberRequired={() => {}}
        />
      ));
      fireEvent.input(screen.getByLabelText("Your email, Ada"), {
        target: { value: "ada@example.test" },
      });
      fireEvent.click(screen.getByRole("checkbox", { name: /emails about this wedding/ }));
      fetchMock.mockResolvedValueOnce(Response.json({ error: "rsvp_closed" }, { status: 403 }));
      fireEvent.click(screen.getByRole("button", { name: "Add email" }));
      await waitFor(() => expect(screen.queryByLabelText("Your email, Ada")).toBeNull());
      expect(screen.getByRole("status").textContent).toMatch(/RSVPs have closed/);
    });
  });
});
