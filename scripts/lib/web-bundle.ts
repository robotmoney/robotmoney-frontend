// Pack, sign and verify a web bundle (docs/technical/web-serving-architecture.md
// §3.1, issue 1626). Deploying one is P5, not here.
//
//   bun scripts/lib/web-bundle.ts pack <assembled-dir> <out-dir>
//   bun scripts/lib/web-bundle.ts sign <bundle.tar.gz> <private-key>
//   bun scripts/lib/web-bundle.ts verify <bundle.tar.gz> <dest-dir> [allowed-signers]
//
// PACK takes the output of scripts/static-assembly.sh and writes
// `robotmoney-web-<version>-<commit>.tar.gz` plus `<name>.sha256`. The tarball
// is deterministic: entries sorted by path, mode 0644, uid/gid 0, empty owner
// names, mtime 0, and a gzip header with no name and mtime 0 (node:zlib writes
// both as zero). Packing the same tree twice gives the same bytes, whatever the
// files' mtimes or owners on disk.
//
// SIGN signs `<name>.sha256` with `ssh-keygen -Y sign` under
// WEB_BUNDLE_SIGNATURE_NAMESPACE and writes `<name>.sha256.sig`. The statement
// holds the tarball's sha256 and its file name, so the one signature covers the
// bytes, the version and the commit. The signing and verifying calls are the
// ones the rollout receipts already use (backend/scripts/lib/rollout-signing.ts).
//
// VERIFY accepts a bundle only when, in this order: its name is a bundle name,
// its digest statement names exactly this tarball and its sha256, a key in the
// allowed-signers file signed that statement in the web-bundle namespace, every
// tar entry is a regular file at a safe path, the manifest matches every file,
// and `version.json` names the same version and commit as the file name. Only
// then is anything written: the files go to a staging directory beside
// `<dest-dir>`, which is renamed into place. Any failure writes nothing.
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { resolveSigner, signDetached } from "../../backend/scripts/lib/rollout-signing.ts";
import {
  BUNDLE_MANIFEST_FILENAME,
  WEB_BUNDLE_SIGNATURE_NAMESPACE,
  bundleFileName,
  comparePaths,
  digestStatement,
  identityFromVersionJson,
  isSafeBundlePath,
  manifestMismatch,
  parseBundleFileName,
  parseBundleManifest,
  serialiseBundleManifest,
  type BundleFileEntry,
} from "./web-bundle-manifest.ts";

export const repoRoot = join(import.meta.dir, "..", "..");

/** The committed trust root a host verifies against. Public keys only. */
export const WEB_BUNDLE_ALLOWED_SIGNERS = join(repoRoot, "website-server", "allowed-signers");

export interface TarFile {
  path: string;
  data: Uint8Array;
}

function sha256Hex(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

// ---- ustar ---------------------------------------------------------------

const BLOCK = 512;
const enc = new TextEncoder();
const dec = new TextDecoder("utf-8", { fatal: true });

function putString(h: Uint8Array, off: number, len: number, s: string): void {
  const b = enc.encode(s);
  if (b.length > len) throw new Error(`tar: field too long: ${s}`);
  h.set(b, off);
}

function putOctal(h: Uint8Array, off: number, len: number, n: number): void {
  putString(h, off, len, `${n.toString(8).padStart(len - 1, "0")}\0`);
}

function splitUstarName(path: string): { name: string; prefix: string } {
  if (enc.encode(path).length <= 100) return { name: path, prefix: "" };
  for (let i = path.lastIndexOf("/"); i > 0; i = path.lastIndexOf("/", i - 1)) {
    const prefix = path.slice(0, i);
    const name = path.slice(i + 1);
    if (enc.encode(prefix).length <= 155 && enc.encode(name).length <= 100) return { name, prefix };
  }
  throw new Error(`tar: path too long for ustar: ${path}`);
}

function header(path: string, size: number): Uint8Array {
  const h = new Uint8Array(BLOCK);
  const { name, prefix } = splitUstarName(path);
  putString(h, 0, 100, name);
  putOctal(h, 100, 8, 0o644);
  putOctal(h, 108, 8, 0);
  putOctal(h, 116, 8, 0);
  putOctal(h, 124, 12, size);
  putOctal(h, 136, 12, 0);
  h.fill(0x20, 148, 156);
  h[156] = 0x30; // '0': regular file
  putString(h, 257, 6, "ustar\0");
  putString(h, 263, 2, "00");
  putString(h, 345, 155, prefix);
  let sum = 0;
  for (const b of h) sum += b;
  putString(h, 148, 8, `${sum.toString(8).padStart(6, "0")}\0 `);
  return h;
}

/** A deterministic ustar archive of `files`, in the order given. */
export function writeTar(files: TarFile[]): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const f of files) {
    parts.push(header(f.path, f.data.length), f.data);
    const pad = (BLOCK - (f.data.length % BLOCK)) % BLOCK;
    if (pad) parts.push(new Uint8Array(pad));
  }
  parts.push(new Uint8Array(BLOCK * 2));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function readField(h: Uint8Array, off: number, len: number): string {
  const f = h.subarray(off, off + len);
  const nul = f.indexOf(0);
  return dec.decode(nul === -1 ? f : f.subarray(0, nul));
}

