// Q24b-site-swap-under-stream (stage only, no production twin; PR 1651, issue 1650, tracking issue 1649): the
// first rollout, nginx to the signed Caddy container, rehearsed with a judge-style event stream held through
// nginx at the stop.
//
// The first production attempt (v0.9.0, run 20261116T143356Z) failed here: an external judge client's stream
// held nginx's drain for the whole 10 s `docker stop -t 10`, so the gap was 10938 ms against the 3000 ms limit.
// Stage never showed it because nothing was connected. This step connects first.
//
// PASSES ONLY IF (_swap.ts streamSwapProblems): the stream was open at the stop; the gap is at most 3000 ms; the
// stream was cut inside the retire bound; the client is connected again within 10 s of the stop; no request
// failed outside the gap; the receipt shows the Docker guard, the private-port pre-check and its cold-start
// gate, the live check set on the public port, no revert; and the host then serves Caddy with the nginx
// container kept, stopped, as `<name>-first-rollout`.
//
// It runs the same `bun run smoke:web ... --bundle <the release's signed bundle> --server-image ...` command
// Q24d-site-bundle-deploy and C12b-site-bundle-deploy run (platform-bundle.ts deployArgv). It does not write
// stage-deploy.json: Q24d does, after the rollback rehearsal. Writes (it changes what stage serves): stage only.
import type { VersionCheck } from "../../version-check.ts";
import { runUnderStream } from "./_stream.ts";

export default ((ctx) => runUnderStream(ctx, { kind: "deploy", before: "nginx", after: "caddy" })) satisfies VersionCheck;
