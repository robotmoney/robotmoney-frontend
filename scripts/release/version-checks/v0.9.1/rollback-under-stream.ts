// Q24c-site-rollback-under-stream (stage only, no production twin; PR 1651, issue 1650): the rollback rehearsal,
// with a judge-style event stream held through the CAISSON of the swap, the Caddy container.
//
// `bun smoke:web --rollback` on a first rollout retires the serving Caddy container and starts the kept nginx
// container again (web-serving-architecture.md section 4). This is therefore also the proof that a Caddy
// container with a held stream stops inside the retire bound: the Caddyfile sets `grace_period 500ms`, and
// Caddy's default (eternal) would hold the stream, and the public port, until docker's forced kill.
//
// PASSES ONLY IF (_swap.ts streamSwapProblems, run for the rollback): the stream was open at the stop; the gap
// is at most 3000 ms; the stream was cut inside the retire bound (the stop did not wait on it); the client is
// connected again within 10 s of the stop; no request failed outside the gap; the receipt shows the Docker
// guard and no revert; and then ROLLBACK RESTORES NGINX AND SERVES: one running website-server, no web tag on
// its labels, the first-rollout container name consumed, and `/version.json` and the proxied `/api/version`
// answering 200 on the same port.
//
// What it cannot show: that Caddy exited by itself with code 0, not 137 from the forced kill. The container is
// removed by the rollback (website-release.ts swap step 7), so nothing is left to inspect. That is shown by
// scripts/tests/integration/smoke-web-held-stream.test.ts (exit code 0) and by caddy-grace's read of the
// baked Caddyfile. A stream cut at the forced kill (about 1 s) would pass the cut bound here.
import type { VersionCheck } from "../../version-check.ts";
import { runUnderStream } from "./_stream.ts";

export default ((ctx) => runUnderStream(ctx, { kind: "rollback", before: "caddy", after: "nginx" })) satisfies VersionCheck;
