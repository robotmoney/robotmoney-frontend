import { handleSwarmOnboardingRoutes } from "./onboarding.ts";
import { handleSwarmReceiptRoutes } from "./receipts.ts";
import { handleSwarmWaitlistRoutes } from "./waitlist.ts";
import { handleSchedulerStream } from "../swarm-stream.ts";
import { handleJudgeParticipant } from "../swarm-judge-participant.ts";
import type { SwarmRouteExtension } from "./types.ts";

// Register concern-owned stubs once so downstream issues only edit their own
// module. Ordering is additive; an extension returns null for paths it does not
// own, preserving the existing swarm dispatcher behavior.
export const SWARM_ROUTE_EXTENSIONS: readonly SwarmRouteExtension[] = [
  handleSwarmOnboardingRoutes,
  handleSwarmReceiptRoutes,
  handleSwarmWaitlistRoutes,
  // Both of these can return a live `Response` rather than a {status, body}
  // envelope, which is why they are extensions rather than branches of
  // swarm-admin.ts: an event-stream body never ends and must not be re-wrapped.
  // They are two DIFFERENT contracts on two different credentials — the
  // scheduler's automation token, and a judge's participant bearer — and each
  // module's header says why they are not one mechanism.
  (req, url) => handleSchedulerStream(req, url),
  handleJudgeParticipant,
];

