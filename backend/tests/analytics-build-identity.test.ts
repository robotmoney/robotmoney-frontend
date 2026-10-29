// Issue 1442: a vintage's build identity is the image's git commit
// (RM_BUILD_COMMIT, AC-ID-03), never the package or runtime version. Real,
// migrated ephemeral Postgres via tests/preload.ts for the vintage cases; the
// runtime case spawns two real processes, one under Bun and one under Node.
import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { sql } from "../src/db/client.ts";
import { runAnalytics } from "../src/analytics/index.ts";
import { resolveBuildIdentity, UNAVAILABLE_BUILD_IDENTITY_PREFIX } from "../src/analytics/build-identity.ts";
import { BUILD_COMMIT_ENV, resolveBuildIdentity as resolveImageBuildIdentity } from "../src/ops/build-identity.ts";
import { directAnalyticsPersistence } from "../src/analytics/store/direct.ts";
import { hermeticDataSource } from "../src/analytics/access/hermetic-source.ts";
import { noopTelemetrySink } from "../src/analytics/telemetry.ts";
import { beginRun, freezeVintage, loadFrozenVintage } from "../src/analytics/store/run-ledger-store.ts";
import { buildVintageManifest } from "../src/analytics/run-ledger.ts";
import { useCleanDatabase } from "./support/clean-db.ts";

useCleanDatabase(import.meta.file);

const ASOF = "2026-05-15";
const COMMIT = "ebc588b4542de4d5a61aecdba0a967af35afcd6b";
const PROBE = join(import.meta.dir, "support", "build-identity-probe.ts");
const RUNTIME_SHAPED = /pkg:|bun:|node:|\+/;

const savedCommit = process.env[BUILD_COMMIT_ENV];
afterEach(() => {
  if (savedCommit === undefined) delete process.env[BUILD_COMMIT_ENV];
  else process.env[BUILD_COMMIT_ENV] = savedCommit;
});

async function vintageRowsOfRun(runId: string) {
  return sql`
    SELECT id::text AS id, build_identity, manifest_digest
    FROM analytics_data_vintages WHERE run_id = ${runId}::bigint`;
}

async function runChannelDivergence(): Promise<string> {
  const results = await runAnalytics(ASOF, "channel-divergence", hermeticDataSource, directAnalyticsPersistence, noopTelemetrySink);
  return (results as any).__runLedger.runId as string;
}

describe("a vintage records the image's commit", () => {
  test("an image built with RM_BUILD_COMMIT=<sha> freezes a vintage whose build identity is <sha>", async () => {
    process.env[BUILD_COMMIT_ENV] = COMMIT;
    const runId = await runChannelDivergence();
    const [run] = await sql`SELECT build_identity FROM analytics_ledger_runs WHERE id = ${runId}::bigint`;
    const vintages = await vintageRowsOfRun(runId);
    expect(vintages.length).toBe(1);
    expect(vintages[0]!.build_identity).toBe(COMMIT);
    expect(run!.build_identity).toBe(COMMIT);
    // The same value /version reports for the same image.
    expect(vintages[0]!.build_identity).toBe(resolveImageBuildIdentity({ [BUILD_COMMIT_ENV]: COMMIT }).commit.value!);
  });

  test("an image built without a commit records the identity as unavailable, with no package or runtime fallback", async () => {
    for (const env of [{}, { [BUILD_COMMIT_ENV]: "" }, { [BUILD_COMMIT_ENV]: "   " }]) {
      const identity = resolveBuildIdentity(env);
      expect(identity).toBe(`${UNAVAILABLE_BUILD_IDENTITY_PREFIX}${BUILD_COMMIT_ENV} is unset or blank`);
      expect(identity).not.toMatch(RUNTIME_SHAPED);
      expect(identity).not.toContain(Bun.version);
    }
    // The identities this module used to honour are no longer read: only the
    // image's commit names the build.
    expect(resolveBuildIdentity({ RM_BUILD_IDENTITY: "x", GIT_SHA: "y", GITHUB_SHA: "z" }))
      .toStartWith(UNAVAILABLE_BUILD_IDENTITY_PREFIX);

    process.env[BUILD_COMMIT_ENV] = "";
    const runId = await runChannelDivergence();
    const [vintage] = await vintageRowsOfRun(runId);
    expect(vintage!.build_identity).toBe(`${UNAVAILABLE_BUILD_IDENTITY_PREFIX}${BUILD_COMMIT_ENV} is unset or blank`);
    expect(vintage!.build_identity).not.toMatch(RUNTIME_SHAPED);
  });
});

