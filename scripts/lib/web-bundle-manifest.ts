// The pure half of a web bundle (docs/technical/web-serving-architecture.md §3.1,
// issue 1626): the bundle's file name, its in-bundle sha256 manifest, and the
// digest statement the control machine signs. No filesystem, no subprocess:
// scripts/lib/web-bundle.ts does the I/O and calls these.
//
// A bundle is `robotmoney-web-<version>-<commit>.tar.gz`. It carries
// `version.json` (the output of scripts/web-client/version.ts) and
// BUNDLE_MANIFEST_FILENAME, which lists every OTHER file with its sha256 and
// size. Beside it sit `<name>.sha256` (the digest statement) and
// `<name>.sha256.sig` (an `ssh-keygen -Y sign` signature over that statement in
// WEB_BUNDLE_SIGNATURE_NAMESPACE). The statement names the tarball's sha256 AND
// its file name, so one signature binds the bytes, the version and the commit.

/**
 * The signature namespace every web bundle is signed under, and the only one a
 * host accepts. Distinct from the rollout receipts' `rollout-receipt.v1`, so a
 * signature made over anything else never verifies as a bundle. Versioned: a
 * change to what the signed statement means gets `@v2`.
 */
export const WEB_BUNDLE_SIGNATURE_NAMESPACE = "robotmoney-web-bundle@v1";

/** The manifest inside the bundle. Never listed in itself. */
export const BUNDLE_MANIFEST_FILENAME = ".rm-bundle-manifest.json";

/** The format tag inside the manifest. */
export const BUNDLE_MANIFEST_FORMAT = "robotmoney-web-bundle-manifest@v1";

export interface BundleFileEntry {
  /** Bundle-relative, `/`-separated. */
  path: string;
  sha256: string;
  size: number;
}

export interface BundleManifest {
  format: typeof BUNDLE_MANIFEST_FORMAT;
  files: BundleFileEntry[];
}

export interface BundleIdentity {
  version: string;
  commit: string;
}

const COMMIT_RE = /^[0-9a-f]{7,40}$/;
const VERSION_RE = /^[0-9A-Za-z.+-]+$/;
const NAME_RE = /^robotmoney-web-([0-9A-Za-z.+-]+)-([0-9a-f]{7,40})\.tar\.gz$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

/** Bytewise path order, so the same tree always lists in the same order. */
export function comparePaths(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * A path that can be written under a destination without escaping it: relative,
 * `/`-separated, no empty, `.` or `..` segment, no backslash, no NUL.
 */
export function isSafeBundlePath(path: string): boolean {
  if (!path || path.startsWith("/") || path.includes("\\") || path.includes("\0")) return false;
  return path.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");
}

export function bundleFileName(id: BundleIdentity): string {
  if (!VERSION_RE.test(id.version)) throw new Error(`web bundle: version ${JSON.stringify(id.version)} is not a file-name-safe version`);
  if (!COMMIT_RE.test(id.commit)) throw new Error(`web bundle: commit ${JSON.stringify(id.commit)} is not a hex commit`);
  return `robotmoney-web-${id.version}-${id.commit}.tar.gz`;
}

/** The identity a bundle's file name claims, or null when it is not a bundle name. */
export function parseBundleFileName(name: string): BundleIdentity | null {
  const m = NAME_RE.exec(name);
  return m ? { version: m[1], commit: m[2] } : null;
}

/** The version and commit `version.json` declares, or null when it declares no usable pair. */
export function identityFromVersionJson(text: string): BundleIdentity | null {
  try {
    const v = JSON.parse(text) as { version?: unknown; commit?: unknown };
    if (typeof v.version !== "string" || typeof v.commit !== "string") return null;
    if (!VERSION_RE.test(v.version) || !COMMIT_RE.test(v.commit)) return null;
    return { version: v.version, commit: v.commit };
  } catch {
    return null;
  }
}

/** Canonical manifest bytes: entries sorted by path, fixed key order, trailing newline. */
export function serialiseBundleManifest(entries: BundleFileEntry[]): string {
  const files = [...entries]
    .sort((a, b) => comparePaths(a.path, b.path))
    .map((e) => ({ path: e.path, sha256: e.sha256, size: e.size }));
  const manifest: BundleManifest = { format: BUNDLE_MANIFEST_FORMAT, files };
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/** The parsed manifest, or null when it is not a well-formed v1 manifest. */
export function parseBundleManifest(text: string): BundleManifest | null {
  try {
    const m = JSON.parse(text) as { format?: unknown; files?: unknown };
    if (m.format !== BUNDLE_MANIFEST_FORMAT || !Array.isArray(m.files)) return null;
    const files: BundleFileEntry[] = [];
    for (const f of m.files as Array<Record<string, unknown>>) {
      if (typeof f?.path !== "string" || typeof f.sha256 !== "string" || typeof f.size !== "number") return null;
      if (!isSafeBundlePath(f.path) || !SHA256_RE.test(f.sha256)) return null;
      files.push({ path: f.path, sha256: f.sha256, size: f.size });
    }
    return { format: BUNDLE_MANIFEST_FORMAT, files };
  } catch {
    return null;
  }
}

/**
 * Why the files a bundle carries do not match its manifest, or null when every
 * file is listed with its exact digest and size and every listed file is there.
 */
export function manifestMismatch(manifest: BundleManifest, actual: BundleFileEntry[]): string | null {
  const listed = new Map(manifest.files.map((f) => [f.path, f]));
  if (listed.size !== manifest.files.length) return "manifest lists a path twice";
  const seen = new Set<string>();
  for (const a of actual) {
    const l = listed.get(a.path);
    if (!l) return `${a.path} is not in the manifest`;
    if (l.sha256 !== a.sha256 || l.size !== a.size) return `${a.path} does not match its manifest digest`;
    seen.add(a.path);
  }
  for (const l of manifest.files) if (!seen.has(l.path)) return `${l.path} is in the manifest but not in the bundle`;
  return null;
}

/** The signed digest statement: `sha256sum` format, one line. */
export function digestStatement(sha256: string, fileName: string): string {
  return `${sha256}  ${fileName}\n`;
}
