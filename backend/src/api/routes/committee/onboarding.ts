import { ROUTES } from "@robotmoney/contract";
import * as ic from "../../../committee/domain.ts";
import { readJsonObject, requiredString } from "../../validation.ts";
import type { CommitteeRouteExtension } from "./types.ts";

// GET /api/committee/apply/:id — docs/architecture.md §11 R2. Public, redacted
// application-status read: the id is the ONLY thing the server minted at apply
// time, and this is where the applicant (or the status page polling on their
// behalf) watches applied → approved → claimed. No contact/name/publicKey is
// ever echoed back. An unknown id and one that was simply never issued are
// indistinguishable 404s — ic.getApplicationStatus returns null for both.
const APPLY_STATUS_PREFIX = `${ROUTES.committee.apply}/`;

function templateRe(template: string, paramRe: Record<string, string> = {}): RegExp {
  return new RegExp(`^${template.replace(/:([a-zA-Z_]+)/g, (_, k: string) => paramRe[k] ?? "[^/]+")}$`);
}

const RE_APPLICATION_STATUS = templateRe(ROUTES.committee.applicationStatus);

/**
 * Onboarding routes (issue #205's challenge/key-proof claim flow, plus the
 * public privacy-safe application-status read added in issue #237). Keep behavior
 * aligned with frontend/public/views/docs/investment-committee/participation.html and
 * frontend/public/views/docs/investment-committee/api-reference.html.
 */
export const handleCommitteeOnboardingRoutes: CommitteeRouteExtension = async (req, url) => {
  if (req.method === "GET" && RE_APPLICATION_STATUS.test(url.pathname)) {
    const parts = url.pathname.split("/");
    const id = decodeURIComponent(parts[4] ?? "");
    if (!id || id.includes("/")) return { status: 404, body: { error: "not found" } };
    return { status: 200, body: await ic.getApplicationStatus(id) };
  }

  if (req.method === "GET" && url.pathname.startsWith(APPLY_STATUS_PREFIX)) {
    const id = decodeURIComponent(url.pathname.slice(APPLY_STATUS_PREFIX.length));
    if (!id || id.includes("/")) return { status: 404, body: { error: "not found" } };
    const status = await ic.getApplyStatus(id);
    return status ? { status: 200, body: status } : { status: 404, body: { error: "not found" } };
  }

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
