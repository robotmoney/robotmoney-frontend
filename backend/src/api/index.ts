// HTTP entrypoint. Uses Bun's native server (Bun.serve) — no framework. This
// process answers the JSON API ONLY: the marketing/SPA/docs site is served by
// the sibling `website-server` nginx image (issue #892), which proxies /api/
// and /health here so a single-box deployment still presents as one origin.
import { ROUTES } from "@robotmoney/contract";
import { config, assertNoVaultAddressCollision, warnIfStrategyVaultsUnconfigured } from "../config.ts";
import { isDatabaseUnavailable, sql } from "../db/client.ts";
import { assertHandleNamespaceClean, handleNamespaceGuardOutcome } from "../db/handle-namespace.ts";
import { appendOnlyGuardOutcome, assertAppendOnlyGuardArmed } from "../db/append-only-guard.ts";
import { readStaticIdentity } from "../ops/static-identity.ts";
import { buildIdentityJson } from "../ops/build-identity.ts";
import { apiVersionResponse } from "../ops/api-version.ts";
import { analyticsLedgerGuardOutcome, assertAnalyticsLedgerGuardArmed } from "../db/analytics-ledger-guard.ts";
import { runStartupPreflight } from "../db/preflight.ts";
import { createComment, listComments } from "./routes/comments.ts";
import { getRegimeSnapshots, getRegimeSnapshotsSummary, getResearchSignal, getVaultEconomics, getWalletBalances, getBuybacks, getTokenMetrics, getWalletSleeves, getAllocation, getEntities, getMarketOverview, getList2, getLeaderboard, getActivityLog, getAgentsDirectory, getAgentDetail, getCoinsList, getVaultsList, getWalletsList, getCoinProfile, getVaultProfile, getWalletProfile } from "./routes/dashboards.ts";
import { createSubmission } from "./routes/submissions.ts";
import { getProjectDetail, getProjects, updateProjectOverview } from "./routes/projects.ts";
import { handleSwarm } from "./routes/swarm.ts";
import { handleAdmin } from "./routes/admin.ts";
import { handleAdminWebauthn } from "./routes/admin-webauthn.ts";
import { handleAnalytics } from "./routes/analytics.ts";
import { corsPreflightResponse, withCors } from "./cors.ts";
import { resolveClientIp } from "./client-ip.ts";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Config-time double-count guard (issue #84): refuse to boot if a prop-wallet
// address collides with the vault/adapter set (their shares are the OTHER half
// of Total AUM, valued by vault-economics), or if a tracked asset is the rmUSDC
// vault share. Fail-closed at startup — a misconfiguration must never serve a
// live-looking double-counted number.
assertNoVaultAddressCollision();

// Config-time completeness WARNING (issue #642, decision D37): an empty
// STRATEGY_VAULT_*_ADDRESS list makes ZYFAI-SS1/GIZA-SS1 NAV idle-USDC-only,
// omitting every deployed vault position. Deliberately NOT a refusal to boot —
// see warnIfStrategyVaultsUnconfigured() for why the sibling collision guard
// throws and this one does not. The per-leg wire flag
// (WalletHolding.strategyNavIdleOnly) carries the same fact to consumers.
warnIfStrategyVaultsUnconfigured();

// Data-time namespace guard (issue #602): refuse to serve a database in which
// one member's handle is another member's id, because /swarm/members/<name>
// then addresses two members. Migration 0031's trigger blocks every WRITE that
// would create the pair, but a pg_restore loads rows before the trigger exists
// and re-running the migration's install-time check is impossible once 0031 is
// already in schema_migrations — so a restored violation can only be caught
// here. THIS is the process `docker compose up -d` starts (docker-compose.yml's
// api service runs `bun run src/api/index.ts`); it invokes neither migrate nor
// scripts/db-preflight.ts, which is why placing the guard in either of those
// alone would have missed the documented bring-up entirely.
//
// Runs BEFORE Bun.serve, so a refused boot binds no port. Fail-closed on a
// violation only: an empty database, one whose schema predates 0030, and one
// with no swarm_members table all pass (handleNamespaceConflicts returns []).
//
// BOUNDED, because this now sits between the process and its port: the check
// runs on its own connection with server-side statement/lock/connect timeouts
// and a hard wall-clock budget (NAMESPACE_GUARD_BUDGET_MS, 8000ms by default,
// validated so a malformed PG_NAMESPACE_GUARD_TIMEOUT_MS cannot un-bound it),
// so the worst
// case it can add to a boot is that budget — including against a database that
// accepts the connection and then blocks, which is what an ACCESS EXCLUSIVE
// lock on swarm_members does. An unbounded version of this line would be a
// silent total outage: this process serves the static frontend too, and
// `restart: unless-stopped` does not restart a process that hangs rather than
// exits. Its outcome is reported at /health (`handle_namespace`), and
// RM_ALLOW_HANDLE_NAMESPACE_VIOLATION=1 turns the refusal into a loud warning.
await assertHandleNamespaceClean();

// Append-only guard check (issue #684): refuse to serve a database whose
// migration 0032 triggers are recorded as applied but are no longer refusing
// deletion. Same population path as the namespace guard above — a pg_restore
// loads rows before the post-data section installs triggers, and the restored
// schema_migrations already names 0032, so migrate() will never re-apply it —
// plus one the namespace guard has no analogue for: the role in DATABASE_URL
// owns rm_append_only_guard(), so a single CREATE OR REPLACE disarms all of it
// while every trigger still exists and still reads tgenabled='A'.
//
// It therefore ATTEMPTS A DELETE (`... WHERE false`, which removes nothing in
// either outcome) and requires the guard's own message, instead of counting
// triggers — an inventory passes cleanly against a fully disarmed database.
//
// Bounded by the same short-lived client the namespace guard uses, for the same
// reason: this sits between the process and its port. A database that has never
// had 0032 applied is NOT refused (that is an ordinary first boot); one that
// records it as applied and does not honour it is. Outcome at /health
// (`append_only_guard`), and RM_ALLOW_UNARMED_APPEND_ONLY_GUARD=1 turns the
// refusal into a loud warning.
await assertAppendOnlyGuardArmed();
// Issue #979 AC6: the Phase A analytics ledger's own immutability guards
// (source/run/output/cutover, migrations 0057-0060) are a DISTINCT trigger
// family from migration 0032's rm_append_only_guard() above and must be
// checked independently — see backend/src/db/analytics-ledger-guard.ts.
await assertAnalyticsLedgerGuardArmed();

// PREFLIGHT CHECKS 1-3 AGAINST THIS PROCESS'S OWN CREDENTIAL (spec §7.2,
// #1026 criterion 44). `api` holds rm_app and nothing else, and it refuses to
// serve a database whose rm_app password does not authenticate (1), whose
// rm_app grants miss what this program's registered queries need or hold
// anything from the denylist (2), or whose schema has drifted from the manifest
// stored in it, is mid-migration, or is at a version this image does not
// support (3). Last before Bun.serve on purpose: every import above has run, so
// check 2 judges the registry of exactly the program about to serve, and a
// refusal binds no port. Bounded (STARTUP_PREFLIGHT_DEFAULT_BUDGET_MS), because
// it sits between the process and its port and a hung boot is never restarted.
//
// The one exception is RM_ENV=ephemeral, the in-process test harness's env: it
// logs the same refusal lines and serves. No stack reaches it — the §4.3 policy
// (deploy-policy.ts) refuses `ephemeral`, and every compose file hands the api
// `prod` or `stage` (acceptance-path.ts resolveStackRmEnv) — and the harness
// spawns this entrypoint against superuser-built databases for tests whose
// subject is something else (tests/preload.ts states why the harness is not
// §7.3-isomorphic). Under every env a stack can run, a refusal exits 1.
// backend/tests/container-startup-preflight.test.ts spawns this file as rm_app
// and proves each refusal leaves no listener.
{
  const startup = await runStartupPreflight({ role: "rm_app", databaseUrl: config.databaseUrl, rmEnv: config.env });
  for (const line of startup.lines) (startup.passed ? console.log : console.error)(line);
  if (!startup.passed) {
    if (config.env !== "ephemeral") process.exit(1);
    console.error("startup_preflight: serving anyway: RM_ENV=ephemeral is the test harness's env, never a stack's");
  }
}

const server = Bun.serve({
  port: config.apiPort,
  async fetch(req, server) {
    const url = new URL(req.url);
    const { pathname } = url;

    if (req.method === "OPTIONS") return corsPreflightResponse(req, pathname);

    // Client ip for rate limiting. See client-ip.ts's resolveClientIp() for
    // the trust/parsing rules — TRUST_PROXY=1 only when a known proxy (now
    // website-server, issue #892) sits in front of this process.
    const peer = server.requestIP(req)?.address || "";
    const clientIp = resolveClientIp(peer, config.trustProxy, req.headers.get("x-forwarded-for"));

    try {
      return withCors(await route(req, url, pathname, clientIp), req, pathname);
    } catch (err) {
      // Malformed percent-encoding (decodeURIComponent) → 400; anything else →
      // a sanitized 500 (never leak a stack). No unhandled rejections from fetch.
      if (err instanceof URIError) return withCors(json({ error: "bad request" }, 400), req, pathname);
      // The database being unreachable is not a handler bug, and answering it
      // as one (`500 internal error`) told nobody anything: the page printed
      // the envelope verbatim, and an operator could not tell an outage from a
      // defect without shelling into the container (issue #968). 503 is the
      // honest status — the condition is transient and the api itself is fine
      // — and the reason is named so the SPA can say "database unavailable"
      // rather than "internal error". Narrow by construction: a bad query
      // still reports as a 500 (see isDatabaseUnavailable).
      if (isDatabaseUnavailable(err)) {
        console.error("api error (database unavailable):", err);
        return withCors(json({ error: "database unavailable" }, 503), req, pathname);
      }
      console.error("api error:", err);
      return withCors(json({ error: "internal error" }, 500), req, pathname);
    }
  },
});

async function route(req: Request, url: URL, pathname: string, clientIp: string): Promise<Response> {
    // D54: the API's contract version, FIRST — ahead of /health and of every
    // branch below that can touch the database, so a Postgres outage never
    // reaches it. No auth by design: the website checks it at load, before it
    // has any session, and the body is two public constants.
    if (pathname === ROUTES.apiVersion && req.method === "GET") {
      return apiVersionResponse();
    }

    if (pathname === ROUTES.health) {
      let db = "down";
      try { await sql`SELECT 1`; db = "up"; } catch { db = "down"; }
      // handle_namespace reports what the BOOT guard concluded, so an
      // "unchecked" boot (database unqueryable through the guard's budget) or
      // an overridden one is machine-readable and not merely a log line that
      // rotates away — nothing in this deployment scrapes container logs. The
      // STATUS CODE stays 200 in every case on purpose: the compose healthcheck
      // keys on `.ok`, and failing it because a database was slow at boot would
      // trade a wrong-attribution risk for a restart loop.
      return json({
        status: "ok",
        env: config.env,
        db,
        handle_namespace: handleNamespaceGuardOutcome(),
        // "armed" | "disarmed" | "not_applied" | "unavailable" | "unchecked".
        // Reported for the same reason as handle_namespace: a log line is not a
        // detection path here (nothing scrapes container logs, and the json-file
        // buffer rotates), and "disarmed" is reachable while serving via
        // RM_ALLOW_UNARMED_APPEND_ONLY_GUARD=1. The status CODE stays 200 in
        // every case — the compose healthcheck keys on `.ok`.
        append_only_guard: appendOnlyGuardOutcome(),
        // WHICH SOURCE THIS PROCESS WAS BUILT FROM (AC-ID-03). Carried here as
        // well as at /version so an existing health check gains the identity
        // without a second request; both read the one resolver, so they cannot
        // disagree. `null` with a named reason when the image was built without
        // its identity — never a package version or a timestamp standing in for
        // one (backend/src/ops/build-identity.ts).
        build: buildIdentityJson(),
        // AND WHICH FRONTEND IT IS SERVING (T26). The api co-serves the SPA
        // from STATIC_DIR, a read-only bind of a directory assembled on the
        // deploy host outside this image — `build` above says nothing about it,
        // so a redeploy that rebuilt the image and skipped `bun run
        // static:assemble` passed every identity check while serving the
        // previous release's HTML. `matches_image` is that drift, as a boolean.
        static: readStaticIdentity(config.staticDir),
        analytics_ledger_guard: analyticsLedgerGuardOutcome(),
      });
    }

    // AC-ID-03 — the build identity on its own, for the check that is a string
    // comparison against the RC tag and SHA of AC-ID-01. Separate from /health
    // because the two answer different questions and fail for different
    // reasons: /health is a liveness probe whose body varies with database and
    // guard state, while this is a constant for the life of the process.
    if (pathname === ROUTES.version) {
      // Flat, plus `static` — the SPA half of AC-ID-03 (T26). Both halves in
      // one body because the check runbook §7 describes is one `curl` and a
      // comparison, and the question "is the frontend this API serves the same
      // release as the API" cannot be answered from two requests that raced a
      // redeploy.
      return json({ ...buildIdentityJson(), static: readStaticIdentity(config.staticDir) });
    }

    if (pathname === ROUTES.comments.list && req.method === "GET") {
      return json(await listComments(url));
    }

    if (pathname === ROUTES.comments.create && req.method === "POST") {
      const body = await req.json().catch(() => null);
      const r = await createComment(body, clientIp);
      return json(r.body, r.status);
    }

    if (pathname === ROUTES.dashboards.regimeSnapshots && req.method === "GET") {
      return json(
        url.searchParams.get("view") === "summary"
          ? await getRegimeSnapshotsSummary()
          : await getRegimeSnapshots(url),
      );
    }

    if (pathname === ROUTES.dashboards.vaultEconomics && req.method === "GET") {
      return json(await getVaultEconomics());
    }

    if (pathname === ROUTES.dashboards.walletBalances && req.method === "GET") {
      return json(await getWalletBalances());
    }

    if (pathname === ROUTES.dashboards.buybacks && req.method === "GET") {
      return json(await getBuybacks());
    }

    if (pathname === ROUTES.dashboards.tokenMetrics && req.method === "GET") {
      return json(await getTokenMetrics());
    }

    if (pathname === ROUTES.dashboards.walletSleeves && req.method === "GET") {
      return json(await getWalletSleeves());
    }

    if (pathname === ROUTES.dashboards.allocation && req.method === "GET") {
      return json(await getAllocation());
    }

    if (pathname === ROUTES.dashboards.entities && req.method === "GET") {
      return json(await getEntities());
    }

    if (pathname === ROUTES.dashboards.overview && req.method === "GET") {
      return json(await getMarketOverview());
    }

    if (pathname === ROUTES.dashboards.list2 && req.method === "GET") {
      return json(await getList2());
    }

    if (pathname === ROUTES.dashboards.leaderboard && req.method === "GET") {
      return json(await getLeaderboard());
    }

    // Public /submit intake (issue #393, §5.17) — anonymous, rate-limited per ip.
    if (pathname === ROUTES.dashboards.submissions && req.method === "POST") {
      const body = await req.json().catch(() => null);
      const r = await createSubmission(body, clientIp);
      return json(r.body, r.status);
    }

    if (pathname === ROUTES.dashboards.activity && req.method === "GET") {
      return json(await getActivityLog());
    }

    if (pathname === ROUTES.dashboards.agents && req.method === "GET") {
      return json(await getAgentsDirectory());
    }

    // /agents/:id "Money-agent dossier" (issue #390, §5.8, P3.2). Checked
    // after the exact-match /agents directory route above so it only ever
    // catches a genuine sub-path segment.
    if (pathname.startsWith("/api/dashboards/agents/") && req.method === "GET") {
      const id = decodeURIComponent(pathname.slice("/api/dashboards/agents/".length));
      const detail = await getAgentDetail(id);
      return json(detail ?? { error: "not found" }, detail ? 200 : 404);
    }

    // Analytics-dashboard directory list feeds (issue #386) — a distinct
    // feature area from the treasury-dashboard reads above, sharing only the
    // route namespace.
    if (pathname === ROUTES.dashboards.coins && req.method === "GET") {
      return json(await getCoinsList());
    }

    if (pathname === ROUTES.dashboards.vaults && req.method === "GET") {
      return json(await getVaultsList());
    }

    if (pathname === ROUTES.dashboards.wallets && req.method === "GET") {
      return json(await getWalletsList());
    }

    // Coin/vault/wallet detail dossiers (issue #391, §5.10/§5.12/§5.14). Same
    // startsWith + trailing-segment pattern as research-signals above; a
    // fetch* returning null (not found or a malformed id) is a clean 404.
    // Checked AFTER the exact-match LIST routes directly above so a bare
    // "/api/dashboards/coins" (no trailing segment) never falls through here.
    if (pathname.startsWith("/api/dashboards/coins/") && req.method === "GET") {
      const id = decodeURIComponent(pathname.slice("/api/dashboards/coins/".length));
      const r = await getCoinProfile(id);
      return json(r ?? { error: "not found" }, r ? 200 : 404);
    }

    if (pathname.startsWith("/api/dashboards/vaults/") && req.method === "GET") {
      const id = decodeURIComponent(pathname.slice("/api/dashboards/vaults/".length));
      const r = await getVaultProfile(id);
      return json(r ?? { error: "not found" }, r ? 200 : 404);
    }

    if (pathname.startsWith("/api/dashboards/wallets/") && req.method === "GET") {
      const id = decodeURIComponent(pathname.slice("/api/dashboards/wallets/".length));
      const r = await getWalletProfile(id);
      return json(r ?? { error: "not found" }, r ? 200 : 404);
    }

    if (pathname === ROUTES.projects.list && req.method === "GET") {
      return json(await getProjects());
    }

    // Admin-managed overview write (issue #93). Privileged; no AI enrichment.
    if (pathname.startsWith("/api/projects/admin/") && req.method === "POST") {
      const slug = decodeURIComponent(pathname.slice("/api/projects/admin/".length));
      const r = await updateProjectOverview(req, slug);
      return json(r.body, r.status);
    }

    // ProjectProfile dossier (issue #389, §5.5, P3.1) — GET /api/projects/:slug.
    // Checked after the admin-write prefix above (which is also under
    // /api/projects/) so a POST to .../admin/<slug> never falls through here.
    if (pathname.startsWith("/api/projects/") && req.method === "GET") {
      const slug = decodeURIComponent(pathname.slice("/api/projects/".length));
      const project = await getProjectDetail(slug);
      if (!project) return json({ error: "project not found" }, 404);
      return json({ project });
    }

    if (pathname.startsWith("/api/dashboards/research-signals/") && req.method === "GET") {
      const key = decodeURIComponent(pathname.split("/").pop()!);
      const r = await getResearchSignal(key, url.searchParams.get("view") === "summary");
      return json(r ?? { error: "not found" }, r ? 200 : 404);
    }

    // Legacy path redirect (issue #263 pass 2): committee → swarm rename moved
    // every route under this prefix. 308 preserves method + body so an
    // already-onboarded external member agent hardcoding the old path (several
    // of these are POSTs) keeps working through the deprecation window instead
    // of hitting a 404.
    if (pathname.startsWith("/api/committee/")) {
      const target = "/api/swarm/" + pathname.slice("/api/committee/".length) + url.search;
      return new Response(null, { status: 308, headers: { Location: target } });
    }

    if (pathname.startsWith("/api/swarm/")) {
      const r = await handleSwarm(req, url);
      // The avatar route (issue #626) returns a raw Response — real image
      // bytes, not a {status, body} JSON envelope — so it must pass through
      // untouched rather than being re-wrapped by json().
      if (r instanceof Response) return r;
      if (r) return json(r.body, r.status);
    }

    // Analytics ingestion boundary (issue #106): the analytics-provider-only
    // typed read/mutation surface updater processes use instead of direct SQL.
    if (pathname.startsWith("/api/analytics/")) {
      const r = await handleAnalytics(req, url);
      if (r) return json(r.body, r.status);
    }

    // Admin task-queue dashboard (read-only over jobs/job_schedules/job_runs).
    if (pathname.startsWith("/api/admin/webauthn/")) {
      const r = await handleAdminWebauthn(req, url);
      if (r) return json(r.body, r.status);
    }

    if (pathname.startsWith("/api/admin/")) {
      const r = await handleAdmin(req, url);
      if (r) return json(r.body, r.status);
    }

    // Unmatched API path → 404 JSON.
    if (pathname.startsWith("/api/")) return json({ error: "not found" }, 404);

    // Everything else is the website-server nginx image's job now (issue
    // #892) — this process ships no static-serving code at all.
    return new Response("Not found", { status: 404 });
}

console.log(`api listening on :${server.port} (env=${config.env})`);
