// `bun run scripts/capture-analytics-originals.ts <commit>` captures the backend
// side of the issue 1421 original evidence into
// packages/analyst-sdk/tests/fixtures/originals/ (the one shared location, so
// the SDK and backend tests compare against the same bytes).
//
// Run it ONLY on an unmodified tree at <commit> (the pre-refactor baseline),
// after packages/analyst-sdk/scripts/capture-originals.ts. It drives the
// production orchestrator (runAnalytics, toolId "regime") over each input
// variant with a network-free fixture source and an in-memory persistence, and
// records exactly what the run submits in its terminal package:
//   backend-regime-snapshots-<v>.json.gz  the regime_snapshots output artifact bytes
//                                          (buildOutputArtifact, as the store writes them)
//   backend-report-<v>.json.gz            the report bytes (stored as submitted)
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { runAnalytics } from "../src/analytics/index.ts";
import { buildOutputArtifact } from "../src/analytics/output-snapshots.ts";
import { noopTelemetrySink } from "../src/analytics/telemetry.ts";
import {
  ORIGINALS_DIR,
  VARIANTS,
  originalFile,
  sha256,
  type OriginalsManifest,
} from "../../packages/analyst-sdk/tests/support/originals.ts";
import { inMemoryPersistence, variantInputs, variantSource } from "../tests/support/originals-source.ts";

const codeCommit = process.argv[2];
if (!codeCommit || !/^[0-9a-f]{40}$/.test(codeCommit)) {
  console.error("usage: bun run scripts/capture-analytics-originals.ts <40-char commit sha the tree is at>");
  process.exit(2);
}
const manifestPath = join(ORIGINALS_DIR, "manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as OriginalsManifest;
if (manifest.origin.codeCommit !== codeCommit) throw new Error(`manifest origin is ${manifest.origin.codeCommit}, not ${codeCommit}`);
const command = `cd backend && bun run scripts/capture-analytics-originals.ts ${codeCommit}`;
if (!manifest.origin.commands.includes(command)) manifest.origin.commands.push(command);

const producedBy = "backend/scripts/capture-analytics-originals.ts";
function put(file: string, content: string, variant: (typeof VARIANTS)[number], describes: string) {
  const gz = gzipSync(Buffer.from(content, "utf8"), { level: 9 });
  writeFileSync(join(ORIGINALS_DIR, file), gz);
  manifest.originals = manifest.originals.filter((o) => o.file !== file);
  manifest.originals.push({ file, fileSha256: sha256(gz), contentSha256: sha256(content), byteLength: Buffer.byteLength(content), kind: "report", variant, describes, producedBy });
  console.log(`${file}: ${Buffer.byteLength(content)} bytes (${gz.length} gz)`);
}

for (const v of VARIANTS) {
  const inputs = variantInputs(v);
  const persistence = inMemoryPersistence();
  await runAnalytics(inputs.asof, "regime", variantSource(inputs), persistence, noopTelemetrySink);
  const pkg = persistence.packages[0];
  if (!pkg || pkg.status !== "succeeded" || !pkg.reportBytes) throw new Error(`${v}: the run did not submit a succeeded package`);
  const rows = new TextDecoder().decode(buildOutputArtifact("regime_snapshots", pkg.regimeSnapshots ?? []).bytes);
  put(originalFile.backendRows(v), rows, v, `regime_snapshots artifact bytes of runAnalytics(${inputs.asof}, "regime") over the ${v} variant`);
  put(originalFile.backendReport(v), new TextDecoder().decode(pkg.reportBytes), v, `report bytes of runAnalytics(${inputs.asof}, "regime") over the ${v} variant`);
}

manifest.originals.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
