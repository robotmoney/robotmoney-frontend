import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { viewFor } from "../../frontend/public/assets/js/app/routes.js";
import {
  createArchivedIcSessionDetailController,
  createArchivedMemberProfileController,
} from "../../frontend/public/assets/js/app/lib/committee-controllers.js";

const repoRoot = join(import.meta.dir, "../..");

function archiveClient() {
  return {
    async json(path: string) {
      return Bun.file(join(repoRoot, "frontend/public/data/committee", path)).json();
    },
    async maybeJson(path: string) {
      try {
        return await this.json(path);
      } catch {
        return null;
      }
    },
  };
}

describe("frontend route resolution", () => {
  test("resolves static routes to matching fragments", () => {
    expect(viewFor("/")).toBe("/views/home.html");
    expect(viewFor("/allocation")).toBe("/views/allocation.html");
    expect(viewFor("/research/channel-divergence")).toBe("/views/research/channel-divergence.html");
  });

  test("resolves dynamic committee routes to reusable fragments", () => {
    expect(viewFor("/committee/members/athena")).toBe("/views/committee/member.html");
    expect(viewFor("/committee/members/woon")).toBe("/views/committee/member.html");
    expect(viewFor("/committee/2026-07-01/woon")).toBe("/views/committee/session.html");
    expect(viewFor("/committee/2026-06-25/woon")).toBe("/views/committee/session.html");
  });

  test("/committee contains the hero canvas mount surface", async () => {
    const html = await Bun.file(join(repoRoot, "frontend/public/views/committee.html")).text();
    expect(viewFor("/committee")).toBe("/views/committee.html");
    expect(html).toContain('class="cv__hero-field"');
    expect(html).toContain('x-data="slimeMoldHero()"');
  });

  test("/committee/2026-06-25/woon controller resolves static archive data", async () => {
    const controller = createArchivedIcSessionDetailController({ archive: archiveClient() });
    await controller.load("2026-06-25", "woon");

    expect(controller.title).toBe("Woon");
    const portfolioRows = controller.portfolioRows as Array<{ token: string }>;
    const recommendationActions = controller.recommendationActions as Array<{ action: string }>;
    const takes = controller.takes as Array<{ memberId: string }>;
    const disagreements = controller.disagreements as Array<{ topic: string }>;

    expect(portfolioRows.map((row) => row.token)).toEqual([
      "WOON",
      "PEAQ",
      "USDC",
      "ROBOTMONEY",
      "rmUSDC",
      "ETH",
    ]);
    expect(recommendationActions.map((action) => action.action)).toContain("rotate");
    expect(takes.map((take) => take.memberId)).toEqual(["athena", "robotmoney", "woon"]);
    expect(disagreements.map((item) => item.topic)).toContain("WOON at 55.8% of book");
    expect(controller.synthesis).toContain("USDC into rmUSDC");
  });

  test("/committee/members/woon controller resolves manifest and archived takes", async () => {
    const controller = createArchivedMemberProfileController({ archive: archiveClient() });
    await controller.load("woon");

    expect(controller.name).toBe("Woon");
    expect(controller.role).toBe("machine economy participant");
    expect(controller.bio).toContain("fellow agent");
    // Woon sits on every archived session (32 in the reference archive), so the
    // controller returns its capped window of the 10 most-recent takes; the
    // newest is Woon's self-advocacy on the 2026-06-25 Woon session.
    expect(controller.takes).toHaveLength(10);
    expect(controller.takes[0]).toMatchObject({
      date: "2026-06-25",
      subjectId: "woon",
      stance: "constructive",
    });
  });
});
