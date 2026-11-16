// Trimmed copies of the files a real release on main touched, for the tests of
// how the release planner reads a version commit. The merge is ed7813d0a
// (`Button` presses in @shared/ui). The Release workflow then pushed two bot
// commits: 355c9c2e9, which `changeset version` wrote (each package's
// `version`, a CHANGELOG entry, the consumed changeset deleted), and 9689d29c9,
// in which the next run's `bun install` rewrote each workspace's `version`
// line in bun.lock. The lint-warning ceiling line is 43d82674f's, a version
// commit that also lowered it. Every version line, changelog entry and
// lockfile entry below is copied from those commits; the files are cut down
// to the fields around them.

/** Each package's version before the release and after it, from 355c9c2e9. */
export const BEFORE = { ui: "0.15.3", authUi: "6.0.0", social: "0.23.0", infra: "0.4.0" } as const;
export const AFTER = { ui: "0.16.0", authUi: "6.0.1", social: "0.23.1", infra: "0.5.0" } as const;

export type Versions = { readonly [K in keyof typeof BEFORE]: string };

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/** shared/ui/package.json, with `edit` applied to the parsed object. */
export function uiManifest(
  version: string,
  edit: (manifest: Record<string, unknown>) => void = () => {},
): string {
  const manifest: Record<string, unknown> = {
    name: "@shared/ui",
    version,
    private: true,
    type: "module",
    exports: {
      "./ui/button": "./src/ui/button.tsx",
      "./ui/orb": { types: "./src/ui/orb-api.ts", default: "./src/ui/orb.tsx" },
    },
    scripts: {
      test: "bunx --bun vitest --project unit",
      "test:run": "bunx --bun vitest run --project unit",
    },
    dependencies: {
      "@kobalte/core": "^0.13.14",
      "class-variance-authority": "^0.7.1",
      clsx: "^2.1.1",
    },
    devDependencies: {
      "@shared/design-tokens": "workspace:*",
      "@shared/typescript-config": "workspace:*",
    },
    peerDependencies: { "solid-js": ">=1.9" },
  };
  edit(manifest);
  return json(manifest);
}

export const authUiManifest = (version: string): string =>
  json({
    name: "@osn/auth-ui",
    version,
    private: true,
    type: "module",
    dependencies: {
      "@osn/client": "workspace:*",
      "@shared/toast": "workspace:*",
      "@shared/ui": "workspace:*",
      "@simplewebauthn/browser": "^14.0.0",
    },
  });

export const socialManifest = (version: string): string =>
  json({
    name: "@musubi/social",
    version,
    private: true,
    description: "Musubi — identity and social graph app, built on OSN",
    type: "module",
    scripts: { build: "vite build" },
    dependencies: {
      "@osn/auth-ui": "workspace:*",
      "@shared/ui": "workspace:*",
      "solid-js": "^1.9.18",
    },
  });

/** musubi/infra/package.json: a stack's own path, versioned like any package (81297894e). */
export const infraManifest = (version: string): string =>
  json({
    name: "@musubi/infra",
    version,
    private: true,
    type: "module",
    dependencies: { "@alchemy.run/cloudflare": "2.0.0-beta.85" },
  });

const CLSX =
  '["clsx@2.1.1", "", {}, "sha512-eYm0QWBtUrBWZWG0d386OGAw16Z995PiOVo2B7bjWSbHedGl5e0ZWaq65kOGgUSNesEIDkB9ISbTg/JK9dhCZA=="]';

/**
 * The root bun.lock as bun writes it — JSONC, with trailing commas — holding
 * the four workspaces at `versions`. `uiDependencies` and `packages` add
 * lines, as `bun add` would.
 */
export function lockfile(
  versions: Versions,
  extra: { readonly uiDependencies?: string; readonly packages?: string } = {},
): string {
  return `{
  "lockfileVersion": 1,
  "configVersion": 1,
  "workspaces": {
    "": {
      "name": "osn",
      "devDependencies": {
        "@changesets/cli": "^3.0.3",
      },
    },
    "musubi/infra": {
      "name": "@musubi/infra",
      "version": "${versions.infra}",
      "dependencies": {
        "@alchemy.run/cloudflare": "2.0.0-beta.85",
      },
    },
    "musubi/social": {
      "name": "@musubi/social",
      "version": "${versions.social}",
      "dependencies": {
        "@osn/auth-ui": "workspace:*",
        "@shared/ui": "workspace:*",
        "solid-js": "^1.9.18",
      },
    },
    "osn/auth-ui": {
      "name": "@osn/auth-ui",
      "version": "${versions.authUi}",
      "dependencies": {
        "@osn/client": "workspace:*",
        "@shared/toast": "workspace:*",
        "@shared/ui": "workspace:*",
        "@simplewebauthn/browser": "^14.0.0",
      },
    },
    "shared/ui": {
      "name": "@shared/ui",
      "version": "${versions.ui}",
      "dependencies": {
        "@kobalte/core": "^0.13.14",
        "class-variance-authority": "^0.7.1",
        "clsx": "^2.1.1",${extra.uiDependencies ?? ""}
      },
    },
  },
  "overrides": {
    "brace-expansion": "^5.0.11",
  },
  "packages": {
    "@musubi/social": ["@musubi/social@workspace:musubi/social"],
    "@osn/auth-ui": ["@osn/auth-ui@workspace:osn/auth-ui"],
    "@shared/ui": ["@shared/ui@workspace:shared/ui"],
    "class-variance-authority": ["class-variance-authority@0.7.1", "", { "dependencies": { "clsx": "^2.1.1" } }, "sha512-Ka+9Trutv7G8M6WT6SeiRWz792K5qEqIGEGzXKhAE6xOWAY6pPH8U+9IY3oCMv6kqTmLsv7Xh/2w2RigkePMsg=="],
    "clsx": ${CLSX},${extra.packages ?? ""}
  }
}
`;
}

