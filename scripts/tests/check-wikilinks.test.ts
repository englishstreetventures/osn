import { describe, expect, test } from "bun:test";

import { findBrokenWikilinks } from "../check-wikilinks";

// Vault-relative paths, as Obsidian sees them: the vault root is `wiki/`.
const VAULT = [
  "index.md",
  "README.md",
  "shared/component-library.md",
  "shared/observability/logging.md",
  "conventions/browser-tests.md",
  "compliance/index.md",
  "assets/diagram.png",
];

function broken(text: string): string[] {
  return findBrokenWikilinks(VAULT, [{ path: "wiki/page.md", text }]).map((link) => link.target);
}

describe("findBrokenWikilinks — what it reports", () => {
  test("a target written from the repository root, with a wiki/ prefix", () => {
    expect(broken("See [[wiki/shared/component-library]] §Overlays.")).toEqual([
      "wiki/shared/component-library",
    ]);
  });

  test("a target whose folder is wrong", () => {
    expect(broken("See [[osn/component-library]].")).toEqual(["osn/component-library"]);
  });

  test("a basename that is only the end of a real page's name", () => {
    expect(broken("See [[library]].")).toEqual(["library"]);
  });

  test("a folder that is only the end of a real folder's name", () => {
    expect(broken("See [[ared/component-library]].")).toEqual(["ared/component-library"]);
  });

  test("a broken link after a fence indented inside a list item", () => {
    const text = [
      "1. Run it:",
      "",
      "   ```bash",
      "   [[env.production.d1_databases]]",
      "   ```",
      "",
      "2. Then read [[no-such-page]].",
    ].join("\n");
    expect(broken(text)).toEqual(["no-such-page"]);
  });

  test("the line each broken link sits on, counted from 1", () => {
    const text = ["---", 'related: ["[[gone-page]]"]', "---", "", "Body [[also-gone]]."].join("\n");
    expect(findBrokenWikilinks(VAULT, [{ path: "wiki/page.md", text }])).toEqual([
      { path: "wiki/page.md", line: 2, target: "gone-page" },
      { path: "wiki/page.md", line: 5, target: "also-gone" },
    ]);
  });
});

describe("findBrokenWikilinks — what it lets through", () => {
  test("a bare page name", () => {
    expect(broken("See [[component-library]].")).toEqual([]);
  });

  test("a full vault path and a partial one", () => {
    expect(broken("[[shared/observability/logging]] and [[observability/logging]]")).toEqual([]);
  });

  test("a heading, a block, an alias and a table-escaped alias", () => {
    const text = [
      "[[browser-tests#Why a real browser]]",
      "[[logging#^redaction]]",
      "[[component-library|the library]]",
      "| [[browser-tests\\|browser tier]] | x |",
    ].join("\n");
    expect(broken(text)).toEqual([]);
  });

  test("a same-page heading link", () => {
    expect(broken("Back to [[#Overview]].")).toEqual([]);
  });

  test("a fenced TOML array header and a wikilink inside a code span", () => {
    const text = [
      "```toml",
      "[[env.production.d1_databases]]",
      "```",
      "Quoted: `[[wiki/shared/observability/logging]]`.",
    ].join("\n");
    expect(broken(text)).toEqual([]);
  });

  test("a link that differs from the page name only in case", () => {
    expect(broken("[[Component-Library]] and [[SHARED/Observability/Logging]]")).toEqual([]);
  });

  test("an embed of a non-markdown file in the vault", () => {
    expect(broken("![[diagram.png]]")).toEqual([]);
  });

  test("a bare name two pages share", () => {
    expect(broken("[[index]] and [[README]]")).toEqual([]);
  });
});
