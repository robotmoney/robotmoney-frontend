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

import { judgeDrawProblems, type JudgeDrawObservation } from "../../release/version-checks/v0.6.3/judge-draw.ts";
import { homeProblems, type HomeObservation } from "../../release/version-checks/v0.6.3/home-monument.ts";

describe("judge-draw (1406)", () => {
  const OK: JudgeDrawObservation = {
    module: { code: 0, count: 3 },
    openapi: { status: 200, text: readFileSync(join(PUB, "openapi.json"), "utf8") },
    skill: { status: 200, text: readFileSync(join(PUB, "skills/swarm-onboarding/SKILL.md"), "utf8") },
  };
  test("the committed openapi and skill, and a module with the rule, pass", () => {
    expect(judgeDrawProblems(OK)).toEqual([]);
  });
  test("red: no api container, a module without the rule, the pre-1406 openapi and skill, a 404", () => {
    expect(judgeDrawProblems({ ...OK, module: null }).join()).toContain("no running api container");
    expect(judgeDrawProblems({ ...OK, module: { code: 1, count: 0 } }).join()).toContain("does not carry the rule");
    const old = judgeDrawProblems({
      ...OK,
      openapi: { status: 200, text: "A session has one judge of record: the active judge that comes first by member id" },
      skill: { status: 200, text: "One judgement per session is adopted" },
    }).join();
    expect(old).toContain("does not describe the draw");
    expect(old).toContain("lowest member id");
    expect(old).toContain("drawn at random");
    expect(judgeDrawProblems({ ...OK, openapi: { status: 404, text: "" } }).join()).toContain("/openapi.json answered 404");
  });
});

describe("home-monument (1388)", () => {
  const OK: HomeObservation = { view: served("assets/js/app/alpine/views/home.js"), scene: { status: 200 }, image: { status: 200 } };
  test("the committed home view and 200 assets pass", () => {
    expect(homeProblems(OK)).toEqual([]);
  });
  test("red: the home view that still resolves avatars by the curated logo only, a 404 scene and image", () => {
    const before = OK.view.text.replaceAll("memberAvatarSrc", "memberLogo");
    expect(homeProblems({ ...OK, view: { status: 200, text: before } }).join()).toContain("memberAvatarSrc");
    const p = homeProblems({ ...OK, scene: { status: 404 }, image: { status: 404 } }).join();
    expect(p).toContain("scene.js answered 404");
    expect(p).toContain("pyramid.jpg answered 404");
  });
});
