import { Button } from "@shared/ui/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@shared/ui/ui/dropdown-menu";
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

/**
 * The theme menu: one choice of three, on `@shared/ui`'s radio rows, so it
 * draws the account menu's row, focus and check, and tells assistive
 * technology which theme is on (`menuitemradio`, `aria-checked`).
 */
export function ThemeToggle() {
  const current = () => OPTIONS.find((o) => o.value === themePref()) ?? OPTIONS[0];
  const choose = (value: string) => {
    const option = OPTIONS.find((o) => o.value === value);
    if (option) setThemePref(option.value);
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        as={Button}
        variant="ghost"
        size="icon"
        class="h-7 w-7"
        aria-label={`Theme: ${current().label}`}
        title={`Theme: ${current().label}`}
      >
        {current().icon()}
      </DropdownMenuTrigger>
      <DropdownMenuContent class="w-40">
        <DropdownMenuRadioGroup value={themePref()} onChange={choose}>
          <For each={OPTIONS}>
            {(opt) => (
              <DropdownMenuRadioItem value={opt.value}>
                <span class="text-subtle mr-2.5 inline-flex">{opt.icon()}</span>
                {opt.label}
              </DropdownMenuRadioItem>
            )}
          </For>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
