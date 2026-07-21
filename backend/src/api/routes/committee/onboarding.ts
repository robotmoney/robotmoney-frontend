import type { CommitteeRouteExtension } from "./types.ts";

/**
 * Route boundary reserved for issue #205's challenge and key-proof claim flow.
 * It remains a no-op in the scout. Keep its eventual behavior aligned with
 * frontend/public/views/docs/investment-committee/participation.html and
 * frontend/public/views/docs/investment-committee/api-reference.html.
 */
export const handleCommitteeOnboardingRoutes: CommitteeRouteExtension = async (_req, _url) => null;
