// Issue 1442: run in a child process by tests/analytics-build-identity.test.ts,
// once under Bun and once (bundled) under Node, so the two processes differ in
// runtime and runtime version while sharing one RM_BUILD_COMMIT. Prints the
// build identity this process resolves and the manifest digest it gives a fixed
// member set.
import { resolveBuildIdentity } from "../../src/analytics/build-identity.ts";
import { buildVintageManifest } from "../../src/analytics/run-ledger.ts";

const buildIdentity = resolveBuildIdentity();
const { manifest } = buildVintageManifest(
  [
    { versionId: "1", sourceKey: "a", marketDate: "2024-01-01", marketInstant: null, value: 1 },
    { versionId: "2", sourceKey: "b", marketDate: "2024-01-02", marketInstant: null, value: 2 },
  ],
  "meth-1442",
  buildIdentity,
  "2024-06-01T00:00:00.000Z",
  "2024-01-01",
);
const runtime = typeof Bun !== "undefined" ? `bun:${Bun.version}` : `node:${process.version}`;
console.log(JSON.stringify({ runtime, buildIdentity, manifestDigest: manifest.manifestDigest }));
