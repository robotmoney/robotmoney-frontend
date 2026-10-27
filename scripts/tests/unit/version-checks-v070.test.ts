// v0.7.0's version checks V01 to V10 (scripts/release/version-checks/v0.7.0/,
// issue 1476): each check's decision with a passing case and a red control.
// The checks that read the public API run against a fake of it
// (support/fake-public-api.ts); the SDK 0.2.0 checks run the real SDK from a
// local export of the working tree.
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { repoMigrations } from "../../release/ledger.ts";
import { noRunMessage, sha256Hex } from "../../release/public-analytics-read.ts";
import { fillParityCheck, homeScratch, spawnRunner, type SdkDeps } from "../../release/sdk-lib.ts";
import { archiveSamples, integrityProblems, type Sample } from "../../release/version-checks/v0.7.0/archive-integrity.ts";
import { credentialProblems, credentialsIn } from "../../release/version-checks/v0.7.0/db-credential-api-only.ts";
import { ledgerEndProblems } from "../../release/version-checks/v0.7.0/migration-ledger.ts";
import { MAX_REQUESTS, rateLimit, rateLimitProblems } from "../../release/version-checks/v0.7.0/rate-limit.ts";
import { reportBytesEtag, reportServeProblems } from "../../release/version-checks/v0.7.0/report-bytes-etag.ts";
import { goldenProblems, REFERENCE_DIR, sdkBacktestGolden } from "../../release/version-checks/v0.7.0/sdk-backtest-golden.ts";
import { ruleProblems, sdkRulesCheck } from "../../release/version-checks/v0.7.0/sdk-rules-check.ts";
import { sdkUniverseCheck } from "../../release/version-checks/v0.7.0/sdk-universe-check.ts";
import { buildIdentityProblems, vintageIdentity } from "../../release/version-checks/v0.7.0/vintage-build-identity.ts";
import { exportPackage } from "./support/analyst-sdk-export.ts";
import { COMMIT, fakeNet, fakeServer, RUN_KEY } from "./support/fake-public-api.ts";

setDefaultTimeout(240_000);
const cleanup: string[] = [];
afterAll(() => { for (const d of cleanup) rmSync(d, { recursive: true, force: true }); });
const REPORT = new TextEncoder().encode('{"asof":"2026-08-15","toolId":"regime","results":{}}');
const withRun = { reports: [{ run_key: RUN_KEY, asof: "2026-08-15", bytes: REPORT }] };
const localDeps = (net = fakeNet(), prepare?: (dir: string) => void): SdkDeps => ({
  net, run: spawnRunner, scratch: () => homeScratch("sdk-v070-test-"),
  prepareSdk: async () => { const dir = exportPackage("rm-sdk-v070-"); cleanup.push(dir); prepare?.(dir); return { sdkDir: dir }; },
});

describe("V01-archive-integrity (1461)", () => {
  const good = (path: string, encoding: "gzip" | "identity", sha = "a".repeat(64)): Sample => ({ path, encoding, status: 200, etag: `"${sha}"`, xsha: sha, actualSha: sha });
  test("passes: the ETag and X-Content-SHA256 are the content hash under both encodings", () => {
    expect(integrityProblems([good("p", "gzip"), good("p", "identity")], { p: "a".repeat(64) })).toEqual([]);
  });
  test("red: an ETag of the wrong bytes, a header that is not the hash, encodings that disagree, a record mismatch, a 404", () => {
    expect(integrityProblems([{ ...good("p", "gzip"), etag: `"${"b".repeat(64)}"` }]).join()).toContain("ETag is");
    expect(integrityProblems([{ ...good("p", "gzip"), xsha: "b".repeat(64) }]).join()).toContain("X-Content-SHA256 is");
    expect(integrityProblems([good("p", "gzip", "b".repeat(64)), good("p", "identity")]).join()).toContain("must not depend on the encoding");
    expect(integrityProblems([good("p", "gzip")], { p: "c".repeat(64) }).join()).toContain("record's sha256_raw");
    expect(integrityProblems([{ ...good("p", "gzip"), status: 404 }]).join()).toContain("answered 404");
    expect(integrityProblems([]).join()).toContain("no archive was fetched");
  });
  test("against the recorded routes: the real files pass; an ETag of the gzip, or one that follows the encoding, fails", async () => {
    const ok = await archiveSamples(fakeNet());
    expect(ok.problems).toEqual([]);
    expect(ok.samples.length).toBe(4);
    expect(integrityProblems(ok.samples, ok.recorded)).toEqual([]);
    const gz = await archiveSamples(fakeNet({ etagOfGzip: true }));
    expect(integrityProblems(gz.samples, gz.recorded).join()).toContain("ETag is");
    const enc = await archiveSamples(fakeNet({ etagByEncoding: true }));
    expect(integrityProblems(enc.samples, enc.recorded).join()).toContain("must not depend on the encoding");
    expect((await archiveSamples(fakeNet({ archiveStatus: 404 }))).problems.join()).toContain("answered 404");
  });
});

