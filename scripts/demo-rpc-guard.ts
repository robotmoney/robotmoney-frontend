// Hermetic Base RPC guard for the required e2e demo (issue #48). Runs INSIDE the
// `e2e` job, after the browser suite has driven /allocation, while the stack is
// still up. It FAILS LOUDLY (exit 1 → red e2e check) if either:
//
//   (a) any e2e demo env layer could resolve config.baseRpcUrl to live Base
//       mainnet (mainnet.base.org) — a static check of docker-compose.demo.yml,
//       the e2e workflow, and the live BASE_RPC_URL env; or
//   (b) the in-CI stub (backend/tests/support/base-rpc-stub.ts) recorded ZERO
//       eth_call requests — meaning the /allocation vault-economics path did NOT
//       route to the stub.
//
// The stub is the ONLY RPC endpoint the demo stack is configured to reach, so a
// positive stub eth_call count together with (a) is the proof that the live Base
// mainnet host received ZERO eth_call requests. This is a loud guard, never a
// silent skip: a missing stub URL or an unreachable /__count is a hard failure.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const MAINNET = "mainnet.base.org";

function fail(msg: string): never {
  console.error(`[rpc-guard] FAIL: ${msg}`);
  process.exit(1);
}

// (a) Static: the e2e demo env layers must pin BASE_RPC_URL to a non-mainnet stub.
// Only inspect actual `BASE_RPC_URL:` assignment lines — YAML `#` comments (which
// legitimately mention the mainnet opt-in) are excluded so the guard tests the
// resolved value, not documentation.
const assignLines = (yaml: string): string[] =>
  yaml
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .filter((l) => /^\s*BASE_RPC_URL\s*:/.test(l));

const demoCompose = readFileSync(join(repoRoot, "docker-compose.demo.yml"), "utf8");
const rpcLines = assignLines(demoCompose);
if (rpcLines.length === 0) {
  fail("docker-compose.demo.yml does not pin BASE_RPC_URL for the demo stack (api/worker would default to live mainnet)");
}
for (const line of rpcLines) {
  if (line.includes(MAINNET)) fail(`docker-compose.demo.yml resolves BASE_RPC_URL to live Base mainnet: ${line.trim()}`);
  if (!/base-rpc-stub|127\.0\.0\.1|localhost/.test(line)) {
    fail(`docker-compose.demo.yml BASE_RPC_URL default is not an in-CI stub host (base-rpc-stub/127.0.0.1/localhost): ${line.trim()}`);
  }
}
// The workflow env must not smuggle live mainnet back into the BASE_RPC_URL it sets.
const e2eWorkflow = readFileSync(join(repoRoot, ".github/workflows/e2e.yml"), "utf8");
for (const line of assignLines(e2eWorkflow)) {
  if (line.includes(MAINNET)) fail(`.github/workflows/e2e.yml sets BASE_RPC_URL to live Base mainnet: ${line.trim()}`);
}
if (process.env.BASE_RPC_URL && process.env.BASE_RPC_URL.includes(MAINNET)) {
  fail(`BASE_RPC_URL env resolves to live Base mainnet: ${process.env.BASE_RPC_URL}`);
}

// (b) Runtime: the stub must have received the /allocation vault-economics reads.
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
  `[rpc-guard] OK: in-CI stub served ${ethCall} eth_call request(s) across ${seen.length} distinct to:selector pair(s); ` +
    `no e2e path resolves to live Base mainnet, so the live host received 0 eth_call requests. seen=${JSON.stringify(seen)}`,
);
