// The pure decision of the v0.6.3 version check (scripts/release/version-checks/v0.6.3/):
// member-avatar (1393). The shipped shape is the committed site files; each red control is
// the shape before the PR, or the failure the check exists to catch.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { memberAvatarProblems, type MemberAvatarObservation } from "../../release/version-checks/v0.6.3/member-avatar.ts";

const PUB = join(import.meta.dir, "..", "..", "..", "frontend", "public");
const served = (rel: string) => ({ status: 200, text: readFileSync(join(PUB, rel), "utf8") });
const SHIPPED: MemberAvatarObservation = {
  logos: served("assets/js/app/lib/member-logos.js"),
  page: served("views/admin/swarm-member.html"),
  view: served("assets/js/app/alpine/views/admin/swarm-member.js"),
  api: served("assets/js/app/lib/api.js"),
  avatarGet: { memberId: "woon", status: 404 },
};

describe("member-avatar (1393)", () => {
  test("the committed site files and a 404 for a member with no upload pass", () => {
    expect(memberAvatarProblems(SHIPPED)).toEqual([]);
    expect(memberAvatarProblems({ ...SHIPPED, avatarGet: null })).toEqual([]);
  });
  test("red: member-logos.js before 1393 has no memberAvatarSrc and no isUploadedAvatar", () => {
    const before = SHIPPED.logos.text.replace(/\/\*\*[^]*?export function isUploadedAvatar[^]*$/, "");
    const p = memberAvatarProblems({ ...SHIPPED, logos: { status: 200, text: before } }).join();
    expect(p).toContain("no isUploadedAvatar");
    expect(p).toContain("no memberAvatarSrc");
  });
  test("red: the curated logo ahead of an upload", () => {
    const swapped = SHIPPED.logos.text.replace(
      /export function memberAvatarSrc\(handle, avatarPath\) \{[^]*?\n\}/,
      "export function memberAvatarSrc(handle, avatarPath) {\n  return memberLogo({ handle }) || (isUploadedAvatar(avatarPath) ? avatarPath : null);\n}",
    );
    expect(memberAvatarProblems({ ...SHIPPED, logos: { status: 200, text: swapped } }).join()).toContain("ahead of the curated logo");
  });
  test("red: no Avatar block, no upload call, no adminUpload, a 404 asset and a 500 avatar GET", () => {
    const p = memberAvatarProblems({
      logos: { status: 404, text: "" },
      page: { status: 200, text: SHIPPED.page.text.replaceAll('data-testid="member-avatar"', "") },
      view: { status: 200, text: SHIPPED.view.text.replaceAll("api.adminUpload(", "api.adminPost(") },
      api: { status: 200, text: SHIPPED.api.text.replaceAll("adminUpload", "adminPost2") },
      avatarGet: { memberId: "woon", status: 500 },
    }).join();
    expect(p).toContain("member-logos.js answered 404");
    expect(p).toContain("no Avatar block");
    expect(p).toContain("does not post the file");
    expect(p).toContain("no adminUpload");
    expect(p).toContain("answered 500, not 404");
  });
});
