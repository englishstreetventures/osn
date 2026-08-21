import { Button } from "@osn/ui/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@osn/ui/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@osn/ui/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@osn/ui/ui/popover";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@osn/ui/ui/tabs";
import { createSignal } from "solid-js";

export const meta = { title: "osn/ui/overlays", layout: "padded" as const };

/**
 * Dialog, dropdown and popover content all render through a portal, into
 * `document.body` — so an open one escapes the preview pane and covers the
 * whole lab window. That is the component behaving correctly, and the price of
 * the lab having no iframe. Open the story with `?bare` (the toolbar's "open")
 * to see it against nothing else.
 */
export const DialogStory = () => (
  <Dialog>
    <DialogTrigger as={Button}>Open dialog</DialogTrigger>
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Leave this event?</DialogTitle>
      </DialogHeader>
      <div class="p-4">
        <DialogDescription>
          Your RSVP is removed and the host is told. You can rejoin while there is room.
        </DialogDescription>
      </div>
      <DialogFooter>
        <DialogClose as={Button} variant="outline">
          Stay
        </DialogClose>
        <DialogClose as={Button} variant="destructive">
          Leave
        </DialogClose>
      </DialogFooter>
    </DialogContent>
  </Dialog>
);

export const Dropdown = () => {
  const [picked, setPicked] = createSignal("—");
  return (
    <div class="flex flex-col gap-3">
      <DropdownMenu>
        <DropdownMenuTrigger as={Button} variant="outline">
          Account
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuLabel>Signed in as ada</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setPicked("Profile")}>Profile</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setPicked("Settings")}>Settings</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setPicked("Sign out")}>Sign out</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <p class="text-meta text-subtle">last chosen: {picked()}</p>
    </div>
  );
};

export const PopoverStory = () => (
  <Popover>
    <PopoverTrigger as={Button} variant="ghost">
      What is a handle?
    </PopoverTrigger>
    <PopoverContent>
      The name people find you by. It is yours across every app on the network, and you can change
      it later.
    </PopoverContent>
  </Popover>
);

export const TabsStory = () => (
  <Tabs defaultValue="going" class="max-w-md">
    <TabsList>
      <TabsTrigger value="going">Going</TabsTrigger>
      <TabsTrigger value="maybe">Maybe</TabsTrigger>
      <TabsTrigger value="invited">Invited</TabsTrigger>
      <TabsTrigger value="blocked" disabled>
        Disabled
      </TabsTrigger>
    </TabsList>
    <TabsContent value="going">
      <p class="text-body text-muted-foreground">Twelve people are going.</p>
    </TabsContent>
    <TabsContent value="maybe">
      <p class="text-body text-muted-foreground">Four are undecided.</p>
    </TabsContent>
    <TabsContent value="invited">
      <p class="text-body text-muted-foreground">Nine have not replied.</p>
    </TabsContent>
  </Tabs>
);
