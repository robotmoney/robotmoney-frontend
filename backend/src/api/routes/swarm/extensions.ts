import { handleSwarmOnboardingRoutes } from "./onboarding.ts";
import { handleSwarmReceiptRoutes } from "./receipts.ts";
import { handleSwarmWaitlistRoutes } from "./waitlist.ts";
import type { SwarmRouteExtension } from "./types.ts";

// Register concern-owned stubs once so downstream issues only edit their own
// module. Ordering is additive; an extension returns null for paths it does not
// own, preserving the existing swarm dispatcher behavior.
export const SWARM_ROUTE_EXTENSIONS: readonly SwarmRouteExtension[] = [
  handleSwarmOnboardingRoutes,
  handleSwarmReceiptRoutes,
  handleSwarmWaitlistRoutes,
];