/** The clsx entry's integrity hash, for a test that edits it by hand. */
export const CLSX_HASH =
  "sha512-eYm0QWBtUrBWZWG0d386OGAw16Z995PiOVo2B7bjWSbHedGl5e0ZWaq65kOGgUSNesEIDkB9ISbTg/JK9dhCZA==";

/** The changeset the merge added and 355c9c2e9 consumed. */
export const CHANGESET_PATH = ".changeset/shared-button-press.md";
export const CHANGESET = `---
"@shared/ui": minor
"@musubi/social": patch
"@osn/auth-ui": patch
---

\`Button\` presses: while a pointer or a held Space presses it, it scales to 0.97 over \`--ui-dur-fast\` on \`--ui-ease-out\` and eases back when let go.
`;

/** A package's CHANGELOG.md before the release, and after 355c9c2e9 added its entry. */
export function changelog(name: string, version: string, entry?: string): string {
  const added =
    entry === undefined ? "" : `## ${version}\n\n### Patch Changes\n\n- ed7813d: ${entry}\n\n`;
  return `# ${name}\n\n${added}## 0.0.1\n\n### Patch Changes\n\n- 0000000: First release.\n`;
}

/** scripts/lint-warning-ceiling.txt, as 43d82674f lowered it. */
export const ceiling = (count: number): string =>
  `# One value, alone on the first non-comment, non-blank line — nothing else\n# in this file is read.\n\n${count}   # lowered by scripts/guard-lint-warnings.sh --lower-to, 2026-11-15\n`;

/** The tree before the merge: what production and dev both run at first. */
export function released(): Record<string, string> {
  return {
    "shared/ui/package.json": uiManifest(BEFORE.ui),
    "shared/ui/CHANGELOG.md": changelog("@shared/ui", BEFORE.ui),
    "shared/ui/src/ui/button.tsx": "export const press = 1;\n",
    "osn/auth-ui/package.json": authUiManifest(BEFORE.authUi),
    "osn/auth-ui/CHANGELOG.md": changelog("@osn/auth-ui", BEFORE.authUi),
    "musubi/social/package.json": socialManifest(BEFORE.social),
    "musubi/social/CHANGELOG.md": changelog("@osn/social", BEFORE.social),
    "musubi/infra/package.json": infraManifest(BEFORE.infra),
    "musubi/infra/CHANGELOG.md": changelog("@musubi/infra", BEFORE.infra),
    "musubi/infra/src/stack.ts": "export const workers = 3;\n",
    "bun.lock": lockfile(BEFORE),
    "scripts/lint-warning-ceiling.txt": ceiling(363),
  };
}

/** The merge: a change to shared/ui's source, and its changeset. */
export function merge(): Record<string, string> {
  return {
    "shared/ui/src/ui/button.tsx": "export const press = 0.97;\n",
    [CHANGESET_PATH]: CHANGESET,
  };
}

/** A merge that changes only the musubi stack's own declaration, and its changeset. */
export function stackMerge(): Record<string, string> {
  return {
    "musubi/infra/src/stack.ts": "export const workers = 4;\n",
    [CHANGESET_PATH]: '---\n"@musubi/infra": minor\n---\n\nThe stack declares a fourth Worker.\n',
  };
}

/** What `changeset version` wrote: versions, changelog entries, the ceiling. The changeset is deleted. */
export function versionPackages(): Record<string, string | null> {
  const entry = "`Button` presses scale to 0.97 while held.";
  return {
    "shared/ui/package.json": uiManifest(AFTER.ui),
    "shared/ui/CHANGELOG.md": changelog("@shared/ui", AFTER.ui, entry),
    "osn/auth-ui/package.json": authUiManifest(AFTER.authUi),
    "osn/auth-ui/CHANGELOG.md": changelog("@osn/auth-ui", AFTER.authUi, entry),
    "musubi/social/package.json": socialManifest(AFTER.social),
    "musubi/social/CHANGELOG.md": changelog("@osn/social", AFTER.social, entry),
    "musubi/infra/package.json": infraManifest(AFTER.infra),
    "musubi/infra/CHANGELOG.md": changelog("@musubi/infra", AFTER.infra, entry),
    "scripts/lint-warning-ceiling.txt": ceiling(362),
    [CHANGESET_PATH]: null,
  };
}

/** What the next Release run's `bun install` wrote: the workspace versions in bun.lock. */
export function versionLockfile(): Record<string, string> {
  return { "bun.lock": lockfile(AFTER) };
}
