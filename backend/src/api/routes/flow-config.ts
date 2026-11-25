// The deposit queue feature (PR 1658, issue 1614) is dormant until the owner sets FLOW_QUEUE_ADDRESS and
// FLOW_FUND_ADDRESS (v0.10.0 production leaves them empty, issue 1693). Every flow route calls
// flowDisabled() before any database or RPC work, so an unconfigured deployment answers cleanly.

/** True when both contract settings are set. */
export function flowConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(env.FLOW_QUEUE_ADDRESS?.trim()) && Boolean(env.FLOW_FUND_ADDRESS?.trim());
}

/** The clean answer of a dormant data route: 404, no database read, no RPC call. */
export function flowDisabled(): Response {
  return Response.json({ schemaVersion: 1, enabled: false, error: "flow feature is not enabled" }, { status: 404, headers: { "Cache-Control": "no-store" } });
}