/**
 * The regular files in a ustar archive. Throws on anything else: a link, a
 * directory entry, an unsafe path, a duplicate, a bad checksum or a truncation.
 */
export function readTar(tar: Uint8Array): TarFile[] {
  const files: TarFile[] = [];
  const seen = new Set<string>();
  let off = 0;
  for (;;) {
    if (off + BLOCK > tar.length) throw new Error("tar: truncated");
    const h = tar.subarray(off, off + BLOCK);
    if (h.every((b) => b === 0)) return files;
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : h[i];
    if (Number.parseInt(readField(h, 148, 8).trim(), 8) !== sum) throw new Error("tar: bad header checksum");
    const type = h[156];
    const name = readField(h, 0, 100);
    const prefix = readField(h, 345, 155);
    const path = prefix ? `${prefix}/${name}` : name;
    if (type !== 0x30 && type !== 0) throw new Error(`tar: ${path} is not a regular file`);
    if (!isSafeBundlePath(path)) throw new Error(`tar: unsafe path ${JSON.stringify(path)}`);
    if (seen.has(path)) throw new Error(`tar: ${path} appears twice`);
    seen.add(path);
    const size = Number.parseInt(readField(h, 124, 12).trim(), 8);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error(`tar: ${path} has a bad size`);
    off += BLOCK;
    if (off + size > tar.length) throw new Error("tar: truncated");
    files.push({ path, data: tar.slice(off, off + size) });
    off += Math.ceil(size / BLOCK) * BLOCK;
  }
}

// ---- pack ----------------------------------------------------------------

function collectTree(root: string): TarFile[] {
  const out: TarFile[] = [];
  const walk = (dir: string, rel: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const path = rel ? `${rel}/${name}` : name;
      const st = lstatSync(full);
      if (st.isDirectory()) walk(full, path);
      else if (st.isFile()) out.push({ path, data: readFileSync(full) });
      else throw new Error(`web bundle: ${path} is not a regular file or directory`);
    }
  };
  walk(root, "");
  return out;
}

export interface PackedBundle {
  /** Absolute path of the tarball. */
  path: string;
  /** Absolute path of the digest statement beside it. */
  digestPath: string;
  sha256: string;
  version: string;
  commit: string;
}

/** Pack an assembled site directory into `outDir`. */
export function packBundle(srcDir: string, outDir: string): PackedBundle {
  const files = collectTree(srcDir);
  if (files.some((f) => f.path === BUNDLE_MANIFEST_FILENAME)) {
    throw new Error(`web bundle: ${BUNDLE_MANIFEST_FILENAME} is written by the packer and must not be in the source`);
  }
  const versionFile = files.find((f) => f.path === "version.json");
  const id = versionFile ? identityFromVersionJson(dec.decode(versionFile.data)) : null;
  if (!id) throw new Error("web bundle: version.json is missing or names no version and commit");
  const entries: BundleFileEntry[] = files.map((f) => ({ path: f.path, sha256: sha256Hex(f.data), size: f.data.length }));
  files.push({ path: BUNDLE_MANIFEST_FILENAME, data: enc.encode(serialiseBundleManifest(entries)) });
  files.sort((a, b) => comparePaths(a.path, b.path));

  const gz = gzipSync(writeTar(files), { level: 9 });
  const name = bundleFileName(id);
  const sha256 = sha256Hex(gz);
  mkdirSync(outDir, { recursive: true });
  const path = join(outDir, name);
  writeFileSync(path, gz);
  writeFileSync(`${path}.sha256`, digestStatement(sha256, name));
  return { path, digestPath: `${path}.sha256`, sha256, ...id };
}

// ---- sign ----------------------------------------------------------------

/** Sign a packed bundle's digest statement. Returns the signature path. */
export function signBundle(bundlePath: string, keyPath: string, namespace: string = WEB_BUNDLE_SIGNATURE_NAMESPACE): string {
  const sig = signDetached(readFileSync(`${bundlePath}.sha256`, "utf8"), keyPath, namespace);
  if (!sig) throw new Error(`web bundle: ssh-keygen could not sign with ${keyPath}`);
  writeFileSync(`${bundlePath}.sha256.sig`, sig);
  return `${bundlePath}.sha256.sig`;
}

