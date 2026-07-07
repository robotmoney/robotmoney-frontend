// Hermetic Base RPC guard for the required e2e demo (issues #48/#50). Runs
// INSIDE the `e2e` job, after the browser suite has driven /allocation, while
// the stack is still up. Since issue #50 the demo's DEFAULT data path is
// production-parity LIVE and hermetic mode is an explicit opt-in
// (DEMO_HERMETIC=1, set by .github/workflows/e2e.yml) — so this guard's first
// job is to prove that the hermetic opt-in layer was actually present, and
// then that it resolved to the stub everywhere. It FAILS LOUDLY (exit 1 → red
// e2e check) if any of:
//
//   (a) the hermetic opt-in layer is missing — DEMO_HERMETIC=1 is not set in
//       this run's env (a CI demo without it would read live Base mainnet);
//   (b) any e2e env layer could resolve config.baseRpcUrl to live Base mainnet
//       (mainnet.base.org): the live BASE_RPC_URL env, a `BASE_RPC_URL:`
//       assignment in docker-compose.demo.yml or the e2e workflow, or the
//       COMPOSE-RESOLVED api/worker environment under this run's env (which
//       must pin the in-compose stub and ANALYTICS_SOURCE=hermetic +
//       BASE_RPC_SOURCE=stub, the DTO provenance marker); or
//   (c) the in-CI stub (backend/tests/support/base-rpc-stub.ts) recorded ZERO
//       eth_call requests — meaning the /allocation vault-economics path did
//       NOT route to the stub.
//
// The stub is the ONLY RPC endpoint the hermetic demo stack is configured to
// reach, so a positive stub eth_call count together with (a)+(b) is the proof
// that the live Base mainnet host received ZERO eth_call requests. This is a
// loud guard, never a silent skip: a missing knob, an unresolvable compose
// config, or an unreachable /__count is a hard failure.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const MAINNET = "mainnet.base.org";
const STUB_HOST_RE = /base-rpc-stub|127\.0\.0\.1|localhost/;

function fail(msg: string): never {
  console.error(`[rpc-guard] FAIL: ${msg}`);
  process.exit(1);
}

// (a) The explicit hermetic opt-in layer must be present. The demo no longer
// defaults to the stub (issue #50), so a CI run that forgot DEMO_HERMETIC=1
// would silently read live mainnet — refuse to certify such a run.
if (process.env.DEMO_HERMETIC !== "1") {
  fail(
    "hermetic opt-in layer missing: DEMO_HERMETIC=1 is not set in this run's env. " +
      "The demo defaults to the LIVE data path; the e2e workflow must set DEMO_HERMETIC=1 " +
      "so no CI job ever reads live Base mainnet.",
  );
}
if (process.env.BASE_RPC_URL?.includes(MAINNET)) {
  fail(`BASE_RPC_URL env resolves to live Base mainnet: ${process.env.BASE_RPC_URL}`);
}

// (b-static) No `BASE_RPC_URL:` assignment line in the demo compose layer or the
// e2e workflow may name live mainnet. Only actual assignment lines are
// inspected — YAML `#` comments (which legitimately mention the mainnet
// default) are excluded so the guard tests values, not documentation.
const assignLines = (yaml: string): string[] =>
  yaml
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .filter((l) => /^\s*BASE_RPC_URL\s*:/.test(l));

for (const [file, yaml] of [
  ["docker-compose.demo.yml", readFileSync(join(repoRoot, "docker-compose.demo.yml"), "utf8")],
  [".github/workflows/e2e.yml", readFileSync(join(repoRoot, ".github/workflows/e2e.yml"), "utf8")],
] as const) {
  for (const line of assignLines(yaml)) {
    if (line.includes(MAINNET)) fail(`${file} resolves BASE_RPC_URL to live Base mainnet: ${line.trim()}`);
  }
}

// (b-resolved) The compose config, RESOLVED under this run's env (which carries
// the hermetic opt-in), must pin every RPC consumer at the stub. This replaces
// the pre-#50 "compose must default to the stub" check: the stub pin now lives
// in the hermetic opt-in layer, so we assert the resolved value rather than the
// raw default. `docker compose config` is offline (pure interpolation).
interface ComposeConfig {
  services: Record<string, { environment?: Record<string, string | null> }>;
}
const composeProc = Bun.spawnSync(
  ["docker", "compose", "-f", "docker-compose.yml", "-f", "docker-compose.demo.yml", "config", "--format", "json"],
  {
    cwd: repoRoot,
    env: { ...process.env, DEMO_PROJECT: process.env.DEMO_PROJECT || "rpc-guard" } as Record<string, string>,
    stdout: "pipe",
    stderr: "pipe",
  },
);
if (composeProc.exitCode !== 0) {
  fail(`docker compose config failed (exit ${composeProc.exitCode}): ${new TextDecoder().decode(composeProc.stderr)}`);
}
const composeCfg = JSON.parse(new TextDecoder().decode(composeProc.stdout)) as ComposeConfig;
for (const svc of ["api", "worker"]) {
  const envMap = composeCfg.services?.[svc]?.environment ?? {};
  const rpcUrl = envMap.BASE_RPC_URL ?? "";
  if (!rpcUrl) fail(`resolved compose config leaves ${svc} BASE_RPC_URL empty under DEMO_HERMETIC=1 (would fall through to live mainnet)`);
  if (rpcUrl.includes(MAINNET)) fail(`resolved compose config points ${svc} BASE_RPC_URL at live Base mainnet: ${rpcUrl}`);
  if (!STUB_HOST_RE.test(rpcUrl)) {
    fail(`resolved compose config ${svc} BASE_RPC_URL is not an in-CI stub host (base-rpc-stub/127.0.0.1/localhost): ${rpcUrl}`);
  }
  if ((envMap.ANALYTICS_SOURCE ?? "") !== "hermetic") {
    fail(`resolved compose config ${svc} ANALYTICS_SOURCE is not "hermetic" under DEMO_HERMETIC=1 (got "${envMap.ANALYTICS_SOURCE ?? ""}") — live analytics would run in CI`);
  }
  if ((envMap.BASE_RPC_SOURCE ?? "") !== "stub") {
    fail(`resolved compose config ${svc} BASE_RPC_SOURCE is not "stub" under DEMO_HERMETIC=1 (got "${envMap.BASE_RPC_SOURCE ?? ""}") — stub-served vault-economics would be presented as live`);
  }
}

// (c) Runtime: the stub must have received the /allocation vault-economics reads.
const stubUrl = process.env.BASE_RPC_STUB_URL;
if (!stubUrl) fail("BASE_RPC_STUB_URL not set — cannot verify the stub captured the eth_call reads");
const res = await fetch(`${stubUrl}/__count`).catch((e) => fail(`stub /__count unreachable: ${(e as Error).message}`));
if (!res.ok) fail(`stub /__count returned HTTP ${res.status}`);
const { ethCall, seen } = (await res.json()) as { ethCall: number; seen: string[] };
if (!(ethCall > 0)) {
  fail(
    "the in-CI Base RPC stub recorded ZERO eth_call requests — the demo /allocation " +
      "vault-economics path did not route to the stub (a live-mainnet leak or a broken wiring)",
  );
}

console.log(
  `[rpc-guard] OK: hermetic opt-in present (DEMO_HERMETIC=1); in-CI stub served ${ethCall} eth_call request(s) across ` +
    `${seen.length} distinct to:selector pair(s); no e2e env layer resolves to live Base mainnet, so the live host ` +
    `received 0 eth_call requests. seen=${JSON.stringify(seen)}`,
);
