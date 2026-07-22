import { ROUTES } from "@robotmoney/contract";
import * as ic from "../../../committee/domain.ts";
import { readJsonObject, requiredString } from "../../validation.ts";
import type { CommitteeRouteExtension } from "./types.ts";

/**
 * Route boundary reserved for issue #205's challenge and key-proof claim flow.
 * It remains a no-op in the scout. Keep its eventual behavior aligned with
 * frontend/public/views/docs/investment-committee/participation.html and
 * frontend/public/views/docs/investment-committee/api-reference.html.
 */
export const handleCommitteeOnboardingRoutes: CommitteeRouteExtension = async (req, url) => {
  if (req.method === "POST" && url.pathname === ROUTES.committee.claimChallenge) {
    const body = await readJsonObject(req);
    const memberId = body && requiredString(body, "memberId", 100);
    if (!memberId) return { status: 400, body: { error: "memberId required" } };
    return { status: 200, body: await ic.issueTokenClaimChallenge(memberId) };
  }

  if (req.method === "POST" && url.pathname === ROUTES.committee.claimToken) {
    const body = await readJsonObject(req);
    const memberId = body && requiredString(body, "memberId", 100);
    const challenge = body && requiredString(body, "challenge", 200);
    const expiresAt = body && requiredString(body, "expiresAt", 40);
    const signature = body && requiredString(body, "signature", 2000);
    if (!memberId || !challenge || !expiresAt || !signature) {
      return { status: 400, body: { error: "memberId, challenge, expiresAt, and signature required" } };
    }
    const result = await ic.claimMemberToken({ memberId, challenge, expiresAt, signature });
    return { status: result.status, body: result };
  }

  return null;
};
