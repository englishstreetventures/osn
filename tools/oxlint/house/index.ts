import { eslintCompatPlugin } from "@oxlint/plugins";

import { noBaseVariantAtCallSiteRule } from "./rules/no-base-variant-at-call-site.ts";
import { noInOperatorKeyGuardRule } from "./rules/no-in-operator-key-guard.ts";
import { noModuleScopeProcessEnvRule } from "./rules/no-module-scope-process-env.ts";
import { noNonSubscribingStoreReadRule } from "./rules/no-non-subscribing-store-read.ts";
import { noStackedDocBlockRule } from "./rules/no-stacked-doc-block.ts";
import { noTrackerRefInCommentRule } from "./rules/no-tracker-ref-in-comment.ts";
import { noUnboundedInArrayRule } from "./rules/no-unbounded-in-array.ts";

/** House Oxlint rules — repo-specific rules, kept out of the vendored anti-slop tree. */
const housePlugin = eslintCompatPlugin({
  meta: { name: "house" },
  rules: {
    "no-base-variant-at-call-site": noBaseVariantAtCallSiteRule,
    "no-in-operator-key-guard": noInOperatorKeyGuardRule,
    "no-module-scope-process-env": noModuleScopeProcessEnvRule,
    "no-non-subscribing-store-read": noNonSubscribingStoreReadRule,
    "no-stacked-doc-block": noStackedDocBlockRule,
    "no-tracker-ref-in-comment": noTrackerRefInCommentRule,
    "no-unbounded-in-array": noUnboundedInArrayRule,
  },
});

export default housePlugin;
