// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import "@testing-library/jest-dom/vitest";
import { createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import RegistryImageField from "../../src/components/RegistryImageField";

const authFetch = vi.fn();
vi.mock("@shared/rp-auth/solid", () => ({ useAuth: () => ({ authFetch }) }));

const redirectToLogin = vi.fn();
vi.mock("../../src/lib/api", async () => {
  const actual = await vi.importActual<typeof import("../../src/lib/api")>("../../src/lib/api");
  return { ...actual, redirectToLogin: () => redirectToLogin() };
});

/** A `Response`-shaped stub — only the three members the field touches. */
function res(status: number, body: unknown = {}) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    blob: () => Promise.resolve(new Blob(["x"])),
  } as unknown as Response);
}

/** Renders the field around a signal, the way `RegistryView` holds it. */
function setup(initial: string | null = null) {
  const [key, setKey] = createSignal<string | null>(initial);
  render(() => (
    <RegistryImageField weddingId="wed_1" imageKey={key()} onChange={setKey} idPrefix="t" />
  ));
  return { key };
}

/** Paste a link and press the button that fetches the page. */
async function findPictures(url = "https://shop.example/pan") {
  fireEvent.click(screen.getByRole("button", { name: "Use a shop link" }));
  fireEvent.input(screen.getByLabelText("Shop link"), { target: { value: url } });
  fireEvent.click(screen.getByRole("button", { name: "Find pictures" }));
}

/** Drop a file on the upload input. happy-dom's `files` is read-only. */
function selectFile(file: File) {
  const input = screen.getByLabelText("Photo to upload") as HTMLInputElement;
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  fireEvent.change(input);
}

const preview = (images: string[], over: Record<string, unknown> = {}) => ({
  title: "Big Shop — copper pan",
  siteName: "Big Shop",
  images,
  ...over,
});

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  authFetch.mockReset();
  redirectToLogin.mockReset();
});

describe("RegistryImageField — the chooser", () => {
  it("opens one path at a time and says which is open", async () => {
    setup();
    expect(screen.queryByLabelText("Photo to upload")).toBeNull();
    expect(screen.queryByLabelText("Shop link")).toBeNull();

    const uploadTab = screen.getByRole("button", { name: "Upload a photo" });
    const linkTab = screen.getByRole("button", { name: "Use a shop link" });

    fireEvent.click(uploadTab);
    expect(screen.getByLabelText("Photo to upload")).toBeInTheDocument();
    expect(uploadTab).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByLabelText("Shop link")).toBeNull();

    fireEvent.click(linkTab);
    expect(screen.getByLabelText("Shop link")).toBeInTheDocument();
    expect(linkTab).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByLabelText("Photo to upload")).toBeNull();
  });
});

