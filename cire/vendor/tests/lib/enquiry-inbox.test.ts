import { createRoot } from "solid-js";
import { describe, expect, it } from "vitest";

import type { VendorEnquiryListItem, VendorEnquiryPage } from "../../src/lib/enquiries-store";
import { createEnquiryInbox } from "../../src/lib/enquiry-inbox";

const row = (id: string, lastMessageAt: number, over: Partial<VendorEnquiryListItem> = {}) =>
  ({
    id,
    weddingId: "w1",
    directoryVendorId: "dv1",
    vendorId: "v1",
    zapChatId: null,
    status: "open",
    createdBy: "p1",
    quotedMinor: null,
    lastMessageAt,
    createdAt: 0,
    updatedAt: 0,
    vendorName: "Vendor",
    category: "florist",
    weddingName: `Wedding ${id}`,
    ...over,
  }) satisfies VendorEnquiryListItem;

const page = (enquiries: VendorEnquiryListItem[], nextCursor: string | null = null) =>
  ({ enquiries, nextCursor }) satisfies VendorEnquiryPage;

/** A fetcher answering from a queue of pages, recording the cursor of each call. */
function scripted(...answers: Array<VendorEnquiryPage | Error>) {
  const cursors: Array<string | undefined> = [];
  const fetchPage = async (cursor?: string) => {
    cursors.push(cursor);
    const next = answers.shift();
    if (next === undefined) throw new Error("no answer left");
    if (next instanceof Error) throw next;
    return next;
  };
  return { fetchPage, cursors };
}

/** A fetch the test settles by hand. */
function held() {
  let resolve!: (p: VendorEnquiryPage) => void;
  const promise = new Promise<VendorEnquiryPage>((r) => (resolve = r));
  return { promise, resolve };
}

const inboxOver = (fetchPage: (cursor?: string) => Promise<VendorEnquiryPage>) =>
  createRoot(() => createEnquiryInbox(fetchPage));

const ids = (rows: VendorEnquiryListItem[] | null) => rows?.map((r) => r.id) ?? null;

