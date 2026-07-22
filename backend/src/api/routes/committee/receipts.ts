import type { CommitteeRouteExtension } from "./types.ts";
import { ROUTES } from "@robotmoney/contract";
import { getTakeReceipt } from "../../../committee/domain.ts";

/**
 * Route boundary reserved for issue #207's public take receipt endpoint.
 * It remains a no-op in the scout. The eventual response must follow the
 * read-time verification contract in
 * frontend/public/views/docs/investment-committee/api-reference.html.
 */
const TAKE_RE = new RegExp(
  `^${ROUTES.committee.take.replace(":id", "([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})")}$`,
  "i",
);

export const handleCommitteeReceiptRoutes: CommitteeRouteExtension = async (req, url) => {
  if (req.method !== "GET") return null;
  const match = url.pathname.match(TAKE_RE);
  if (!match) return null;
  const receipt = await getTakeReceipt(decodeURIComponent(match[1]));
  return receipt
    ? { status: 200, body: receipt }
    : { status: 404, body: { error: "not found" } };
};
