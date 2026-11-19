// Q41-web-bundle/C29-web-bundle (web serving P3 1638; R1, R13): what the host serves is a signed bundle,
// byte for byte. Runs on the CONTROL MACHINE (receipt printed: --receipt-dir -) with `--host <ssh-dest>`,
// read-only towards the target: `docker ps`/`docker port` on the host over ssh, GETs of the website-server's
// own loopback port through an ssh forward, `gh release download` of public release assets, and `git show`
// of the release commit's allowed-signers file.
//
// Owner decision 2026-11-15 (issue 1647): the byte-for-byte comparison reads what the host serves UPSTREAM
// of Cloudflare, the website-server container's own port (as Q38-web-routes and Q40-web-image reach it),
// not the public Cloudflare address. Cloudflare's edge rewrites some answers (its Managed robots.txt block,
// email obfuscation in HTML), so the public bytes are not the host's bytes. What the edge serves is checked
// separately, on stage only, by Q41a-web-bundle-edge (./web-bundle-edge.ts), which shares this file's code.
//
// WHAT IT REQUIRES:
//   - exactly one website-server runs for the instance, and it publishes a loopback port for 8080;
//   - `/version.json`, read on that port, names a version and commit, and a signed bundle of exactly that name
//     exists: `robotmoney-web-<version>-<commit>.tar.gz` in this release's control-machine store (the bundle
//     the release itself deployed, scripts/release/platform-bundle.ts, v0.9.0's first rollout), else the
//     GitHub release asset of the tag `web-v<version>` (W12 publishes it for a web content release);
//   - the bundle VERIFIES against the release commit's website-server/allowed-signers in the namespace
//     robotmoney-web-bundle@v1: its digest file names its sha256, the signature is good, and its manifest
//     and version.json check out (scripts/lib/web-bundle.ts verifyBundle, the host's own rule);
//   - the bundle's version.json names the same version and commit as the served /version.json;
//   - EVERY file of the bundle's manifest, fetched on that port at the URL it is served at with a one-off
//     query, has the manifest's sha256 (web-serving §5.2 live check 3).
// A platform release keeps the bundle the host serves (§5.3), so the bundle's commit is the web release's,
// not this platform release's: `found.bundleCommit` records it. Stage and production serve the same bundle
// bytes when they serve the same web tag (R13): compare `found.sha256` across the two receipts.
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { verifyBundle } from "../../../lib/web-bundle.ts";
import { BUNDLE_MANIFEST_FILENAME, identityFromVersionJson, parseBundleManifest, type BundleManifest } from "../../../lib/web-bundle-manifest.ts";
import { manifestUrlPath } from "../../web-release-lib.ts";
import { storeDir } from "../../platform-bundle.ts";
import { bundleFileName } from "../../../lib/web-bundle-manifest.ts";
import type { VersionCheck, VersionCheckContext, VersionCheckResult } from "../../version-check.ts";
import { loopbackPort, websiteContainers } from "./_web.ts";

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

/**
 * PURE. Where the served files differ from the bundle's manifest; empty when every file is served as signed.
 * `except` names manifest paths whose bytes may differ (still answered 200): the edge check's `robots.txt`.
 */
export function servedBundleProblems(manifest: BundleManifest, served: readonly Served[], except: ReadonlySet<string> = new Set()): string[] {
  const out: string[] = [];
  const byPath = new Map(served.map((s) => [s.path, s]));
  for (const f of manifest.files) {
    const s = byPath.get(f.path);
    if (s === undefined) out.push(`${f.path}: not fetched`);
    else if (s.status !== 200) out.push(`GET ${s.url} answered ${s.status}, not the bundle's ${f.path}`);
    else if (s.sha256 !== f.sha256 && !except.has(f.path)) out.push(`GET ${s.url} serves sha256 ${(s.sha256 ?? "?").slice(0, 16)}, not the manifest's ${f.path} (${f.sha256.slice(0, 16)})`);
  }
  if (manifest.files.length === 0) out.push("the bundle's manifest lists no file");
  return out;
}

const encodePath = (p: string): string => p.split("/").map((s) => encodeURIComponent(s)).join("/");

/**
 * Fetch the bundle the origin `base` names in its /version.json, verify it, and compare every manifest file
 * `base` serves to the manifest. `via` says in the receipt which origin was read; `except` is passed to
 * servedBundleProblems.
 */
