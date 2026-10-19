import {
  physicalName,
  refuseProductionTier,
  type SiteWorkerInput,
  type StageHosts,
} from "@shared/infra";

export interface PulseDeclaration {
  readonly pulseLanding: SiteWorkerInput;
}

/**
 * Every name, domain and setting the pulse stack declares at `stage`: pulse
 * landing, a static site whose Worker also serves `GET /api/geo`. Pure; the
 * host comes from `hosts`. The production tier is refused until its stack is
 * declared.
 *
 * The site's build reads `PUBLIC_APP_URL`, the Pulse app every "Find events"
 * link points at. The Pulse app has no dev deploy, so the dev build leaves it
 * unset and the links keep the build's local default.
 */
export function pulseDeclaration(input: {
  readonly stage: string;
  readonly hosts: StageHosts;
}): PulseDeclaration {
  const { stage, hosts } = input;
  refuseProductionTier(stage);
  return {
    pulseLanding: {
      name: physicalName(
        { base: "pulse-landing", dev: "pulse-landing-dev", production: "pulse-landing" },
        stage,
      ),
      stage,
      directory: "../landing/dist",
      // A built `_redirects` would apply; the site ships none.
      redirectsFile: true,
      // `/api/*` reaches the entry module, which answers `/api/geo` and hands
      // every other path to the assets. No Wrangler config to match, so it
      // takes Alchemy's defaults: no compatibility flags, and the module
      // registry Alchemy gives a bundled Worker.
      entry: {
        main: "../landing/worker/index.ts",
        compatibility: { date: "2026-08-31", flags: [] },
        runWorkerFirst: ["/api/*"],
      },
      domain: hosts.pulseLanding,
      workersDev: false,
      htmlHandling: "auto-trailing-slash",
      // pulse/landing builds no 404.html (its pages are index, privacy and
      // terms), so an unknown path is a plain 404.
      notFoundHandling: "none",
      issues: true,
    },
  };
}