describe("RegistryImageField — the upload path", () => {
  it("posts the file and keeps the key the server answered with", async () => {
    authFetch.mockImplementation(() =>
      res(200, { imageKey: "assets/wed_1/registry-abc", imageUrl: "/x" }),
    );
    const { key } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Upload a photo" }));
    selectFile(new File(["png-bytes"], "pan.png", { type: "image/png" }));

    await waitFor(() => expect(key()).toBe("assets/wed_1/registry-abc"));
    const [url, init] = authFetch.mock.calls[0]!;
    expect(String(url)).toContain("/api/organiser/weddings/wed_1/registry/image");
    expect(String(url)).not.toContain("from-url");
    expect(init.method).toBe("POST");
    expect(init.headers["Content-Type"]).toBe("image/png");
  });

  it("refuses an over-cap file without spending a request", async () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Upload a photo" }));
    const big = new File([new Uint8Array(5 * 1024 * 1024 + 1)], "huge.png", { type: "image/png" });
    selectFile(big);

    expect(await screen.findByRole("alert")).toHaveTextContent(/over 5 MB/);
    expect(authFetch).not.toHaveBeenCalled();
  });

  it("says what is wrong when the server refuses the bytes", async () => {
    authFetch.mockImplementation(() => res(415, { error: "unsupported_image_type" }));
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Upload a photo" }));
    selectFile(new File(["<html>"], "page.png", { type: "image/png" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/JPEG, PNG or WebP/);
  });
});

describe("RegistryImageField — the link path", () => {
  it("shows the candidates as a radio group with names that tell them apart", async () => {
    authFetch.mockImplementation(() =>
      res(200, preview(["https://shop.example/a.jpg", "https://shop.example/b.jpg"])),
    );
    setup();
    await findPictures();

    const group = await screen.findByRole("radiogroup");
    expect(group).toBeInTheDocument();
    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(2);
    // Real words from the page, and no two the same.
    const names = radios.map((r) => r.getAttribute("aria-label"));
    expect(names).toEqual([
      "Picture 1 of 2 from Big Shop — copper pan",
      "Picture 2 of 2 from Big Shop — copper pan",
    ]);
    expect(new Set(names).size).toBe(2);
  });

  it("moves the selection with the arrow keys and keeps one tab stop", async () => {
    authFetch.mockImplementation(() =>
      res(
        200,
        preview([
          "https://shop.example/a.jpg",
          "https://shop.example/b.jpg",
          "https://shop.example/c.jpg",
        ]),
      ),
    );
    setup();
    await findPictures();

    const radios = await screen.findAllByRole("radio");
    // Nothing chosen yet: the group is still reachable by one Tab.
    expect(radios.filter((r) => r.getAttribute("tabindex") === "0")).toHaveLength(1);

    fireEvent.keyDown(radios[0]!, { key: "ArrowRight" });
    expect(radios[1]).toHaveAttribute("aria-checked", "true");
    expect(radios[0]).toHaveAttribute("aria-checked", "false");
    expect(radios.filter((r) => r.getAttribute("tabindex") === "0")).toHaveLength(1);

    // Wraps, rather than dead-ending.
    fireEvent.keyDown(radios[1]!, { key: "ArrowLeft" });
    expect(radios[0]).toHaveAttribute("aria-checked", "true");
    fireEvent.keyDown(radios[0]!, { key: "ArrowLeft" });
    expect(radios[2]).toHaveAttribute("aria-checked", "true");
    fireEvent.keyDown(radios[2]!, { key: "Home" });
    expect(radios[0]).toHaveAttribute("aria-checked", "true");
    fireEvent.keyDown(radios[0]!, { key: "End" });
    expect(radios[2]).toHaveAttribute("aria-checked", "true");
  });

  it("copies the chosen picture and answers with our key, not the shop's url", async () => {
    authFetch
      .mockImplementationOnce(() => res(200, preview(["https://shop.example/a.jpg"])))
      .mockImplementationOnce(() =>
        res(200, { imageKey: "assets/wed_1/registry-xyz", imageUrl: "/ours" }),
      );
    const { key } = setup();
    await findPictures();

    fireEvent.click(await screen.findByRole("radio"));
    fireEvent.click(screen.getByRole("button", { name: /Use this picture/ }));

    await waitFor(() => expect(key()).toBe("assets/wed_1/registry-xyz"));
    const [url, init] = authFetch.mock.calls[1]!;
    expect(String(url)).toContain("/registry/image/from-url");
    expect(JSON.parse(init.body)).toEqual({ url: "https://shop.example/a.jpg" });
  });

  it("says the page is being read while it is being read", async () => {
    let settle: ((r: unknown) => void) | null = null;
    authFetch.mockImplementation(
      () =>
        new Promise((resolve) => {
          settle = resolve;
        }),
    );
    setup();
    await findPictures();

    expect(await screen.findByRole("status")).toHaveTextContent(/Looking for pictures/);
    settle!(await res(200, preview(["https://shop.example/a.jpg"])));
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
  });

  it("treats a page with no pictures as a normal answer and offers the upload path", async () => {
    authFetch.mockImplementation(() => res(422, { error: "no_images_found" }));
    setup();
    await findPictures();

    // A note, not an alert — the organiser did nothing wrong.
    expect(await screen.findByText(/couldn't find a picture on that page/i)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Upload a photo" }));
    expect(screen.getByLabelText("Photo to upload")).toBeInTheDocument();
  });

  it.each([
    [400, { error: "blocked_url" }, /can't be opened from here/],
    [400, { error: "Missing or invalid fields" }, /full https:\/\/ address/],
    [415, { error: "unsupported_content_type" }, /isn't a web page we can read/],
    [429, { error: "Too many requests" }, /Wait a minute/],
    [502, { error: "preview_fetch_failed" }, /couldn't reach that page/],
  ])("maps a %i from the preview to something actionable", async (status, body, message) => {
    authFetch.mockImplementation(() => res(status, body));
    setup();
    await findPictures();

    expect(await screen.findByRole("alert")).toHaveTextContent(message);
  });

  it("maps a failed copy to its own message, separate from the preview's", async () => {
    authFetch
      .mockImplementationOnce(() => res(200, preview(["https://shop.example/a.jpg"])))
      .mockImplementationOnce(() => res(502, { error: "image_fetch_failed" }));
    setup();
    await findPictures();
    fireEvent.click(await screen.findByRole("radio"));
    fireEvent.click(screen.getByRole("button", { name: /Use this picture/ }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/couldn't download that picture/i);
  });

  it("sends the organiser to sign in again on a 401 rather than showing a message", async () => {
    authFetch.mockImplementation(() => res(401, { error: "Unauthorized" }));
    setup();
    await findPictures();

    await waitFor(() => expect(redirectToLogin).toHaveBeenCalled());
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("RegistryImageField — a candidate is untrusted input", () => {
  it("never renders a non-https candidate as an image or a link", async () => {
    authFetch.mockImplementation(() =>
      res(
        200,
        preview([
          "javascript:alert(1)",
          "http://shop.example/plain.jpg",
          "data:image/png;base64,AAAA",
          "https://shop.example/ok.jpg",
        ]),
      ),
    );
    const { container } = render(() => (
      <RegistryImageField weddingId="wed_1" imageKey={null} onChange={() => {}} idPrefix="u" />
    ));
    fireEvent.click(screen.getByRole("button", { name: "Use a shop link" }));
    fireEvent.input(screen.getByLabelText("Shop link"), {
      target: { value: "https://shop.example/pan" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Find pictures" }));

    const radios = await screen.findAllByRole("radio");
    expect(radios).toHaveLength(1);
    const srcs = [...container.querySelectorAll("img")].map((img) => img.getAttribute("src"));
    expect(srcs).toEqual(["https://shop.example/ok.jpg"]);
    // And nothing became a link at all.
    expect(container.querySelectorAll("a")).toHaveLength(0);
  });

  it("says the page had nothing when every candidate fails the scheme check", async () => {
    authFetch.mockImplementation(() =>
      res(200, preview(["javascript:alert(1)", "http://x/a.jpg"])),
    );
    setup();
    await findPictures();

    expect(await screen.findByText(/couldn't find a picture on that page/i)).toBeInTheDocument();
    expect(screen.queryByRole("radio")).toBeNull();
  });
});

describe("RegistryImageField — an item that already has a picture", () => {
  it("reads the thumbnail through authFetch, because the serve route is gated", async () => {
    authFetch.mockImplementation(() => res(200, {}));
    setup("assets/wed_1/registry-abc");

    await waitFor(() => expect(authFetch).toHaveBeenCalled());
    const [url] = authFetch.mock.calls[0]!;
    expect(String(url)).toContain("/api/organiser/weddings/wed_1/registry/image/registry-abc");
    // The 320px variant, not the 800px default — it paints into an 80px box (P-W4).
    expect(String(url)).toContain("?variant=thumb");
  });

  it("drops the key when the picture is removed", async () => {
    authFetch.mockImplementation(() => res(200, {}));
    const { key } = setup("assets/wed_1/registry-abc");

    fireEvent.click(await screen.findByRole("button", { name: "Remove picture" }));
    expect(key()).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove picture" })).toBeNull();
  });
});
