import { describe, expect, test } from "bun:test";
import { viewFor } from "../../frontend/public/assets/js/app/routes.js";

describe("frontend route resolution", () => {
  test("resolves static routes to matching fragments", () => {
    expect(viewFor("/")).toBe("/views/home.html");
    expect(viewFor("/allocation")).toBe("/views/allocation.html");
    expect(viewFor("/research/channel-divergence")).toBe("/views/research/channel-divergence.html");
  });

  test("resolves dynamic committee routes to reusable fragments", () => {
    expect(viewFor("/committee/members/athena")).toBe("/views/committee/member.html");
    expect(viewFor("/committee/2026-07-01/woon")).toBe("/views/committee/session.html");
  });
});