// ---- verify --------------------------------------------------------------

export type VerifyResult =
  | { ok: true; dest: string; principal: string; sha256: string; version: string; commit: string }
  | { ok: false; reason: string };

export interface VerifyOptions {
  /** Defaults to the committed WEB_BUNDLE_ALLOWED_SIGNERS. */
  allowedSigners?: string;
}

function readOrNull(path: string): Uint8Array | null {
  try {
    return readFileSync(path);
  } catch {
    return null;
  }
}

/** Every check before anything is written. Returns the files to write, or why not. */
function checkBundle(bundlePath: string, allowedSigners: string): { files: TarFile[]; principal: string; sha256: string; version: string; commit: string } | string {
  const name = basename(bundlePath);
  const id = parseBundleFileName(name);
  if (!id) return `${name} is not a web bundle file name`;

  const gz = readOrNull(bundlePath);
  if (!gz) return `${name} cannot be read`;
  const sha256 = sha256Hex(gz);

  const statementBytes = readOrNull(`${bundlePath}.sha256`);
  if (!statementBytes) return "the digest file is missing";
  const statement = new TextDecoder().decode(statementBytes);
  if (statement !== digestStatement(sha256, name)) return "the digest file does not name this bundle's sha256";

  const sigBytes = readOrNull(`${bundlePath}.sha256.sig`);
  if (!sigBytes) return "the signature is missing";
  const principal = resolveSigner({
    payload: statement,
    signature: new TextDecoder().decode(sigBytes),
    allowedSigners,
    namespace: WEB_BUNDLE_SIGNATURE_NAMESPACE,
  });
  if (!principal) return `no key in ${allowedSigners} signed this bundle in namespace ${WEB_BUNDLE_SIGNATURE_NAMESPACE}`;

  let files: TarFile[];
  try {
    files = readTar(gunzipSync(gz));
  } catch (e) {
    return `the tarball is not a valid bundle: ${(e as Error).message}`;
  }
  const manifestFile = files.find((f) => f.path === BUNDLE_MANIFEST_FILENAME);
  const manifest = manifestFile ? parseBundleManifest(new TextDecoder().decode(manifestFile.data)) : null;
  if (!manifest) return "the bundle carries no valid manifest";
  const content = files.filter((f) => f.path !== BUNDLE_MANIFEST_FILENAME);
  const mismatch = manifestMismatch(
    manifest,
    content.map((f) => ({ path: f.path, sha256: sha256Hex(f.data), size: f.data.length })),
  );
  if (mismatch) return mismatch;

  const versionFile = content.find((f) => f.path === "version.json");
  const declared = versionFile ? identityFromVersionJson(new TextDecoder().decode(versionFile.data)) : null;
  if (!declared || declared.version !== id.version || declared.commit !== id.commit) {
    return "version.json does not name the version and commit in the file name";
  }
  return { files, principal, sha256, ...id };
}

/**
 * Verify a bundle and, only if every check passes, extract it to `dest`.
 * `dest` must not exist. A failure writes nothing.
 */
export function verifyBundle(bundlePath: string, dest: string, opts: VerifyOptions = {}): VerifyResult {
  if (existsSync(dest)) return { ok: false, reason: `${dest} already exists` };
  const checked = checkBundle(bundlePath, opts.allowedSigners ?? WEB_BUNDLE_ALLOWED_SIGNERS);
  if (typeof checked === "string") return { ok: false, reason: checked };

  const staging = join(dirname(dest), `.${basename(dest)}.partial-${process.pid}-${Date.now()}`);
  try {
    for (const f of checked.files) {
      const target = join(staging, f.path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, f.data);
    }
    renameSync(staging, dest);
  } catch (e) {
    rmSync(staging, { recursive: true, force: true });
    return { ok: false, reason: `extraction failed: ${(e as Error).message}` };
  }
  const { files: _files, ...rest } = checked;
  return { ok: true, dest, ...rest };
}

if (import.meta.main) {
  const [cmd, a, b, c] = process.argv.slice(2);
  if (cmd === "pack" && a && b) {
    const p = packBundle(a, b);
    console.log(`${p.path}\nsha256 ${p.sha256}`);
  } else if (cmd === "sign" && a && b) {
    console.log(signBundle(a, b));
  } else if (cmd === "verify" && a && b) {
    const r = verifyBundle(a, b, { allowedSigners: c });
    if (!r.ok) {
      console.error(`refused: ${r.reason}`);
      process.exit(1);
    }
    console.log(`verified ${basename(a)} (signer ${r.principal}) -> ${r.dest}`);
  } else {
    console.error("usage: web-bundle.ts pack <dir> <out-dir> | sign <bundle> <key> | verify <bundle> <dest> [allowed-signers]");
    process.exit(2);
  }
}