describe("V02-vintage-build-identity (1445)", () => {
  test("passes when every vintage of the newest run carries the commit /api/version reports", async () => {
    const r = await vintageIdentity(fakeNet(withRun));
    expect(r.problems).toEqual([]);
    expect(r.found.apiCommit).toBe(COMMIT);
  });
  test("red: the old package identity, another commit, no commit at all, no vintage and no run each fail", async () => {
    expect((await vintageIdentity(fakeNet({ ...withRun, buildIdentity: "pkg:0.1.0+bun:1.3" }))).problems.join()).toContain("package-version identity");
    expect((await vintageIdentity(fakeNet({ ...withRun, buildIdentity: "b".repeat(40) }))).problems.join()).toContain("run was built before this boot");
    expect(buildIdentityProblems(COMMIT, [{ id: 1, build_identity: "unavailable: no commit baked" }]).join()).toContain("unavailable identity");
    expect(buildIdentityProblems(COMMIT, []).join()).toContain("no vintage");
    expect(buildIdentityProblems(null, [{ id: 1, build_identity: COMMIT }]).join()).toContain("no commit");
    expect((await vintageIdentity(fakeNet({ reports: [] }))).problems).toEqual([noRunMessage("the vintage build identity check")]);
  });
});

describe("V03-db-credential-api-only (D75)", () => {
  const row = (service: string, env: string[] | null) => ({ container: `rm_stack-${service}-1`, service, env });
  const clean = ["PATH=/usr/bin", "API_BASE_URL=http://api:3000", "PIPELINE_TOKEN_FILE=token-file"];
  test("passes: the api holds its credential and nothing else does", () => {
    expect(credentialProblems([row("api", ["DATABASE_URL=postgres://rm_app:x@db/rm", ...clean]), row("worker-analytics", clean), row("system-scheduler", clean)])).toEqual([]);
  });
  test("red: a credential key, a PG key, a connection string under an innocent name, an unreadable container, no api", () => {
    const api = row("api", ["DATABASE_URL=x"]);
    expect(credentialProblems([api, row("worker-analytics", [...clean, "DATABASE_URL=postgres://rm_worker:secretvalue@db/rm"])]).join()).toContain("DATABASE_URL (credential key)");
    expect(credentialProblems([api, row("worker-analytics", [...clean, "PG_POOL_MAX=4"])]).join()).toContain("PG_POOL_MAX (connection or pool key)");
    expect(credentialProblems([api, row("system-scheduler", [...clean, "STORE=postgres://u:p@h/db"])]).join()).toContain("STORE (connection string value)");
    expect(credentialProblems([api, row("system-scheduler", null)]).join()).toContain("could not be read");
    expect(credentialProblems([row("worker-analytics", clean)]).join()).toContain("no running api container");
    expect(credentialProblems([]).join()).toContain("no running container");
  });
  test("a finding names the key, never the value", () => {
    const out = credentialProblems([row("api", []), row("worker-analytics", ["WORKER_DATABASE_URL=postgres://rm_worker:hunter2@db/rm"])]).join("\n");
    expect(out).toContain("WORKER_DATABASE_URL");
    expect(out).not.toContain("hunter2");
    expect(credentialsIn(["POSTGRES_PASSWORD=x", "PATH=/bin"])).toEqual([]);
  });
});

