// T26 — WHAT THE SERVED SPA IS, as a digest rather than as an assumption.
//
// `docker-compose.yml` mounts `./_static` into the api container read-only, and
// `_static` is a BUILD OUTPUT assembled on the deploy host by
// `scripts/static-assembly.sh`. The image carries `RM_BUILD_COMMIT` /
// `RM_BUILD_TAG` and /version reports them, so AC-ID-03's API half is proved by
// a string comparison — while the half a visitor actually receives was covered
// by no identity, no digest and no check. A redeploy that forgot the assembly
// step (runbook §6 step 4 said "then static frontend" and named no command)
// leaves the right api serving last release's HTML with every identity check
// still green. This release changes files that reach users ONLY through
// `_static` (routes.js, openapi.json, llms.txt), so that gap is not theoretical.
//
// PURE. The walker that hashes real files lives in scripts/static-manifest.ts;
// everything that decides what the digest IS lives here, where it is graded
// without a filesystem.

/** The manifest's own filename inside the assembled directory. */
export const STATIC_MANIFEST_FILENAME = ".rm-static-manifest.json";

export interface StaticFileEntry {
  /** Path relative to the assembled root, with `/` separators. */
  path: string;
  /** Lowercase hex sha256 of the file's bytes. */
  sha256: string;
}

export interface StaticManifest {
  schema: 1;
  commit: string | null;
  tag: string | null;
  digest: string;
  files: number;
  generated_at: string;
}

/**
 * The tree digest: sha256 over `<path>\0<sha256>\n` for every file, sorted by
 * path.
 *
 * SORTED, so the value is a property of the CONTENT and not of the order
 * readdir happened to return — two assemblies of the same commit on two hosts
 * must produce the same string or the field proves nothing.
 *
 * NUL-SEPARATED, because `path + hash` concatenated is ambiguous: a rename can
 * be made to cancel an edit. NUL cannot appear in a POSIX path.
 *
 * PATHS ARE COVERED, not just bytes, so adding or deleting a file changes the
 * digest — deleting `llms.txt` is exactly as much a change to what is served as
 * editing it.
 */
export function digestOfEntries(entries: readonly StaticFileEntry[]): string {
  if (entries.length === 0) {
    throw new Error(
      "refusing to digest an EMPTY assembled directory: an empty _static means the api serves nothing at all " +
        "(Docker creates an empty dir for a bind path that does not exist), which is the failure this digest exists to report",
    );
  }
  const hasher = new Bun.CryptoHasher("sha256");
  for (const e of [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    hasher.update(`${e.path}\0${e.sha256}\n`);
  }
  return `sha256:${hasher.digest("hex")}`;
}

/**
 * The manifest written into the assembled directory.
 *
 * `commit`/`tag` are the identity of the tree the assembly ran in — the SAME
 * values the images are built with (scripts/stack/stack.ts resolves them once
 * and passes them to both), so /version can report whether the SPA and the API
 * came from one source. EXPLICIT OR NULL, the rule backend/src/ops/build-identity.ts
 * already applies: no package version, no timestamp, no branch name standing in
 * for an identity.
 */
export function buildStaticManifest(input: {
  commit: string;
  tag: string;
  entries: readonly StaticFileEntry[];
  generatedAt: string;
}): StaticManifest {
  if (input.entries.some((e) => e.path === STATIC_MANIFEST_FILENAME)) {
    throw new Error(
      `the static manifest must not cover itself: ${STATIC_MANIFEST_FILENAME} is written after the digest is ` +
        `computed, so including it would make the digest unreproducible`,
    );
  }
  return {
    schema: 1,
    commit: input.commit.trim() === "" ? null : input.commit.trim(),
    tag: input.tag.trim() === "" ? null : input.tag.trim(),
    digest: digestOfEntries(input.entries),
    files: input.entries.length,
    generated_at: input.generatedAt,
  };
}
