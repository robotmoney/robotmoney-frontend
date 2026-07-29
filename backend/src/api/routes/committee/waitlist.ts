import { ROUTES } from "@robotmoney/contract";
import { sql } from "../../../db/client.ts";
import { isEmail, readJsonObject } from "../../validation.ts";
import type { CommitteeRouteResult } from "./types.ts";

export async function handleCommitteeWaitlistRoutes(
  req: Request,
  url: URL,
): Promise<CommitteeRouteResult | null> {
  const p = url.pathname;
  const m = req.method;

  if (m === "POST" && p === ROUTES.committee.waitlist) {
    const body = await readJsonObject(req);
    const emailRaw = body?.email;
    const email = typeof emailRaw === "string" ? emailRaw : "";
    const norm = email.trim().toLowerCase();
    if (!isEmail(norm)) {
      return { status: 400, body: { error: "valid email required" } };
    }
    const source = typeof body?.source === "string" ? body.source.trim() : "apply-page";
    await sql`
      INSERT INTO committee_waitlist (email, email_norm, source)
      VALUES (${email}, ${norm}, ${source})
      ON CONFLICT (email_norm) DO UPDATE SET created_at = now(), notified_at = NULL`;
    return { status: 201, body: { ok: true } };
  }

  return null;
}