describe("V04-migration-ledger (0126, 0127)", () => {
  const repo = repoMigrations();
  test("the release ships 0127 among its migrations", () => {
    expect(repo).toContain("0127_rm_worker_retired.sql");
  });
  test("passes when the ledger is the repository's files; red: a pending file, a foreign name, a ledger that ends early, an unread checkout", () => {
    expect(ledgerEndProblems(repo, repo)).toEqual([]);
    expect(ledgerEndProblems(repo.slice(0, -1), repo).join()).toContain("1 migration(s) pending");
    expect(ledgerEndProblems(repo.slice(0, -1), repo).join()).toContain("the ledger ends at");
    expect(ledgerEndProblems([...repo, "9999_not_here.sql"], repo).join()).toContain("9999_not_here.sql");
    expect(ledgerEndProblems(repo.filter((f) => !f.startsWith("0126")), repo).join()).toContain("0126_pipeline_worker_token_and_receipts.sql");
    expect(ledgerEndProblems(repo, []).join()).toContain("no migration file");
  });
});

describe("V05-report-bytes-etag (1427)", () => {
  test("passes: the bytes served hash to the ETag, the list's checksum and X-Content-SHA256, and the ETag revalidates to 304", async () => {
    const r = await reportBytesEtag(fakeNet(withRun));
    expect(r.problems).toEqual([]);
    expect(r.found.revalidateStatus).toBe(304);
  });
  test("red: an ETag that is not the hash, a wrong length and no revalidation each fail; no run fails by name", async () => {
    expect((await reportBytesEtag(fakeNet({ ...withRun, badReportEtag: true }))).problems.join()).toContain("ETag is");
    const row = { run_key: RUN_KEY, checksum: sha256Hex(REPORT), byte_length: REPORT.length };
    const served = { status: 200, etag: `"${sha256Hex(REPORT)}"`, xsha: sha256Hex(REPORT), bytes: REPORT, revalidateStatus: 304 };
    expect(reportServeProblems(row, served)).toEqual([]);
    expect(reportServeProblems({ ...row, byte_length: 3 }, served).join()).toContain("3 bytes");
    expect(reportServeProblems({ ...row, checksum: "d".repeat(64) }, served).join()).toContain("list's checksum");
    expect(reportServeProblems(row, { ...served, revalidateStatus: 200 }).join()).toContain("not 304");
    expect(reportServeProblems(row, { ...served, status: 404, bytes: null }).join()).toContain("answered 404");
    expect((await reportBytesEtag(fakeNet({ reports: [] }))).problems).toEqual([noRunMessage("the report bytes check")]);
  });
});

describe("V10-rate-limit (1429)", () => {
  test("passes: a 429 with a Retry-After in whole seconds and a reason arrives within the request cap", async () => {
    const r = await rateLimit(fakeNet({ ...withRun, limitAfter: 11 }));
    expect(r.problems).toEqual([]);
    expect(r.found.retryAfter).toBe("17");
    expect(r.found.requests as number).toBeLessThanOrEqual(MAX_REQUESTS);
  });
  test("red: a route that never refuses, a 429 without Retry-After, a Retry-After that is not a count, a 429 that says nothing", async () => {
    expect((await rateLimit(fakeNet({ ...withRun, limitAfter: Infinity }))).problems.join()).toContain("never drew a 429");
    expect((await rateLimit(fakeNet({ ...withRun, limitAfter: 2, noRetryAfter: true }))).problems.join()).toContain("Retry-After null");
    expect(rateLimitProblems([{ status: 429, retryAfter: "soon", body: "rate limit exceeded" }]).join()).toContain('"soon"');
    expect(rateLimitProblems([{ status: 429, retryAfter: "5", body: "" }]).join()).toContain("does not say why");
    expect(rateLimitProblems([{ status: 500, retryAfter: null, body: "" }, { status: 429, retryAfter: "5", body: "rate limit exceeded" }]).join()).toContain("answered 500");
    expect((await rateLimit(fakeNet({ reports: [] }))).problems).toEqual([noRunMessage("the rate limit check")]);
  });
});

