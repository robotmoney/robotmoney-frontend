import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { viewFor } from "../../frontend/public/assets/js/app/routes.js";
// These are the PRODUCTION archive loaders: the same functions the browser
// runs for pre-2026-07-01 committee sessions (static-views.js is a plain ES
// module, so Bun executes the real code path — not a test double). The old
// lib/committee-controllers.js + lib/committee-archive.js pair this test used
// to import was a dead duplicate normalizer never loaded by main.js's import
// graph (review-maintainability-026) and has been deleted.
import {
  loadArchiveMember,
  loadArchiveSession,
  loadArchiveSnapshot,
} from "../../frontend/public/assets/js/app/alpine/static-views.js";

const repoRoot = join(import.meta.dir, "../..");

// static-views.js reaches the archive through global fetch with root-relative
// URLs ("/data/committee/..."). Serve those straight from the shipped static
// files so the loaders execute against exactly what production serves, and
// record every requested URL so we can assert URL construction too.
const requestedUrls: string[] = [];
const realFetch = globalThis.fetch;

beforeAll(() => {
  globalThis.fetch = (async (url: string | URL) => {
    const path = String(url);
    requestedUrls.push(path);
    const file = Bun.file(join(repoRoot, "frontend/public", `.${path}`));
    if (!(await file.exists())) return new Response("not found", { status: 404 });
    return new Response(await file.text(), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

describe("frontend route resolution", () => {
  test("resolves static routes to matching fragments", () => {
    expect(viewFor("/")).toBe("/views/home.html");
    expect(viewFor("/allocation")).toBe("/views/allocation.html");
    expect(viewFor("/research/channel-divergence")).toBe("/views/research/channel-divergence.html");
  });

  test("resolves every /admin subpath to the one buildless admin shell fragment", () => {
    // The admin shell (adminSurfaceView) reads location.pathname itself to pick
    // a section — /admin/research, /admin/research/runs/:id, and /admin/queue
    // must NOT fall through to the generic catch-all, which would request a
    // nonexistent per-path view fragment and 404 (issue #157 AC1).
    expect(viewFor("/admin")).toBe("/views/admin.html");
    expect(viewFor("/admin/research")).toBe("/views/admin.html");
    expect(viewFor("/admin/research/runs/abc-123")).toBe("/views/admin.html");
    expect(viewFor("/admin/queue")).toBe("/views/admin.html");
    // Other supported admin paths (committee/audit sections are out of #157's
    // scope but still route to the shell) resolve the same way.
    expect(viewFor("/admin/committee")).toBe("/views/admin.html");
    expect(viewFor("/admin/audit")).toBe("/views/admin.html");
    expect(viewFor("/admin/")).toBe("/views/admin.html");
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

  test("production loader resolves an archived session with camelCase normalization", async () => {
    const detail = await loadArchiveSession("2026-06-25", "woon");

    expect(detail.source).toBe("archive");
    // camelSession returns null for a nullish payload; assert-and-narrow so the
    // remaining assertions typecheck against the non-null session shape.
    if (!detail.session) throw new Error("archive session normalized to null");
    // The archive JSON is snake_case throughout (subject_id, regime_summary,
    // macro_percentile, ...) — the loader must serve the camelCase shape the
    // session view binds to. subjectId (not subject_id) is the exact drift
    // that caused the earlier archive render bug.
    expect(detail.session.subjectId).toBe("woon");
    expect(detail.session.subjectName).toBe("Woon");
    expect(detail.session.regimeSummary?.macroPercentile).toBeGreaterThan(0);
    expect(detail.session.synthesis).toContain("USDC into rmUSDC");

    const takes = detail.takes as Array<{ memberId: string; stance: string }>;
    expect(takes.map((take) => take.memberId)).toEqual(["athena", "robotmoney", "woon"]);
    expect(takes.find((take) => take.memberId === "woon")?.stance).toBe("constructive");

    const rec = detail.session.committeeRecommendation as {
      actions: Array<{ action: string }>;
      disagreements: Array<{ topic: string }>;
    };
    expect(rec.actions.map((action) => action.action)).toContain("rotate");
    expect(rec.disagreements.map((item) => item.topic)).toContain("WOON at 55.8% of book");

    // URL-construction invariant: the loader validated against the sessions
    // index, then fetched the per-session archive file at its canonical path.
    expect(requestedUrls).toContain("/data/committee/sessions/index.json");
    expect(requestedUrls).toContain("/data/committee/sessions/2026-06-25-woon.json");
  });

  test("production loader rejects sessions absent from the archive index", async () => {
    // The index gate (not a blind fetch) is what turns a bad date/subject into
    // a clean "missing" error the session view can render.
    expect(loadArchiveSession("2026-06-25", "nope")).rejects.toThrow(
      "archive session missing: 2026-06-25/nope",
    );
  });

  test("production loader resolves the archived member manifest", async () => {
    const member = await loadArchiveMember("woon");

    expect(member?.name).toBe("Woon");
    expect(member?.lens).toBe("machine economy participant");
    expect(member?.mandate).toContain("fellow agent");
    expect(requestedUrls).toContain("/data/committee/manifests/members/woon.json");
  });

  test("production loader resolves the archived portfolio snapshot", async () => {
    const snapshot = await loadArchiveSnapshot("woon", "2026-06-25");

    // positionRows() in the session view renders these positions verbatim —
    // the token order below is the reference portfolio for the last archived
    // Woon session.
    expect((snapshot?.positions as Array<{ token: string }>).map((p) => p.token)).toEqual([
      "WOON",
      "PEAQ",
      "USDC",
      "ROBOTMONEY",
      "rmUSDC",
      "ETH",
    ]);
    expect(snapshot?.totalValueUsd).toBeCloseTo(44167.4);

    // Missing snapshots degrade to null (the view hides the portfolio panel)
    // rather than failing the whole session render.
    expect(await loadArchiveSnapshot("woon", "1999-01-01")).toBeNull();
  });
});
