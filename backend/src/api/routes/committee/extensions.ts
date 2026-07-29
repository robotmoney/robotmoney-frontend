import { handleCommitteeOnboardingRoutes } from "./onboarding.ts";
import { handleCommitteeReceiptRoutes } from "./receipts.ts";
import { handleCommitteeWaitlistRoutes } from "./waitlist.ts";
import type { CommitteeRouteExtension } from "./types.ts";

// Register concern-owned stubs once so downstream issues only edit their own
// module. Ordering is additive; an extension returns null for paths it does not
// own, preserving the existing committee dispatcher behavior.
export const COMMITTEE_ROUTE_EXTENSIONS: readonly CommitteeRouteExtension[] = [
  handleCommitteeOnboardingRoutes,
  handleCommitteeReceiptRoutes,
  handleCommitteeWaitlistRoutes,
];