describe("the runtime version is never part of the identity", () => {
  test("two processes with the same commit and different runtimes produce the same build identity and manifest digest", async () => {
    const env = { ...process.env, [BUILD_COMMIT_ENV]: COMMIT };
    const bunOut = Bun.spawnSync([process.execPath, PROBE], { env, stdout: "pipe", stderr: "pipe" });
    expect(bunOut.exitCode, bunOut.stderr.toString()).toBe(0);

    // The same probe bundled for Node, so the second process runs a different
    // runtime with a different version string.
    const bundle = await Bun.build({ entrypoints: [PROBE], target: "node", format: "esm" });
    expect(bundle.success, bundle.logs.join("\n")).toBe(true);
    const code = await bundle.outputs[0]!.text();
    const nodeOut = Bun.spawnSync(["node", "--input-type=module", "-"], {
      env, stdin: new TextEncoder().encode(code), stdout: "pipe", stderr: "pipe",
    });
    expect(nodeOut.exitCode, nodeOut.stderr.toString()).toBe(0);

    const a = JSON.parse(bunOut.stdout.toString()) as { runtime: string; buildIdentity: string; manifestDigest: string };
    const b = JSON.parse(nodeOut.stdout.toString()) as typeof a;
    expect(a.runtime).toStartWith("bun:");
    expect(b.runtime).toStartWith("node:");
    expect(a.buildIdentity).toBe(COMMIT);
    expect(b.buildIdentity).toBe(COMMIT);
    expect(b.manifestDigest).toBe(a.manifestDigest);
  });
});

describe("existing vintages are left as written", () => {
  test("a vintage frozen under the old pkg:+bun: identity keeps its row and its digest after new commit-identified runs", async () => {
    const legacyIdentity = "pkg:0.1.0+bun:1.3.0";
    const { runId, methodologyVersionId } = await beginRun({
      runKey: randomUUID(), asof: ASOF, toolId: "test-1442-legacy", sourceLabel: "fixture",
      methodology: { toolId: "test-1442-legacy", versionLabel: "v-test", config: { test: "1442" } },
      buildIdentity: legacyIdentity,
    });
    const { vintageId } = await freezeVintage({
      runId, toolId: "test-1442-legacy", knowledgeTimeCutoff: new Date().toISOString(), marketTimeCutoff: ASOF,
      methodologyVersionId, buildIdentity: legacyIdentity,
    });
    const before = await sql`SELECT * FROM analytics_data_vintages WHERE id = ${vintageId}::bigint`;

    process.env[BUILD_COMMIT_ENV] = COMMIT;
    await runChannelDivergence();

    const after = await sql`SELECT * FROM analytics_data_vintages WHERE id = ${vintageId}::bigint`;
    expect(after).toEqual(before);
    expect(after[0]!.build_identity).toBe(legacyIdentity);
    // The stored digest still replays from the stored identity.
    const loaded = (await loadFrozenVintage(vintageId))!;
    const { manifest } = buildVintageManifest(
      loaded.members, loaded.methodologyVersionId, loaded.buildIdentity,
      loaded.knowledgeTimeCutoff, loaded.marketTimeCutoff,
    );
    expect(manifest.manifestDigest).toBe(after[0]!.manifest_digest);
  });
});