describe("V06-sdk-fill-parity (SDK 0.2.0)", () => {
  test("passes: the fill into a fresh folder and the fill from the first recorded backup are the same copy", async () => {
    const api = fakeServer();
    try {
      const r = await fillParityCheck(localDeps({ ...fakeNet(), origin: api.origin, fetch: (u, i) => fetch(u, i) }), COMMIT);
      expect(r.problems).toEqual([]);
      expect(r.found.firstBackup).toBe("2001-01-02T000000Z");
      expect(r.found.files as number).toBeGreaterThan(2);
    } finally {
      api.server.stop(true);
    }
  });
  test("red: a target whose archive list is a 404 fails; so does a README whose fill block is gone", async () => {
    expect((await fillParityCheck(localDeps(fakeNet({ archiveStatus: 404 })), COMMIT)).problems.join()).toContain("answered 404");
    const api = fakeServer();
    try {
      const noFill = localDeps({ ...fakeNet(), origin: api.origin, fetch: (u, i) => fetch(u, i) }, (dir) => {
        const readme = join(dir, "README.md");
        writeFileSync(readme, readFileSync(readme, "utf8").replace(/^fill api-copy$/m, "echo not the fill"));
      });
      expect((await fillParityCheck(noFill, COMMIT)).problems.join()).toContain("no longer has the API-only `fill` block");
    } finally {
      api.server.stop(true);
    }
  });
});

describe("V07-sdk-rules-check (SDK 0.2.0)", () => {
  test("passes for every shipped rule file; red: an invalid rule file in rules/ fails and is named", async () => {
    const ok = await sdkRulesCheck(localDeps(), COMMIT);
    expect(ok.problems).toEqual([]);
    expect((ok.found.files as unknown[]).length).toBeGreaterThanOrEqual(7);
    const red = await sdkRulesCheck(localDeps(fakeNet(), (dir) => writeFileSync(join(dir, "rules", "BAD.json"), JSON.stringify({ id: "BAD" }))), COMMIT);
    expect(red.problems.join()).toContain("rules:check BAD.json exited 2");
    expect(ruleProblems([]).join()).toContain("holds no rule file");
    expect(ruleProblems([{ file: "A.json", code: 0, stderr: "" }])).toEqual([]);
  });
});

describe("V08-sdk-backtest-golden (SDK 0.2.0)", () => {
  test("passes: the reference portfolio prints its golden output", async () => {
    expect((await sdkBacktestGolden(localDeps(), COMMIT)).problems).toEqual([]);
  });
  test("red: a golden with one changed number, and a changed price, each fail at the line that differs", async () => {
    const dir = homeScratch("sdk-ref-test-");
    cleanup.push(dir);
    cpSync(REFERENCE_DIR, dir, { recursive: true });
    const golden = readFileSync(join(REFERENCE_DIR, "backtest.golden.json"), "utf8");
    expect(golden).toContain('"final_value": 1.0');
    writeFileSync(join(dir, "backtest.golden.json"), golden.replace('"final_value": 1.0', '"final_value": 2.0'));
    expect((await sdkBacktestGolden(localDeps(), COMMIT, dir)).problems.join()).toContain("differs from its golden output at line");
    cpSync(REFERENCE_DIR, dir, { recursive: true });
    const prices = readFileSync(join(REFERENCE_DIR, "prices.csv"), "utf8");
    expect(prices).toContain("2025-01-02,yahoo:GLD,240.1");
    writeFileSync(join(dir, "prices.csv"), prices.replace("2025-01-02,yahoo:GLD,240.1", "2025-01-02,yahoo:GLD,300.1"));
    expect((await sdkBacktestGolden(localDeps(), COMMIT, dir)).problems.join()).toContain("differs from its golden output");
    expect(goldenProblems("a\nb", "a\nb")).toEqual([]);
    expect(goldenProblems("a\nc", "a\nb").join()).toContain("line 2");
  });
});

describe("V09-sdk-universe-check (SDK 0.2.0)", () => {
  test("passes for the reference holdings; red: a holding over its cap exits 2", async () => {
    expect((await sdkUniverseCheck(localDeps(), COMMIT)).problems).toEqual([]);
    const dir = homeScratch("sdk-ref-test-");
    cleanup.push(dir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "holdings.json"), JSON.stringify({ neutral: { BTC: 60, USDC: 40 } }));
    const red = await sdkUniverseCheck(localDeps(), COMMIT, dir);
    expect(red.problems.join()).toContain("universe:check exited 2");
  });
});
