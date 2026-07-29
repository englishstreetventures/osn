import { useAuth } from "@osn/client/solid";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@osn/ui/ui/dropdown-menu";
import { createMemo, type JSX } from "solid-js";

import { getTokenClaims } from "../lib/utils";

/**
 * The signed-in account dropdown (handle label · switch profile · log out),
 * shared by the desktop rail and the mobile top bar. The caller supplies the
 * trigger's content and styling; the menu itself is identical in both shells.
 */
export function AccountMenu(props: {
  triggerClass?: string;
  onSwitchProfile: () => void;
  children: JSX.Element;
}) {
  const { session, logout } = useAuth();
  const claims = createMemo(() => getTokenClaims(session()?.accessToken ?? null));

  return (
    <DropdownMenu>
      <DropdownMenuTrigger class={props.triggerClass}>{props.children}</DropdownMenuTrigger>
      <DropdownMenuContent class="w-52">
        <DropdownMenuGroup>
          <DropdownMenuLabel class="text-muted-foreground font-normal">
            @{claims().handle ?? "..."}
          </DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => props.onSwitchProfile()}>Switch profile</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => logout()}>Log out</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