describe("createEnquiryInbox", () => {
  it("reads page one, then each next page by its cursor, newest first", async () => {
    const api = scripted(
      page([row("c", 300), row("b", 200)], "200.b"),
      page([row("a", 100)], null),
    );
    const inbox = inboxOver(api.fetchPage);

    await inbox.refresh();
    expect(ids(inbox.rows())).toEqual(["c", "b"]);
    expect(inbox.nextCursor()).toBe("200.b");

    await inbox.loadMore();
    expect(ids(inbox.rows())).toEqual(["c", "b", "a"]);
    expect(inbox.nextCursor()).toBeNull();
    expect(api.cursors).toEqual([undefined, "200.b"]);
  });

  it("reads as many pages again as it holds, so a vendor back from a thread keeps their place", async () => {
    const api = scripted(
      page([row("d", 400), row("c", 300)], "300.c"),
      page([row("b", 200), row("a", 100)], "100.a"),
      // Back from a thread: `b` gained a message, so it is on page one now.
      page([row("b", 500, { status: "quoted" }), row("d", 400)], "400.d"),
      page([row("c", 300), row("a", 100)], "100.a"),
    );
    const inbox = inboxOver(api.fetchPage);
    await inbox.refresh();
    await inbox.loadMore();

    await inbox.refresh();
    expect(ids(inbox.rows())).toEqual(["b", "d", "c", "a"]);
    expect(inbox.rows()!.find((r) => r.id === "b")!.status).toBe("quoted");
    expect(inbox.nextCursor()).toBe("100.a");
    expect(api.cursors).toEqual([undefined, "300.c", undefined, "400.d"]);
  });

  // An organisation the vendor has left, or a wedding a couple deleted: the API
  // stops returning its enquiries, and the inbox stops showing them.
  it("drops held rows the API no longer returns when it reads its pages again", async () => {
    const api = scripted(
      page([row("d", 400), row("c", 300)], "300.c"),
      page([row("b", 200), row("a", 100)], "100.a"),
      page([row("d", 400), row("b", 200)], null),
    );
    const inbox = inboxOver(api.fetchPage);
    await inbox.refresh();
    await inbox.loadMore();

    await inbox.refresh();
    expect(ids(inbox.rows())).toEqual(["d", "b"]);
    expect(inbox.nextCursor()).toBeNull();
  });

  it("takes page one as the whole inbox when it says there is no other", async () => {
    // Removed from the organisation: the API answers an empty last page.
    const api = scripted(
      page([row("b", 200)], "200.b"),
      page([row("a", 100)], "100.a"),
      page([], null),
    );
    const inbox = inboxOver(api.fetchPage);
    await inbox.refresh();
    await inbox.loadMore();

    await inbox.refresh();
    expect(inbox.rows()).toEqual([]);
    expect(inbox.nextCursor()).toBeNull();
  });

  it("replaces page one, not merges it, while only page one is held", async () => {
    const api = scripted(
      page([row("b", 200), row("a", 100)], "100.a"),
      page([row("c", 300), row("b", 200)], "200.b"),
    );
    const inbox = inboxOver(api.fetchPage);
    await inbox.refresh();

    await inbox.refresh();
    expect(ids(inbox.rows())).toEqual(["c", "b"]);
    expect(inbox.nextCursor()).toBe("200.b");
  });

  it("drops what it holds and says so when page one cannot be read", async () => {
    const api = scripted(page([row("a", 100)], "100.a"), new Error("500"));
    const inbox = inboxOver(api.fetchPage);
    await inbox.refresh();

    await inbox.refresh();
    expect(inbox.rows()).toBeNull();
    expect(inbox.failed()).toBe(true);
    expect(inbox.nextCursor()).toBeNull();
  });

  it("clears the inbox and says so when a next page cannot be read", async () => {
    const api = scripted(page([row("b", 200)], "200.b"), new Error("403"));
    const inbox = inboxOver(api.fetchPage);
    await inbox.refresh();

    await inbox.loadMore();
    expect(inbox.rows()).toBeNull();
    expect(inbox.failed()).toBe(true);
    expect(inbox.loadingMore()).toBe(false);
    expect(inbox.nextCursor()).toBeNull();
  });

  it("clears the error once a re-read succeeds", async () => {
    const api = scripted(new Error("500"), page([row("a", 100)], null));
    const inbox = inboxOver(api.fetchPage);
    await inbox.refresh();
    expect(inbox.failed()).toBe(true);

    await inbox.refresh();
    expect(inbox.failed()).toBe(false);
    expect(ids(inbox.rows())).toEqual(["a"]);
  });

  it("keeps only the newest of two overlapping re-reads", async () => {
    const first = held();
    const answers = [first.promise, Promise.resolve(page([row("new", 200)], null))];
    const inbox = inboxOver(() => answers.shift()!);

    const older = inbox.refresh();
    await inbox.refresh();
    first.resolve(page([row("old", 100)], null));
    await older;

    expect(ids(inbox.rows())).toEqual(["new"]);
  });

  it("asks once for a next page however often it is asked while one is on its way", async () => {
    const next = held();
    let calls = 0;
    const inbox = inboxOver(async (cursor) => {
      calls++;
      return cursor === undefined ? page([row("b", 200)], "200.b") : next.promise;
    });
    await inbox.refresh();

    const both = Promise.all([inbox.loadMore(), inbox.loadMore()]);
    next.resolve(page([row("a", 100)], null));
    await both;
    expect(calls).toBe(2);
    expect(ids(inbox.rows())).toEqual(["b", "a"]);
  });

  it("does not clear rows a newer re-read owns when an older next page fails", async () => {
    let failMore!: (err: unknown) => void;
    const more = new Promise<VendorEnquiryPage>((_, reject) => (failMore = reject));
    const pageOnes = [
      page([row("b", 200)], "200.b"),
      page([row("c", 300), row("b", 200)], "200.b"),
    ];
    const inbox = inboxOver((cursor) =>
      cursor === undefined ? Promise.resolve(pageOnes.shift()!) : more,
    );
    await inbox.refresh();

    const pending = inbox.loadMore();
    await inbox.refresh();
    failMore(new Error("network down"));
    await pending;

    expect(inbox.failed()).toBe(false);
    expect(ids(inbox.rows())).toEqual(["c", "b"]);
  });

  it("asks for nothing when there is no next page or nothing loaded yet", async () => {
    const api = scripted(page([row("a", 100)], null));
    const inbox = inboxOver(api.fetchPage);
    await inbox.loadMore();
    await inbox.refresh();
    await inbox.loadMore();
    expect(api.cursors).toEqual([undefined]);
  });

  it("drops a next page that lands after page one was read again", async () => {
    const next = held();
    const answers = [page([row("b", 200)], "200.b")];
    let calls = 0;
    const inbox = inboxOver(async (cursor) => {
      calls++;
      if (cursor !== undefined) return next.promise;
      return answers.shift() ?? page([row("c", 300), row("b", 200)], "200.b");
    });
    await inbox.refresh();

    const more = inbox.loadMore();
    await inbox.refresh();
    next.resolve(page([row("a", 100)], null));
    await more;

    expect(calls).toBe(3);
    expect(ids(inbox.rows())).toEqual(["c", "b"]);
    expect(inbox.nextCursor()).toBe("200.b");
  });

  it("orders rows from one second by id, greater first, as the API does", async () => {
    const api = scripted(
      page([row("m", 100), row("k", 100)], "100.k"),
      page([row("z", 100), row("j", 100)], null),
    );
    const inbox = inboxOver(api.fetchPage);
    await inbox.refresh();
    await inbox.loadMore();
    expect(ids(inbox.rows())).toEqual(["z", "m", "k", "j"]);
  });
});
