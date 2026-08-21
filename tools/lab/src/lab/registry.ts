import type {
  Story,
  StoryEntry,
  StoryExport,
  StoryLayout,
  StoryMeta,
  StoryModule,
} from "./types.ts";

/**
 * Every `*.story.tsx` in the monorepo, wherever it lives. Local scratch
 * stories sit in `tools/lab/src/stories`; a story that belongs to a real
 * component sits next to that component and is picked up from here.
 *
 * The globs are literal on purpose — Vite resolves `import.meta.glob` at build
 * time and cannot see through a variable. Adding a workspace root means adding
 * a line.
 */
const modules = import.meta.glob<StoryModule>([
  "../stories/**/*.story.tsx",
  "../../../../osn/*/src/**/*.story.tsx",
  "../../../../pulse/*/src/**/*.story.tsx",
  "../../../../cire/*/src/**/*.story.tsx",
  "../../../../zap/*/src/**/*.story.tsx",
  "../../../../shared/*/src/**/*.story.tsx",
]);

/** A file that threw on import. Surfaced in the sidebar, not swallowed. */
export interface LoadFailure {
  file: string;
  error: string;
}

export interface Registry {
  entries: StoryEntry[];
  failures: LoadFailure[];
}

/**
 * `../../../../osn/ui/src/components/ui/button.story.tsx` → `osn/ui/components/ui/button`
 * `../stories/three-cube.story.tsx`                       → `lab/three-cube`
 *
 * The `/src/` segment carries no information a reader of the sidebar wants,
 * so it goes; the workspace prefix stays because that is the part that says
 * where the component actually lives.
 */
export function titleFromPath(path: string): string {
  return path
    .replace(/^(\.\.\/)+/, "")
    .replace(/\.story\.[jt]sx?$/, "")
    .replace("/src/", "/")
    .replace(/^stories\//, "lab/");
}

/**
 * Bare-component exports are the fast path for a spike; normalising them here
 * means the rest of the lab only ever deals with one shape.
 */
function toStory(value: StoryExport | StoryMeta | undefined): Story | undefined {
  if (typeof value === "function") return { render: value };
  if (value && "render" in value) return value;
  return undefined;
}

/**
 * Loads every story module in parallel. A file that fails to import becomes a
 * `LoadFailure` rather than taking the whole lab down with it — a half-written
 * spike is the normal state of this directory.
 */
export async function loadRegistry(): Promise<Registry> {
  const entries: StoryEntry[] = [];
  const failures: LoadFailure[] = [];

  await Promise.all(
    Object.entries(modules).map(async ([path, load]) => {
      let mod: StoryModule;
      try {
        mod = await load();
      } catch (error) {
        failures.push({
          file: path,
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }

      const meta = mod.meta ?? {};
      const title = meta.title ?? titleFromPath(path);

      for (const [exportName, value] of Object.entries(mod)) {
        if (exportName === "meta" || exportName === "default") continue;
        const story = toStory(value);
        if (!story) continue;

        const name = story.name ?? exportName;
        entries.push({
          id: `${title}/${exportName}`,
          title,
          name,
          file: path,
          story,
          layout: (story.layout ?? meta.layout ?? "centered") as StoryLayout,
        });
      }
    }),
  );

  // Two files can claim the same id — same `meta.title`, same export name.
  // The sidebar keys on id and selection looks up the first match, so the
  // second row would silently open the first row's story. Disambiguate with
  // the file path rather than dropping one, since both are real stories.
  const seen = new Map<string, number>();
  for (const entry of entries) {
    const count = seen.get(entry.id) ?? 0;
    seen.set(entry.id, count + 1);
    if (count > 0) entry.id = `${entry.id} (${entry.file})`;
  }

  entries.sort((a, b) => a.id.localeCompare(b.id));
  failures.sort((a, b) => a.file.localeCompare(b.file));
  return { entries, failures };
}

/** How many story files exist at all — told to the user when none of them parse. */
export const storyFileCount = Object.keys(modules).length;