export async function checkServedBundle(ctx: Pick<VersionCheckContext, "release" | "commit">, base: string, via: string, except: ReadonlySet<string> = new Set()): Promise<VersionCheckResult> {
  if (!ctx.commit) return { found: { via }, problems: ["the step passes no --commit, so the release's allowed-signers file cannot be read"] };
  const vres = await fetch(`${base}/version.json?rm-v090-bundle=${Date.now()}`, { signal: AbortSignal.timeout(15_000) });
  const vtext = await vres.text();
  const web = webTagOf(vres.status === 200 ? vtext : null);
  if ("error" in web) return { found: { via }, problems: [web.error] };
  const work = mkdtempSync(join(tmpdir(), "rm-v090-web-bundle-"));
  try {
    const name = bundleFileName({ version: web.version, commit: web.commit });
    const stored = join(storeDir(ctx.release), name);
    let inDir = storeDir(ctx.release);
    let source = "the release's control-machine store";
    if (!existsSync(stored)) {
      inDir = join(work, "in");
      source = `the GitHub release ${web.tag}`;
      const dl = Bun.spawnSync(["gh", "release", "download", web.tag, "--pattern", "robotmoney-web-*", "--dir", inDir], { stdout: "pipe", stderr: "pipe" });
      if (dl.exitCode !== 0) {
        return { found: { via, tag: web.tag, servedVersion: web.version, servedCommit: web.commit }, problems: [`no signed bundle ${name} is in ${storeDir(ctx.release)} or published for the served site: gh release download ${web.tag} failed (${dl.stderr.toString().trim().slice(0, 200)})`] };
      }
    }
    const tarball = readdirSync(inDir).find((f) => f === name);
    if (tarball === undefined) return { found: { via, tag: web.tag, source }, problems: [`${source} carries no ${name}, the bundle the served /version.json names`] };
    const signers = Bun.spawnSync(["git", "show", `${ctx.commit}:website-server/allowed-signers`], { stdout: "pipe", stderr: "pipe" });
    if (signers.exitCode !== 0) return { found: { via, tag: web.tag }, problems: [`git show ${ctx.commit}:website-server/allowed-signers failed: ${signers.stderr.toString().trim()}`] };
    const signersPath = join(work, "allowed-signers");
    writeFileSync(signersPath, signers.stdout);
    const verified = verifyBundle(join(inDir, tarball), join(work, "out"), { allowedSigners: signersPath });
    if (!verified.ok) return { found: { via, tag: web.tag, bundle: tarball }, problems: [`${tarball} fails verification against the release's allowed-signers: ${verified.reason}`] };
    const problems: string[] = [];
    if (verified.version !== web.version || verified.commit !== web.commit) problems.push(`the bundle names ${verified.version} at ${verified.commit}, the origin's /version.json ${web.version} at ${web.commit}`);
    const manifest = parseBundleManifest(readFileSync(join(work, "out", BUNDLE_MANIFEST_FILENAME), "utf8"));
    if (manifest === null) return { found: { via, tag: web.tag }, problems: [...problems, "the verified bundle's manifest does not parse"] };
    const bust = `rm-v090-bundle=${verified.commit.slice(0, 8)}-${Date.now()}`;
    const served: Served[] = [];
    for (const f of manifest.files) {
      const url = manifestUrlPath(f.path);
      const res = await fetch(`${base}${encodePath(url)}?${bust}`, { signal: AbortSignal.timeout(30_000) });
      const bytes = res.status === 200 ? new Uint8Array(await res.arrayBuffer()) : null;
      served.push({ path: f.path, url, status: res.status, sha256: bytes === null ? null : createHash("sha256").update(bytes).digest("hex") });
    }
    problems.push(...servedBundleProblems(manifest, served, except));
    const matches = (s: Served, i: number) => s.status === 200 && s.sha256 === manifest.files[i]!.sha256;
    const excepted = served.filter((s) => except.has(s.path)).map((s) => ({ path: s.path, status: s.status, matched: s.sha256 === manifest.files.find((f) => f.path === s.path)?.sha256 }));
    return {
      found: { via, tag: web.tag, source, bundle: tarball, sha256: verified.sha256, signer: verified.principal, bundleCommit: verified.commit, releaseCommit: ctx.commit, files: manifest.files.length, matched: served.filter(matches).length, ...(except.size > 0 ? { excepted } : {}) },
      problems,
    };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

export default (async (ctx) => {
  if (!ctx.host) return { found: {}, problems: ["the step passes no --host, so the website-server's own port on the target cannot be read (owner, 2026-11-15: this check reads upstream of Cloudflare)"] };
  const { running } = websiteContainers(ctx);
  if (running.length !== 1) return { found: { host: ctx.host, running }, problems: [`${running.length} website-server containers run for the instance on ${ctx.host}, not one`] };
  const port = loopbackPort(ctx, running[0]!, 8080);
  if (port === null) return { found: { host: ctx.host, container: running[0] }, problems: ["the website-server publishes no host port for 8080"] };
  const base = await ctx.hostOrigin(port);
  return checkServedBundle(ctx, base, `${ctx.host} website-server 127.0.0.1:${port} (upstream of Cloudflare)`);
}) satisfies VersionCheck;
