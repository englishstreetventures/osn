import { clsx } from "@osn/ui/lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "@osn/ui/ui/popover";
import { For, type JSX } from "solid-js";

import { setThemePref, themePref, type ThemePref } from "../lib/theme";

function IconSystem() {
  return (
    <svg
      class="h-3.5 w-3.5"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.75"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </svg>
  );
}

function IconLight() {
  return (
    <svg
      class="h-3.5 w-3.5"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.75"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
    </svg>
  );
}

function IconDark() {
  return (
    <svg
      class="h-3.5 w-3.5"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.75"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9z" />
    </svg>
  );
}

const OPTIONS: { value: ThemePref; label: string; icon: () => JSX.Element }[] = [
  { value: "system", label: "System", icon: IconSystem },
  { value: "light", label: "Light", icon: IconLight },
  { value: "dark", label: "Dark", icon: IconDark },
];

export function ThemeToggle() {
  const current = () => OPTIONS.find((o) => o.value === themePref()) ?? OPTIONS[0];

  return (
    <Popover>
      <PopoverTrigger
        class="text-subtle hover:bg-muted hover:text-foreground flex h-7 w-7 cursor-pointer items-center justify-center rounded-lg transition-colors outline-none"
        aria-label={`Theme: ${current().label}`}
        title={`Theme: ${current().label}`}
      >
        {current().icon()}
      </PopoverTrigger>
      <PopoverContent class="rounded-card w-40 p-1">
        <For each={OPTIONS}>
          {(opt) => {
            const active = () => themePref() === opt.value;
            return (
              <button
                type="button"
                class={clsx(
                  "text-body flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors",
                  active()
                    ? "bg-muted text-foreground font-medium"
                    : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                )}
                onClick={() => setThemePref(opt.value)}
              >
                <span class={clsx(active() ? "text-foreground" : "text-subtle")}>{opt.icon()}</span>
                {opt.label}
              </button>
            );
          }}
        </For>
      </PopoverContent>
    </Popover>
  );
}
