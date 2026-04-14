import { useAuth } from "@osn/client/solid";
import { createSignal, Show } from "solid-js";

import { Button } from "../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { CreateProfileForm } from "./CreateProfileForm";

const DISMISSED_KEY = "@osn/ui:profile_onboarding_dismissed";

export interface ProfileOnboardingProps {
  checkHandle?: (handle: string) => Promise<{ available: boolean }>;
  dismissible?: boolean;
}

export function ProfileOnboarding(props: ProfileOnboardingProps) {
  const { session, profiles } = useAuth();

  const [dismissed, setDismissed] = createSignal(localStorage.getItem(DISMISSED_KEY) === "1");
  const [showCreate, setShowCreate] = createSignal(false);

  function dismiss() {
    setDismissed(true);
    localStorage.setItem(DISMISSED_KEY, "1");
  }

  const visible = () => session() && profiles()?.length === 1 && !dismissed();

  return (
    <Show when={visible()}>
      <Card>
        <CardHeader>
          <div class="flex items-center justify-between">
            <CardTitle>Add another profile</CardTitle>
            <Show when={props.dismissible}>
              <Button variant="ghost" size="sm" onClick={dismiss} aria-label="Dismiss">
                &#10005;
              </Button>
            </Show>
          </div>
        </CardHeader>
        <CardContent>
          <p class="text-muted-foreground mb-3 text-sm">
            Profiles let you separate personal and professional presence. Create a second profile to
            try it out.
          </p>
          <Button size="sm" onClick={() => setShowCreate(true)}>
            Create profile
          </Button>
        </CardContent>
      </Card>

      <Dialog open={showCreate()} onOpenChange={setShowCreate}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create a new profile</DialogTitle>
          </DialogHeader>
          <div class="p-4">
            <CreateProfileForm
              checkHandle={props.checkHandle}
              onSuccess={() => setShowCreate(false)}
              onCancel={() => setShowCreate(false)}
            />
          </div>
        </DialogContent>
      </Dialog>
    </Show>
  );
}
