import { ROUTES } from "@robotmoney/contract";
import { sql } from "../../../db/client.ts";
import { on, registerQuery } from "../../../db/registry.ts";
import { isEmail, readJsonObject } from "../../validation.ts";
import type { SwarmRouteResult } from "./types.ts";

// The one statement is a registered query (smoke-production-spec.md §7.1),
// reached only through POST /api/swarm/waitlist.
const joinWaitlist = registerQuery({
  role: "rm_app",
  object: "swarm_waitlist",
  // UPDATE for the re-signup's ON CONFLICT DO UPDATE; SELECT because
  // ON CONFLICT (email_norm) reads the arbiter column.
  privileges: ["INSERT", "UPDATE", "SELECT"],
  site: "src/api/routes/swarm/waitlist:join",
  purpose: "Record one waitlist signup, or refresh its timestamp when the normalized email is already on the list.",
  callers: ["src/api/routes/swarm/waitlist"],
  probe: {
    statement: `INSERT INTO swarm_waitlist (email, email_norm, source) VALUES ($1, $2, $3)
      ON CONFLICT (email_norm) DO UPDATE SET created_at = now()`,
    params: ["Probe@Example.com", "probe@example.com", "apply-page"],
  },
});

export async function handleSwarmWaitlistRoutes(
  req: Request,
  url: URL,
): Promise<SwarmRouteResult | null> {
  const p = url.pathname;
  const m = req.method;

  if (m === "POST" && p === ROUTES.swarm.waitlist) {
    const body = await readJsonObject(req);
    const emailRaw = body?.email;
    const email = typeof emailRaw === "string" ? emailRaw : "";
    const norm = email.trim().toLowerCase();
    if (!isEmail(norm)) {
      return { status: 400, body: { error: "valid email required" } };
    }
    const source = typeof body?.source === "string" ? body.source.trim() : "apply-page";
    await on(sql, joinWaitlist)`
      INSERT INTO swarm_waitlist (email, email_norm, source)
      VALUES (${email}, ${norm}, ${source})
      ON CONFLICT (email_norm) DO UPDATE SET created_at = now()`;
    return { status: 201, body: { ok: true } };
  }

  return null;
}
