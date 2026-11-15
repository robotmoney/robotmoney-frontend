// Q41-web-bundle/C29-web-bundle (web serving P3 1638; R1, R13): what the public origin serves is a signed
// bundle, byte for byte. Runs on the CONTROL MACHINE (receipt printed: --receipt-dir -), read-only towards
// the target: GETs through the public origin, `gh release download` of public release assets, and
// `git show` of the release commit's allowed-signers file.
//
// WHAT IT REQUIRES:
//   - `/version.json` names a version and commit; the bundle of that version is the GitHub release asset
//     `robotmoney-web-<version>-<commit>.tar.gz` of the tag `web-v<version>` (W12 publishes it, and
//     `bun smoke:web --bundle web-vA.B.C` deploys from it);
//   - the bundle VERIFIES against the release commit's website-server/allowed-signers in the namespace
//     robotmoney-web-bundle@v1: its digest file names its sha256, the signature is good, and its manifest
//     and version.json check out (scripts/lib/web-bundle.ts verifyBundle, the host's own rule);
//   - the bundle's version.json names the same version and commit as the served /version.json;
//   - EVERY file of the bundle's manifest, fetched through the public origin at the URL it is served at with
//     a one-off query (so no cache answers), has the manifest's sha256 (web-serving §5.2 live check 3).
// A platform release keeps the bundle the host serves (§5.3), so the bundle's commit is the web release's,
// not this platform release's: `found.bundleCommit` records it. Stage and production serve the same bundle
// bytes when they serve the same web tag (R13): compare `found.sha256` across the two receipts.
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { verifyBundle } from "../../../lib/web-bundle.ts";
import { BUNDLE_MANIFEST_FILENAME, identityFromVersionJson, parseBundleManifest, type BundleManifest } from "../../../lib/web-bundle-manifest.ts";
import { manifestUrlPath } from "../../web-release-lib.ts";
import type { VersionCheck } from "../../version-check.ts";

export interface Served {
  readonly path: string;
  readonly url: string;
  readonly status: number;
  readonly sha256: string | null;
}

/** PURE. The web tag a served /version.json belongs to, or why there is none. */
export function webTagOf(versionJson: string | null): { tag: string; version: string; commit: string } | { error: string } {
  if (versionJson === null) return { error: "/version.json did not answer 200" };
  const id = identityFromVersionJson(versionJson);
  if (id === null) return { error: `/version.json names no version and commit: ${versionJson.slice(0, 120)}` };
  return { tag: `web-v${id.version}`, ...id };
}

/** PURE. Where the served files differ from the bundle's manifest; empty when every file is served as signed. */
export function servedBundleProblems(manifest: BundleManifest, served: readonly Served[]): string[] {
  const out: string[] = [];
  const byPath = new Map(served.map((s) => [s.path, s]));
  for (const f of manifest.files) {
    const s = byPath.get(f.path);
    if (s === undefined) out.push(`${f.path}: not fetched`);
    else if (s.status !== 200) out.push(`GET ${s.url} answered ${s.status}, not the bundle's ${f.path}`);
    else if (s.sha256 !== f.sha256) out.push(`GET ${s.url} serves sha256 ${(s.sha256 ?? "?").slice(0, 16)}, not the manifest's ${f.path} (${f.sha256.slice(0, 16)})`);
  }
  if (manifest.files.length === 0) out.push("the bundle's manifest lists no file");
  return out;
}

const encodePath = (p: string): string => p.split("/").map((s) => encodeURIComponent(s)).join("/");

export default (async (ctx) => {
  if (!ctx.commit) return { found: {}, problems: ["the step passes no --commit, so the release's allowed-signers file cannot be read"] };
  const v = await ctx.http(`/version.json?rm-v090-bundle=${Date.now()}`);
  const web = webTagOf(v.status === 200 ? v.text : null);
  if ("error" in web) return { found: {}, problems: [web.error] };
  const work = mkdtempSync(join(tmpdir(), "rm-v090-web-bundle-"));
  try {
    const dl = Bun.spawnSync(["gh", "release", "download", web.tag, "--pattern", "robotmoney-web-*", "--dir", join(work, "in")], { stdout: "pipe", stderr: "pipe" });
    if (dl.exitCode !== 0) {
      return { found: { tag: web.tag, servedVersion: web.version, servedCommit: web.commit }, problems: [`no signed bundle is published for the served site: gh release download ${web.tag} failed (${dl.stderr.toString().trim().slice(0, 200)})`] };
    }
    const tarball = readdirSync(join(work, "in")).find((f) => f.endsWith(".tar.gz"));
    if (tarball === undefined) return { found: { tag: web.tag }, problems: [`the release ${web.tag} carries no robotmoney-web-*.tar.gz`] };
    const signers = Bun.spawnSync(["git", "show", `${ctx.commit}:website-server/allowed-signers`], { stdout: "pipe", stderr: "pipe" });
    if (signers.exitCode !== 0) return { found: { tag: web.tag }, problems: [`git show ${ctx.commit}:website-server/allowed-signers failed: ${signers.stderr.toString().trim()}`] };
    const signersPath = join(work, "allowed-signers");
    writeFileSync(signersPath, signers.stdout);
    const verified = verifyBundle(join(work, "in", tarball), join(work, "out"), { allowedSigners: signersPath });
    if (!verified.ok) return { found: { tag: web.tag, bundle: tarball }, problems: [`${tarball} fails verification against the release's allowed-signers: ${verified.reason}`] };
    const problems: string[] = [];
    if (verified.version !== web.version || verified.commit !== web.commit) problems.push(`the bundle names ${verified.version} at ${verified.commit}, the origin's /version.json ${web.version} at ${web.commit}`);
    const manifest = parseBundleManifest(readFileSync(join(work, "out", BUNDLE_MANIFEST_FILENAME), "utf8"));
    if (manifest === null) return { found: { tag: web.tag }, problems: [...problems, "the verified bundle's manifest does not parse"] };
    const bust = `rm-v090-bundle=${verified.commit.slice(0, 8)}-${Date.now()}`;
    const served: Served[] = [];
    for (const f of manifest.files) {
      const url = manifestUrlPath(f.path);
      const res = await fetch(`${ctx.origin}${encodePath(url)}?${bust}`, { signal: AbortSignal.timeout(30_000) });
      const bytes = res.status === 200 ? new Uint8Array(await res.arrayBuffer()) : null;
      served.push({ path: f.path, url, status: res.status, sha256: bytes === null ? null : createHash("sha256").update(bytes).digest("hex") });
    }
    problems.push(...servedBundleProblems(manifest, served));
    return {
      found: { tag: web.tag, bundle: tarball, sha256: verified.sha256, signer: verified.principal, bundleCommit: verified.commit, releaseCommit: ctx.commit, files: manifest.files.length, matched: served.filter((s, i) => s.status === 200 && s.sha256 === manifest.files[i]!.sha256).length },
      problems,
    };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}) satisfies VersionCheck;
