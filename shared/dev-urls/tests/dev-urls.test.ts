import { describe, expect, it } from "vitest";

import { DEV_APPS, devOriginList, devPort, devRpId, devUrl, devUrls } from "../src/index";

const portless = (url: string) => ({ PORTLESS_URL: url });

describe("devUrls", () => {
  it("falls back to fixed localhost ports with no PORTLESS_URL", () => {
    const urls = devUrls("@cire/host", {});
    expect(urls["@cire/api"]).toBe("http://localhost:8787");
    expect(urls["@osn/api"]).toBe("http://localhost:4000");
  });

  it("rebuilds sibling URLs from the caller's own portless URL", () => {
    const urls = devUrls("@cire/host", portless("https://host.cire.localhost"));
    expect(urls["@cire/api"]).toBe("https://api.cire.localhost");
    expect(urls["@cire/invites"]).toBe("https://invite.cire.localhost");
    expect(urls["@osn/api"]).toBe("https://id.musubi.localhost");
  });

  it("carries the worktree prefix onto every sibling", () => {
    const urls = devUrls("@cire/host", portless("https://my-branch.host.cire.localhost"));
    expect(urls["@cire/api"]).toBe("https://my-branch.api.cire.localhost");
    expect(urls["@osn/social"]).toBe("https://my-branch.musubi.localhost");
  });

  it("keeps a multi-label custom TLD", () => {
    const urls = devUrls("@osn/api", portless("https://id.musubi.local.test"));
    expect(urls["@osn/social"]).toBe("https://musubi.local.test");
    expect(urls["@pulse/web"]).toBe("https://pulse.local.test");
  });

  it("keeps a non-default proxy port", () => {
    const urls = devUrls("@pulse/web", portless("http://pulse.localhost:1355"));
    expect(urls["@pulse/api"]).toBe("http://api.pulse.localhost:1355");
  });

  it("does not match the app name inside a longer label", () => {
    // `cire` is a name in its own right; it must not match the `cire` inside
    // `api.cire.localhost` and yield a bogus prefix.
    const urls = devUrls("@cire/landing", portless("https://cire.localhost"));
    expect(urls["@cire/api"]).toBe("https://api.cire.localhost");
  });

  it("takes the app name from the right when a worktree prefix repeats it", () => {
    // A branch called `cire` puts `@cire/landing` on cire.cire.localhost. Read
    // left to right, the prefix looks like the name and every sibling comes out
    // as `<name>.cire.cire.localhost`, which resolves nowhere.
    const urls = devUrls("@cire/landing", portless("https://cire.cire.localhost"));
    expect(urls["@cire/api"]).toBe("https://cire.api.cire.localhost");
    expect(urls["@cire/landing"]).toBe("https://cire.cire.localhost");
  });

  it("falls back when the URL does not contain the caller's own name", () => {
    const urls = devUrls("@cire/host", portless("https://something-else.localhost"));
    expect(urls["@cire/api"]).toBe("http://localhost:8787");
  });

  it("falls back on an unparseable URL", () => {
    const urls = devUrls("@cire/host", portless("not a url"));
    expect(urls["@cire/api"]).toBe("http://localhost:8787");
  });

  it("covers every app in the map", () => {
    const urls = devUrls("@osn/api", portless("https://id.musubi.localhost"));
    expect(Object.keys(urls).toSorted()).toEqual(Object.keys(DEV_APPS).toSorted());
  });
});

describe("devUrl", () => {
  it("returns one sibling origin", () => {
    expect(devUrl("@osn/api", "@pulse/web", portless("https://pulse.localhost"))).toBe(
      "https://id.musubi.localhost",
    );
  });
});

describe("devRpId", () => {
  it("is plain localhost without portless", () => {
    expect(devRpId("@osn/api", {})).toBe("localhost");
  });

  it("is the shared parent of the account apps", () => {
    // Must be a suffix of both the app that creates the passkey
    // (musubi.localhost) and the API that verifies it (id.musubi.localhost).
    expect(devRpId("@osn/api", portless("https://id.musubi.localhost"))).toBe("musubi.localhost");
    expect(devRpId("@osn/social", portless("https://musubi.localhost"))).toBe("musubi.localhost");
  });

  it("drops the worktree prefix so one rpId covers every worktree", () => {
    expect(devRpId("@osn/api", portless("https://my-branch.id.musubi.localhost"))).toBe(
      "musubi.localhost",
    );
  });

  it("follows a custom TLD", () => {
    expect(devRpId("@osn/api", portless("https://id.musubi.local.test"))).toBe("musubi.local.test");
  });

  it("stays a suffix of both the app that enrols the passkey and the API that verifies it", () => {
    const rpId = devRpId("@osn/api", portless("https://my-branch.id.musubi.localhost"));
    for (const host of [
      "my-branch.musubi.localhost",
      "my-branch.id.musubi.localhost",
      "musubi.localhost",
      "id.musubi.localhost",
    ]) {
      expect(host === rpId || host.endsWith(`.${rpId}`)).toBe(true);
    }
  });
});

describe("devPort", () => {
  it("uses the port portless assigned", () => {
    expect(devPort(4321, { PORT: "4567" })).toBe(4567);
  });

  it("falls back without portless", () => {
    expect(devPort(4321, {})).toBe(4321);
  });

  it("falls back rather than binding somewhere nothing is proxied", () => {
    // An unusable PORT must not silently become port 0 (a random free port),
    // which portless would not be forwarding to.
    for (const port of ["", "0", "abc", "-1", "70000", "4321.5"]) {
      expect(devPort(4321, { PORT: port })).toBe(4321);
    }
  });
});

describe("devOriginList", () => {
  it("joins origins the way the *_ORIGIN vars expect", () => {
    expect(
      devOriginList(
        ["@osn/social", "@cire/host"],
        "@osn/api",
        portless("https://id.musubi.localhost"),
      ),
    ).toBe("https://musubi.localhost,https://host.cire.localhost");
  });
});
