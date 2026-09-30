// T26, the READING half — what `/version` says about the SPA the api is
// serving. The image's own commit/tag proves nothing about `_static`: it is a
// read-only bind of a directory assembled on the deploy host, so a redeploy
// that forgot `bun run static:assemble` leaves the RIGHT api serving the WRONG
// frontend, with every AC-ID-03 check still green. This is the field that makes
// that visible.
import { describe, expect, test } from "bun:test";
import { resolveBuildIdentity } from "../src/ops/build-identity.ts";
import { staticIdentityFrom } from "../src/ops/static-identity.ts";

const image = resolveBuildIdentity({ RM_BUILD_COMMIT: "abc123", RM_BUILD_TAG: "v0.5.0-rc.3" });
const manifest = JSON.stringify({
  schema: 1,
  commit: "abc123",
  tag: "v0.5.0-rc.3",
  digest: "sha256:" + "0".repeat(64),
  files: 12,
  generated_at: "2026-09-14T00:00:00.000Z",
});

describe("staticIdentityFrom", () => {
  test("reports the digest and agrees with the image when they were built from one tree", () => {
    expect(staticIdentityFrom(manifest, image)).toEqual({
      digest: "sha256:" + "0".repeat(64),
      commit: "abc123",
      tag: "v0.5.0-rc.3",
      files: 12,
      generated_at: "2026-09-14T00:00:00.000Z",
      matches_image: true,
    });
  });

  test("a SPA assembled from another commit than the image is reported as a mismatch", () => {
    const other = JSON.parse(manifest);
    other.commit = "def456";
    const out = staticIdentityFrom(JSON.stringify(other), image);
    expect(out.matches_image).toBe(false);
    expect(out.commit).toBe("def456");
  });

  test("no manifest at all is `unavailable` with the reason named — never absent, never guessed", () => {
    const out = staticIdentityFrom(null, image);
    expect(out.digest).toBeNull();
    expect(out.matches_image).toBe(false);
    expect(String(out.unavailable)).toMatch(/manifest/i);
  });

  test("an unparseable manifest is unavailable, not a crash and not a partial read", () => {
    const out = staticIdentityFrom("{not json", image);
    expect(out.digest).toBeNull();
    expect(String(out.unavailable)).toMatch(/parse|json/i);
  });

  test("a manifest missing its digest is unavailable — a shape check, not a cast", () => {
    const out = staticIdentityFrom(JSON.stringify({ schema: 1, commit: "abc123" }), image);
    expect(out.digest).toBeNull();
    expect(String(out.unavailable)).toMatch(/digest/i);
  });

  test("an image with no identity of its own cannot be 'matched' by anything", () => {
    const blind = resolveBuildIdentity({});
    expect(staticIdentityFrom(manifest, blind).matches_image).toBe(false);
  });
});
