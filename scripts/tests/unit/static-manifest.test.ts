// T26 — the served SPA is a BIND MOUNT of the deploy host's `_static`, a build
// output produced outside the image and covered by no identity, digest or
// check. `/version` reported the api image's commit/tag and said nothing about
// the bytes a visitor actually receives, so AC-ID-03's frontend half was baked,
// never read.
//
// This pins the digest itself: a content hash over the assembled tree that
// changes when any served byte changes, is independent of file order and of
// where the directory sits, and excludes only the manifest it is written into.
import { describe, expect, test } from "bun:test";
import {
  STATIC_MANIFEST_FILENAME,
  buildStaticManifest,
  digestOfEntries,
  type StaticFileEntry,
} from "../../lib/static-manifest.ts";

const entries: StaticFileEntry[] = [
  { path: "index.html", sha256: "aa" },
  { path: "swarm/index.html", sha256: "bb" },
];

describe("digestOfEntries", () => {
  test("is stable and order-independent", () => {
    expect(digestOfEntries(entries)).toBe(digestOfEntries([...entries].reverse()));
  });

  test("changes when any served byte changes", () => {
    expect(digestOfEntries([{ path: "index.html", sha256: "aa" }, { path: "swarm/index.html", sha256: "bc" }]))
      .not.toBe(digestOfEntries(entries));
  });

  test("changes when a file is ADDED or REMOVED, not only edited", () => {
    expect(digestOfEntries([...entries, { path: "llms.txt", sha256: "cc" }])).not.toBe(digestOfEntries(entries));
    expect(digestOfEntries(entries.slice(0, 1))).not.toBe(digestOfEntries(entries));
  });

  test("a path and a hash cannot be confused for one another", () => {
    // Without a separator that cannot occur in a path, "ab" + "c" and "a" + "bc"
    // hash the same and a rename could be made to cancel an edit.
    expect(digestOfEntries([{ path: "ab", sha256: "c" }])).not.toBe(digestOfEntries([{ path: "a", sha256: "bc" }]));
  });

  test("is a named algorithm, not a bare hex blob", () => {
    expect(digestOfEntries(entries)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test("refuses an empty tree — an empty _static is the failure it must report", () => {
    expect(() => digestOfEntries([])).toThrow(/empty/i);
  });
});

describe("buildStaticManifest", () => {
  test("carries the build identity of the tree it was assembled from, plus the digest and file count", () => {
    const m = buildStaticManifest({ commit: "abc", tag: "v0.5.0-rc.3", entries, generatedAt: "2026-09-14T00:00:00.000Z" });
    expect(m).toEqual({
      schema: 1,
      commit: "abc",
      tag: "v0.5.0-rc.3",
      digest: digestOfEntries(entries),
      files: 2,
      generated_at: "2026-09-14T00:00:00.000Z",
    });
  });

  test("an unavailable identity is null and never a stand-in string", () => {
    const m = buildStaticManifest({ commit: "", tag: "", entries, generatedAt: "2026-09-14T00:00:00.000Z" });
    expect(m.commit).toBeNull();
    expect(m.tag).toBeNull();
  });

  test("the manifest never covers itself", () => {
    expect(STATIC_MANIFEST_FILENAME).toBe(".rm-static-manifest.json");
    expect(() => buildStaticManifest({ commit: "a", tag: "", entries: [{ path: STATIC_MANIFEST_FILENAME, sha256: "x" }], generatedAt: "t" }))
      .toThrow(/manifest/i);
  });
});
